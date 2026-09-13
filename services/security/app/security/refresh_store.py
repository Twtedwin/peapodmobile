"""
MODULE: app.security.refresh_store

PURPOSE
    The PostgreSQL implementation of `app.security.tokens.RefreshTokenStore`.
    All SQL that touches `refresh_tokens` lives here, so the rotation algorithm
    in `tokens.py` stays database-free and unit testable.

INPUTS  : an `AsyncSession` (request-scoped, from `app/db.py`)
OUTPUTS : `models.RefreshToken` rows

CALLED BY
    `app/routes/auth.py` and `app/routes/oauth.py`, which construct one store
    per request and hand it to `tokens.issue_refresh_token` /
    `tokens.rotate_refresh_token`.

TRANSACTIONS
    Nothing here commits. The route handler owns the transaction boundary, so
    that "issue the new token" and "mark the old one replaced" are atomic: a
    crash between the two must not leave a client holding a token whose
    predecessor is still live.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import RefreshToken


class SqlRefreshTokenStore:
    """`RefreshTokenStore` backed by the shared PostgreSQL database.

    Structurally satisfies the Protocol in `app.security.tokens`; there is no
    explicit inheritance, which keeps `models.py` and `tokens.py` decoupled.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def find_by_hash(self, token_hash: str) -> RefreshToken | None:
        """Load the token row for a hash, locking it for this transaction.

        Parameters
        ----------
        token_hash:
            Hex SHA-256 of the presented token.

        Returns
        -------
        The row, or None when no token with that hash was ever issued.

        Why `with_for_update`
        ---------------------
        Rotation is read-then-write: classify the row, then stamp it as
        replaced. Without a lock, two concurrent refreshes presenting the SAME
        token can both read it as ACTIVE and both issue a successor, leaving
        two live tokens in one family and silently defeating reuse detection.
        `SELECT ... FOR UPDATE` makes the second transaction wait; when it
        proceeds it sees `replaced_by` set and correctly reports reuse.

        The lock is held only for the few milliseconds until the route commits,
        and it is taken on a single row found by a unique index, so contention
        is limited to genuinely concurrent refreshes of the same token.
        """
        statement = select(RefreshToken).where(RefreshToken.token_hash == token_hash).with_for_update()
        return (await self._session.execute(statement)).scalar_one_or_none()

    async def insert(
        self,
        *,
        token_hash: str,
        user_id: uuid.UUID,
        family_id: uuid.UUID,
        expires_at: datetime,
        ip: str | None,
        user_agent: str | None,
    ) -> RefreshToken:
        """Persist a new refresh token row.

        `flush` (not `commit`) is called so the generated primary key is
        available immediately -- `rotate_refresh_token` needs the new row's id
        to write into the old row's `replaced_by` -- while leaving the
        transaction open for the route to commit or roll back as a unit.
        """
        record = RefreshToken(
            token_hash=token_hash,
            user_id=user_id,
            family_id=family_id,
            expires_at=expires_at,
            created_ip=ip,
            # Truncate defensively: `User-Agent` is an unbounded attacker
            # controlled header, and the column is 512 characters.
            created_user_agent=user_agent[:512] if user_agent else None,
        )
        self._session.add(record)
        await self._session.flush()
        return record

    async def mark_replaced(
        self, record_id: uuid.UUID, replacement_id: uuid.UUID, now: datetime
    ) -> None:
        """Stamp the rotated-away token with its successor and a revocation time.

        Both columns are set together: `replaced_by` is what makes the next
        presentation classify as REUSED (theft), and `revoked_at` is what makes
        every other code path treat it as dead.
        """
        await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.id == record_id)
            .values(replaced_by=replacement_id, revoked_at=now)
        )

    async def revoke_family(self, family_id: uuid.UUID, now: datetime) -> int:
        """Revoke every still-live token descended from one login.

        Parameters
        ----------
        family_id:
            The family to kill.
        now:
            Revocation timestamp.

        Returns
        -------
        How many rows were revoked (0 if the family was already dead), for the
        audit log entry.

        This is the response to reuse detection. One UPDATE, no chain walking --
        which is exactly why `family_id` exists as a column.
        """
        result = await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        return int(result.rowcount or 0)

    async def revoke_by_hash(self, token_hash: str, now: datetime) -> bool:
        """Revoke exactly one token. Used by `POST /auth/logout`.

        Returns
        -------
        True if a live token was revoked, False if the hash was unknown or the
        token was already dead. The route ignores this and returns 204 either
        way -- a logout must never tell the caller whether the token was real.
        """
        result = await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == token_hash, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        return bool(result.rowcount)

    async def revoke_all_for_user(self, user_id: uuid.UUID, now: datetime) -> int:
        """Revoke every live session for a user. Returns how many.

        Called after a password reset and on account deletion. A password
        change MUST invalidate existing sessions: the usual reason a user
        resets a password is that they believe someone else has it, and leaving
        the attacker's 30-day refresh token alive would make the reset
        pointless.
        """
        result = await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        return int(result.rowcount or 0)
