"""
MODULE: app.models

PURPOSE
    SQLAlchemy 2.0 declarative models for every table the security service
    owns, plus one deliberately non-migrated mapping onto the API's `users`
    profile table.

INPUTS  : none at import time (declarations only, no I/O)
OUTPUTS : `Base`, the ORM classes, and `OWNED_TABLES` (the exact set of tables
          this service may create or migrate)

CALLED BY
    `app/db.py`, `app/routes/*`, `app/authz.py`, `app/audit.py`, and
    `alembic/env.py` (as the autogenerate target metadata).

=============================================================================
TABLE OWNERSHIP -- THE MOST IMPORTANT COMMENT IN THIS FILE
=============================================================================
One PostgreSQL database is shared by `services/api` and `services/security`.
Ownership is split, and it is split for a reason: the Node API must never be
able to read a password hash, and this service must never be the thing that
decides what a `pods` row looks like.

    OWNED BY THIS SERVICE (create/alter/migrate freely from `alembic/`):
        auth_credentials
        refresh_tokens
        otp_codes
        password_reset_tokens
        oauth_identities
        audit_log

    OWNED BY services/api/src/db/schema.ts (Drizzle) -- NEVER MIGRATED HERE:
        users            <- mapped below as `UserProfile`
        pods, pod_memberships, pod_invites, and every domain table
                         <- reflected ad hoc in app/authz.py

`OWNED_TABLES` at the bottom of this file is the allow-list that `app/db.py`
and `alembic/env.py` both consult. If you add a table, add it there too;
if you map an API-owned table, do NOT.

Why map an API-owned table at all? Two reasons, both narrow:
  1. Registration has to create the profile row in the same transaction that
     creates the credential row, otherwise a crash between the two leaves an
     account that can log in but has no profile (or a profile nobody can log
     into).
  2. `/auth/me` and `/internal/users/*` return `display_name`, `avatar_url`,
     `permissions_granted`, and `role`, which live there.
The mapping mirrors the Drizzle definition; if the API changes that table, this
mapping must be updated by hand, and `packages/shared/schemas/core.schema.json`
is the contract both sides are supposed to agree with.
"""

from __future__ import annotations

import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum as SqlEnum,
    ForeignKey,
    Index,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def utcnow() -> datetime:
    """Return the current time as a timezone-AWARE UTC datetime.

    Returns
    -------
    `datetime` with `tzinfo=UTC`.

    Why not `datetime.utcnow()`
    ---------------------------
    `datetime.utcnow()` returns a *naive* datetime, and comparing a naive
    datetime with an aware one raises `TypeError`. Worse, when a naive value is
    written to a `timestamptz` column PostgreSQL interprets it in the session
    time zone, which silently shifts every expiry check by the server's UTC
    offset -- a token that should live 15 minutes could live 8 hours and 15
    minutes. Every timestamp in this service is aware and in UTC, no
    exceptions. (`datetime.utcnow()` is also deprecated as of Python 3.12.)
    """
    return datetime.now(UTC)


class Base(DeclarativeBase):
    """Declarative base for this service's metadata.

    `Base.metadata` intentionally contains BOTH owned and API-owned tables
    (the latter so the ORM can query them). Filter with `OWNED_TABLES` before
    handing metadata to anything that creates or alters schema.
    """


# A timezone-aware timestamp column type, spelled once so no table can
# accidentally use a naive `timestamp without time zone`.
TimestampTz = DateTime(timezone=True)


class OtpPurpose(enum.StrEnum):
    """What an emailed one-time code is allowed to do.

    Purpose is stored on the row and checked on verification so that a code
    issued for one flow cannot be replayed into another. Without it, an
    attacker who can trigger a "resend registration code" to a victim's inbox
    (or who finds an old code) could feed it to the password-reset flow.
    """

    REGISTER = "register"
    LOGIN = "login"
    RESET = "reset"


# `native_enum=True` creates a real PostgreSQL ENUM type, so the database
# itself rejects a bad purpose value. `values_callable` makes the stored labels
# the lowercase *values* above ('register') rather than SQLAlchemy's default of
# the member *names* ('REGISTER'), keeping the column readable and matching the
# contract in the brief.
OtpPurposeType = SqlEnum(
    OtpPurpose,
    name="otp_purpose",
    native_enum=True,
    values_callable=lambda enum_cls: [member.value for member in enum_cls],
)


