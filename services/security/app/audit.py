"""
MODULE: app.audit

PURPOSE
    Append one row to `audit_log` for every security-relevant event. The log
    is how we answer "who did what, from where, when" after an incident.

INPUTS  : actor, action, resource, request breadcrumbs, optional extra JSON
OUTPUTS : none to the caller -- writes are best-effort

CALLED BY
    Every route in `app/routes/*` and `app/authz.py` (denials).

=============================================================================
FAILURE POLICY
=============================================================================
An audit insert MUST NEVER fail the surrounding request. A full disk, a
permissions mistake on `audit_log`, or a JSONB serialisation bug would
otherwise turn "log that the login failed" into "the user cannot log in",
which is an availability incident caused by the observability path.

We catch, roll back only the failed INSERT (the caller's transaction is
separate -- we use a nested try and a savepoint), and `logger.error` the
exception *without* echoing `extra` (it might have been populated carelessly).

=============================================================================
WHAT NEVER GOES IN `extra`
=============================================================================
Passwords, password hashes, OTPs, refresh tokens, reset tokens, the internal
service token, Google client secrets, raw JWTs. If you need to identify a
token, store its `jti` or its SHA-256 hash -- never the plaintext.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog

logger = logging.getLogger(__name__)

# User-Agent / IP columns are bounded; extra defence so a 10 KB header cannot
# bloat an audit row even if a caller forgets to truncate.
_MAX_IP_CHARS = 64
_MAX_USER_AGENT_CHARS = 512
_MAX_RESOURCE_CHARS = 255
_MAX_ACTION_CHARS = 64


class AuditAction:
    """Stable dotted verbs stored in `audit_log.action`.

    Adding a member is a contract change for anyone grepping logs; do not
    rename existing values.
    """

    LOGIN_SUCCESS = "login.success"
    LOGIN_FAILURE = "login.failure"
    LOGIN_LOCKOUT = "login.lockout"
    LOGIN_UNVERIFIED = "login.unverified"
    REGISTER = "register"
    OTP_ISSUE = "otp.issue"
    OTP_VERIFY_SUCCESS = "otp.verify.success"
    OTP_VERIFY_FAILURE = "otp.verify.failure"
    PASSWORD_RESET_REQUEST = "password_reset.request"
    PASSWORD_RESET_COMPLETE = "password_reset.complete"
    TOKEN_REFRESH = "token.refresh"
    REFRESH_REUSE = "refresh.reuse_detected"
    LOGOUT = "logout"
    OAUTH_LINK = "oauth.link"
    OAUTH_LOGIN = "oauth.login"
    OAUTH_FAILURE = "oauth.failure"
    PROFILE_UPDATE = "profile.update"
    PERMISSIONS_GRANT = "permissions.grant"
    ACCOUNT_DELETE = "account.delete"
    AUTHZ_ALLOW = "authz.allow"
    AUTHZ_DENY = "authz.deny"
    TOKEN_VERIFY = "token.verify"


def _truncate(value: str | None, limit: int) -> str | None:
    """Return `value` cut to `limit` characters, or None."""
    if value is None:
        return None
    return value[:limit]


async def append_audit(
    session: AsyncSession,
    *,
    actor_id: uuid.UUID | None,
    action: str,
    resource: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Insert one `audit_log` row. Never raises to the caller.

    Parameters
    ----------
    session:
        The request-scoped session. We flush (not commit) so the row lands in
        the same transaction as the event it describes -- a rolled-back login
        must not leave a "success" audit row. The route still owns commit.
    actor_id:
        `users.id` of the principal, or None when no principal is known
        (failed login against an unknown address, reset request for a
        stranger). Mapped to column `actor_user_id`.
    action:
        A dotted verb from `AuditAction`.
    resource:
        What the action was about: `user:<uuid>`, `pod:<uuid>`, or a
        normalised email for pre-auth events. Free-form, truncated to the
        column width.
    ip, user_agent:
        Request breadcrumbs. Attacker-controlled; stored for forensics only,
        never used to allow or deny anything.
    extra:
        JSON object stored in the `metadata` column (the ORM attribute is
        `event_metadata` because `metadata` is reserved on a declarative
        class). Must not contain secrets -- see the module docstring.

    Returns
    -------
    None. Failures are logged and swallowed.

    Edge cases
    ----------
    * Nested transaction (`begin_nested`): if the INSERT fails, only the
      savepoint is rolled back, so the caller's in-flight credential change
      is preserved.
    * If even opening a savepoint fails (session already aborted), we log
      and return -- the caller is about to see that error anyway.
    """
    row = AuditLog(
        actor_user_id=actor_id,
        action=_truncate(action, _MAX_ACTION_CHARS) or "unknown",
        resource=_truncate(resource, _MAX_RESOURCE_CHARS),
        ip=_truncate(ip, _MAX_IP_CHARS),
        user_agent=_truncate(user_agent, _MAX_USER_AGENT_CHARS),
        event_metadata=extra,
    )
    try:
        async with session.begin_nested():
            session.add(row)
            await session.flush()
    except Exception:
        logger.exception(
            "audit insert failed for action=%s actor_id=%s (secrets not logged)",
            action,
            actor_id,
        )