# ---------------------------------------------------------------------------
# auth_credentials
# ---------------------------------------------------------------------------


class AuthCredential(Base):
    """The login secret for one account. OWNED BY THIS SERVICE.

    One row per account. `user_id` points at `users.id` but is NOT declared as
    a foreign key: adding an FK from a table this service migrates to a table
    the API migrates would couple the two migration histories and make either
    service's `alembic`/`drizzle` run order load-bearing. The invariant is
    enforced in application code instead (registration writes both rows in one
    transaction).
    """

    __tablename__ = "auth_credentials"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # The account this credential belongs to. Unique: exactly one credential
    # row per user, so there is never ambiguity about which password is current.
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), unique=True, nullable=False)

    # Stored lowercase and stripped (see `normalise_email`). A unique index on
    # the normalised form is what stops two accounts existing for
    # "Sam@example.com" and "sam@example.com" -- which would let an attacker
    # register a look-alike of someone else's address.
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)

    # NULL for OAuth-only accounts (signed up with Google, never set a
    # password). A NULL hash must always mean "password login is impossible for
    # this account", never "any password works" -- see
    # `app/security/passwords.py::verify_password`.
    password_hash: Mapped[str | None] = mapped_column(Text, nullable=True)

    # False until an emailed OTP is verified. Gates login, so a registration
    # with somebody else's address cannot be used to sit on that address.
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Consecutive failed password attempts. Reset to 0 on any success.
    failed_attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Set when `failed_attempt_count` crosses the lockout threshold. While this
    # is in the future, password verification is refused outright. This is the
    # per-ACCOUNT defence; the per-IP defence is `app/security/ratelimit.py`.
    # Both are needed: rate limiting alone lets a distributed botnet grind one
    # account, and lockout alone lets one IP spray many accounts.
    locked_until: Mapped[datetime | None] = mapped_column(TimestampTz, nullable=True)

    created_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        TimestampTz, nullable=False, default=utcnow, onupdate=utcnow
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        # Deliberately omits `password_hash`. A hash in a log or an exception
        # trace is an offline cracking target.
        return f"<AuthCredential user_id={self.user_id} verified={self.email_verified}>"


# ---------------------------------------------------------------------------
# refresh_tokens
# ---------------------------------------------------------------------------


class RefreshToken(Base):
    """One issued refresh token. OWNED BY THIS SERVICE.

    Rows are append-only in spirit: a token is never edited except to stamp
    `revoked_at`/`replaced_by`, which preserves the chain needed for reuse
    detection. See `app/security/tokens.py` for the rotation algorithm and the
    threat model.
    """

    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # SHA-256 of the opaque token, hex encoded (64 chars). The plaintext token
    # exists only in the response body that went to the client and in the
    # client's secure storage; a database dump therefore yields nothing an
    # attacker can present. Unique so a hash collision or a double-insert is a
    # database error rather than two live tokens.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)

    # All tokens descended from one login share a family id. Reuse of any
    # already-rotated token revokes the entire family in a single UPDATE, which
    # is what makes theft detection cheap. Without a family id you would have
    # to walk the `replaced_by` chain in both directions.
    family_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)

    issued_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False, default=utcnow)

    # Absolute expiry. A refresh token is NOT extended by use; rotation issues
    # a new token that inherits the family's original deadline, so a session
    # cannot live forever by being used forever.
    expires_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False)

    # Non-NULL means this token can never be used again (rotated away, logged
    # out, or revoked as part of a compromised family).
    revoked_at: Mapped[datetime | None] = mapped_column(TimestampTz, nullable=True)

    # The token that superseded this one. Self-referential FK: safe, because
    # both sides live in a table this service owns.
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("refresh_tokens.id", ondelete="SET NULL"), nullable=True
    )

    # Forensics only, never used for an authorization decision -- both values
    # are attacker-controlled (an IP can be spoofed behind a bad proxy config,
    # a User-Agent is a free-text header). Binding a session to them would
    # break legitimate users who change networks mid-commute.
    created_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)

    __table_args__ = (
        # Supports the "revoke everything still live for this user" query used
        # by password reset, logout-everywhere, and account deletion.
        Index("ix_refresh_tokens_user_active", "user_id", "revoked_at"),
    )


# ---------------------------------------------------------------------------
# otp_codes
# ---------------------------------------------------------------------------


class OtpCode(Base):
    """An emailed 6-digit one-time code. OWNED BY THIS SERVICE."""

    __tablename__ = "otp_codes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)

    # Currently stores the six digits in plaintext when OTP_STORE_PLAINTEXT is
    # on (dev/debug). The column is TEXT, so Argon2 hashes and 6-digit codes
    # both fit -- no migration. Revert hashing in app/security/otp.py.
    code_hash: Mapped[str] = mapped_column(Text, nullable=False)

    purpose: Mapped[OtpPurpose] = mapped_column(OtpPurposeType, nullable=False)

    expires_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False)

    # Non-NULL means single-use has been spent. Checked and stamped in the same
    # transaction as verification so two concurrent requests cannot both spend
    # the same code.
    consumed_at: Mapped[datetime | None] = mapped_column(TimestampTz, nullable=True)

    # Wrong guesses against THIS code. Once it hits the maximum the code is
    # dead even if the correct digits arrive later. Bounds an online guessing
    # attack to (attempts / 10^6) probability of success per issued code.
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False, default=utcnow)

    __table_args__ = (
        # The verification path always looks up "newest live code for this
        # user and purpose".
        Index("ix_otp_codes_user_purpose", "user_id", "purpose", "consumed_at"),
    )


# ---------------------------------------------------------------------------
# password_reset_tokens
# ---------------------------------------------------------------------------


class PasswordResetToken(Base):
    """A single-use password-reset capability. OWNED BY THIS SERVICE.

    Unlike an OTP this is a long random string emailed as a link, so SHA-256 is
    an appropriate hash: 256 bits of entropy cannot be brute-forced from the
    hash, and we need a fast exact-match lookup by hash (there is no user id in
    the request -- the token IS the identity claim).
    """

    __tablename__ = "password_reset_tokens"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)

    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)

    expires_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(TimestampTz, nullable=True)

    created_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False, default=utcnow)
    requested_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)


# ---------------------------------------------------------------------------
# oauth_identities
# ---------------------------------------------------------------------------


class OAuthIdentity(Base):
    """A link between an external identity provider subject and a Peapod user.

    OWNED BY THIS SERVICE.
    """

    __tablename__ = "oauth_identities"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # 'google' today. Kept as a string rather than an enum so adding Apple
    # sign-in does not require a migration of a PostgreSQL ENUM type.
    provider: Mapped[str] = mapped_column(String(32), nullable=False)

    # The provider's immutable user identifier: Google's `sub` claim. NEVER key
    # an identity on the email address from the provider -- emails get
    # reassigned inside Google Workspace domains, and matching on email is how
    # you hand somebody else's account to a new hire with a recycled address.
    provider_subject: Mapped[str] = mapped_column(String(255), nullable=False)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)

    # Snapshot of the email the provider asserted at link time. Informational
    # only (support/debugging); authorization never reads it.
    provider_email: Mapped[str | None] = mapped_column(String(320), nullable=True)

    created_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(TimestampTz, nullable=True)

    __table_args__ = (
        # One provider subject maps to at most one Peapod account.
        UniqueConstraint("provider", "provider_subject", name="uq_oauth_provider_subject"),
    )


# ---------------------------------------------------------------------------
# audit_log
# ---------------------------------------------------------------------------


class AuditLog(Base):
    """Append-only record of security-relevant events. OWNED BY THIS SERVICE.

    See `app/audit.py` for the writer, the list of logged actions, and the
    redaction rules that keep secrets out of `metadata`.
    """

    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # NULL for events where no principal is known yet: a login attempt against
    # an address that does not exist, or a reset request for an unknown email.
    # Those still get logged -- the *absence* of a user id is itself the signal
    # that someone is enumerating addresses.
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), nullable=True, index=True
    )

    # A stable dotted verb from `app.audit.AuditAction`, e.g. `login.failure`.
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # What the action was about: `pod:<uuid>`, `message:<uuid>`, or an email
    # address for pre-authentication events. Free-form on purpose.
    resource: Mapped[str | None] = mapped_column(String(255), nullable=True)

    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # NOTE: the Python attribute is `event_metadata`, the COLUMN is `metadata`.
    # `metadata` is reserved on a declarative class -- it is the
    # `MetaData` object hanging off `Base` -- so mapping an attribute with that
    # name raises `InvalidRequestError` at import time. The first positional
    # argument to `mapped_column` overrides the column name.
    event_metadata: Mapped[dict[str, object] | None] = mapped_column(
        "metadata", JSONB, nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        TimestampTz, nullable=False, default=utcnow, index=True
    )


# ---------------------------------------------------------------------------
# users -- MAPPED, NOT OWNED
# ---------------------------------------------------------------------------

USERS_TABLE_NAME = "users"


class UserProfile(Base):
    """Mapping onto the API's `users` profile table.

    !!!  SCHEMA-READ-ONLY  !!!
    The definitive definition of this table is the Drizzle schema at
    `services/api/src/db/schema.ts`, cross-checked against the `User`
    definition in `packages/shared/schemas/core.schema.json`. This class is a
    hand-maintained mirror so that the security service can:
        * INSERT the profile row during registration (same transaction as the
          credential row), and
        * SELECT / UPDATE the four profile fields the auth screens touch
          (`display_name`, `avatar_url`, `permissions_granted`, `role`).

    Rules for this class:
        * It MUST NOT appear in `OWNED_TABLES`.
        * `alembic` MUST NOT emit DDL for it -- `alembic/env.py` filters it out
          in `include_object`, and `app/db.py::create_owned_tables` skips it.
        * Adding a column here does not create it; the API's migration must run
          first. If the two drift, this mirror is the side that is wrong.

    Note that `role` here is the PLATFORM role ('admin' | 'user'), which is
    what `app/authz.py::is_platform_admin` reads. It is NOT the per-pod role
    ('admin' | 'member') stored on `pod_memberships`; conflating the two would
    silently promote every pod Seed to a Peapod operator.
    """

    __tablename__ = USERS_TABLE_NAME
    __table_args__ = ({"info": {"owner": "services/api", "migrate_here": False}},)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    permissions_granted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="user")

    # The four audit columns every Peapod record carries. `created_by_id` is
    # the owner used by the ownership branch of every row-level rule; for a
    # `users` row it is the user's own id (an account creates itself).
    created_at: Mapped[datetime] = mapped_column(TimestampTz, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        TimestampTz, nullable=False, default=utcnow, onupdate=utcnow
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)


# ---------------------------------------------------------------------------
# Ownership allow-list
# ---------------------------------------------------------------------------

#: The ONLY tables this service may create, alter, or drop. Consulted by
#: `app/db.py::create_owned_tables` and by `alembic/env.py`'s `include_object`
#: hook. `users` is absent on purpose -- see `UserProfile`.
OWNED_TABLES: tuple[Table, ...] = (
    AuthCredential.__table__,
    RefreshToken.__table__,
    OtpCode.__table__,
    PasswordResetToken.__table__,
    OAuthIdentity.__table__,
    AuditLog.__table__,
)

#: Same list as plain names, for the alembic filter and for log messages.
OWNED_TABLE_NAMES: frozenset[str] = frozenset(table.name for table in OWNED_TABLES)


def normalise_email(raw: str) -> str:
    """Canonicalise an email address for storage and lookup.

    Parameters
    ----------
    raw:
        Whatever the client sent.

    Returns
    -------
    The address trimmed of surrounding whitespace and lowercased.

    Why
    ---
    Email local-parts are technically case-sensitive, but no mail provider a
    Peapod user will have actually treats them that way. If we stored the raw
    casing, `Sam@example.com` and `sam@example.com` would be two accounts, and
    an attacker could register a visually identical address to a victim's --
    then receive pod invites meant for them. Normalising on the way in makes
    the unique index on `auth_credentials.email` mean what people expect.

    Edge cases
    ----------
    Does not strip Gmail-style `+tags` or dots: those are provider-specific
    aliasing rules, and applying them would wrongly merge distinct addresses at
    providers that treat them as distinct.
    """
    return raw.strip().lower()
