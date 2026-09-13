"""
MODULE: app.security.tokens

PURPOSE
    Issue and verify the two credentials a signed-in Peapod client holds:

      1. a short-lived, signed, STATELESS JWT access token, and
      2. a long-lived, opaque, STATEFUL, single-use refresh token that rotates
         on every use and detects theft by reuse.

INPUTS  : user identity (id / email / platform role), and presented tokens
OUTPUTS : encoded tokens, decoded claims, and rotation outcomes

CALLED BY
    * `app/routes/auth.py`   -- login, verify-otp, refresh, logout, reset.
    * `app/routes/oauth.py`  -- issuing tokens after a Google sign-in.
    * `app/routes/internal.py` -- `POST /internal/verify-token`, which is how
      `services/api` turns an `Authorization: Bearer ...` header into a
      principal. The Node API holds no signing key and cannot mint tokens.

=============================================================================
WHY TWO DIFFERENT KINDS OF TOKEN
=============================================================================
These two credentials exist to resolve one tension: checking a database on
every single API request is slow, but never checking a database means you can
never revoke anything.

    ACCESS TOKEN (JWT, 15 minutes, stateless)
        Signed, self-describing, verified with a public key and no database
        round trip -- that is the entire performance argument. The cost is that
        it CANNOT BE REVOKED: once minted it is valid until `exp`, full stop.
        We accept that specifically because it is short-lived. If you find
        yourself wanting to revoke an access token, the answer is to shorten
        `ACCESS_TOKEN_TTL_SECONDS`, not to add a database lookup (which would
        throw away the reason for using a JWT at all).

    REFRESH TOKEN (opaque random string, 30 days, stateful)
        Carries no information -- it is 256 bits of randomness. All meaning
        lives in a database row, which means it can be revoked instantly, and
        it can be OBSERVED: we know when it was used, and we know if it was
        used twice.

=============================================================================
WHY REFRESH TOKENS ARE HASHED AND WHY SHA-256 IS THE RIGHT HASH HERE
=============================================================================
`refresh_tokens.token_hash` stores SHA-256 of the token, never the token. A
database dump therefore contains nothing presentable.

SHA-256 -- not Argon2 -- is correct for this one, and the reasoning is worth
internalising because it is the opposite of the password decision:

    * A password is low entropy and human-chosen, so an attacker holding the
      hash can guess it. The hash must be slow.
    * A refresh token is 256 bits from a CSPRNG. There is no dictionary to
      guess from; brute-forcing it is not a slow attack, it is an impossible
      one. Slowing the hash protects against nothing.
    * And we need to LOOK IT UP by hash on every refresh (the request contains
      no user id -- the token is the only identifier), which requires a
      deterministic, unsalted, indexable hash. A salted Argon2 hash cannot be
      indexed: you would have to load every row and verify each one.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable

import jwt

from app.config import get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Bytes of entropy in a refresh token. `secrets.token_urlsafe(32)` produces 32
# random bytes (256 bits) rendered as ~43 URL-safe characters.
#
# THREAT: online guessing of a refresh token. At 256 bits, an attacker making
# a billion guesses per second for the age of the universe has a negligible
# chance. 16 bytes (128 bits) would also be fine in practice; 32 costs nothing
# extra and removes the need to ever think about it again.
REFRESH_TOKEN_BYTES = 32

# Same reasoning for password-reset tokens, which are handed out in an emailed
# URL. They live in `password_reset_tokens.token_hash`.
RESET_TOKEN_BYTES = 32

# Clock skew allowance, in SECONDS, when validating `exp`/`iat`.
#
# Only this service signs and verifies these tokens, but it may run as several
# replicas whose clocks are a second or two apart after an NTP step. Without
# leeway, a token minted by replica A can look "issued in the future" or
# "already expired" to replica B for a couple of seconds. 10 s is small enough
# to be irrelevant to an attacker (it extends a 900 s token by ~1%) and large
# enough to cover realistic skew.
JWT_LEEWAY_SECONDS = 10

# The `typ` claim. Access and refresh credentials are structurally different
# here (JWT vs opaque string), so confusion is already unlikely -- but if a
# future change ever makes refresh tokens JWTs too, this claim is what stops a
# 30-day refresh token being accepted as an access token. Cheap insurance.
ACCESS_TOKEN_TYPE = "access"

# Claims that MUST be present for a token to be considered well-formed. Passed
# to PyJWT's `require` option so a token missing, say, `exp` is rejected rather
# than treated as non-expiring.
REQUIRED_CLAIMS = ("sub", "exp", "iat", "iss", "aud", "jti")


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TokenError(Exception):
    """Base class for every token failure.

    Route handlers translate any `TokenError` into a single generic 401. The
    subclasses exist for the audit log and for tests, NOT to be reported to the
    client: telling a caller "the signature was valid but it expired" versus
    "the signature was forged" hands an attacker a free oracle.
    """


class TokenExpiredError(TokenError):
    """The token was well-formed and correctly signed, but `exp` has passed."""


class TokenInvalidError(TokenError):
    """Malformed, wrongly signed, wrong issuer/audience, or missing a claim."""


class RefreshTokenReuseError(TokenError):
    """A refresh token that had already been rotated away was presented again.

    This is treated as evidence of THEFT, not as a client bug. See
    `rotate_refresh_token` for the full reasoning. Carries the identifiers the
    caller needs for the audit log entry.
    """

    def __init__(self, user_id: uuid.UUID, family_id: uuid.UUID, revoked_count: int) -> None:
        super().__init__("refresh token reuse detected; token family revoked")
        self.user_id = user_id
        self.family_id = family_id
        self.revoked_count = revoked_count


# ---------------------------------------------------------------------------
# Access tokens (JWT)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AccessTokenClaims:
    """The verified contents of an access token.

    Every field here was cryptographically signed by this service, so callers
    may trust it without a database read. That is precisely why the set is kept
    minimal and slow-changing:

    `role` is a snapshot taken at issue time. If an operator demotes a platform
    admin, that user keeps `role: "admin"` in their access token until it
    expires (at most `ACCESS_TOKEN_TTL_SECONDS`). Accepted deliberately: the
    alternative is a database lookup per request, which defeats the purpose of
    a JWT. For anything where a stale role would be unacceptable, the API
    should call `/internal/authorize`, which reads live data.

    Notably ABSENT: pod memberships. They change often and are per-resource, so
    they are resolved live in `app/authz.py` instead of being frozen into a
    token.
    """

    sub: uuid.UUID
    """`sub` -- the subject, i.e. `users.id`. The authenticated user."""

    email: str
    """Normalised email. Convenience for the API's logging; never authoritative."""

    role: str
    """Platform role: 'admin' or 'user'. NOT the per-pod role."""

    jti: str
    """Unique token id. Written to the audit log so a specific token can be
    traced through logs after an incident."""

    issued_at: datetime
    """`iat`, timezone-aware UTC."""

    expires_at: datetime
    """`exp`, timezone-aware UTC."""

    issuer: str
    """`iss`. Verified, so a token from another environment is rejected."""

    audience: str
    """`aud`. Verified, so a token minted for a different consumer is rejected."""

    def to_principal_dict(self) -> dict[str, Any]:
        """Serialise for the `/internal/verify-token` response body.

        Returns
        -------
        A JSON-safe dict. UUIDs become strings and datetimes become ISO-8601,
        because the Node API consumes this over HTTP.
        """
        return {
            "user_id": str(self.sub),
            "email": self.email,
            "role": self.role,
            "jti": self.jti,
            "issued_at": self.issued_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
        }


@dataclass(frozen=True, slots=True)
class IssuedAccessToken:
    """A freshly minted access token plus the metadata the caller needs."""

    token: str
    jti: str
    expires_at: datetime
    expires_in_seconds: int
    """Handed to the client as `expires_in` so it can refresh proactively
    instead of waiting for a 401."""


def issue_access_token(
    *,
    user_id: uuid.UUID,
    email: str,
    role: str,
    now: datetime | None = None,
) -> IssuedAccessToken:
    """Mint a signed access token.

    Parameters
    ----------
    user_id:
        `users.id`; becomes the `sub` claim.
    email:
        Normalised address; becomes the `email` claim.
    role:
        Platform role, 'admin' or 'user'; becomes the `role` claim.
    now:
        Override for the current time (tests). Must be timezone-aware UTC.

    Returns
    -------
    `IssuedAccessToken`. TTL comes from `ACCESS_TOKEN_TTL_SECONDS` (seconds).

    Algorithm
    ---------
    1. Read the signing key and algorithm from configuration -- never from the
       token or from a request. `app/config.py` picks RS256 when a key pair is
       present and HS256 only as a development fallback.
    2. Build the claim set: `sub`, `email`, `role`, `jti`, `iat`, `exp`, `iss`,
       `aud`, `typ`.
    3. Sign. PyJWT base64url-encodes header and payload and appends the
       signature.

    Note that the payload is SIGNED, NOT ENCRYPTED. Anyone holding the token
    can read the email and role out of it, which is why no secret ever goes
    into a claim.
    """
    settings = get_settings()
    issued = now or datetime.now(UTC)
    expires = issued + timedelta(seconds=settings.ACCESS_TOKEN_TTL_SECONDS)
    jti = str(uuid.uuid4())

    payload: dict[str, Any] = {
        "sub": str(user_id),
        "email": email,
        "role": role,
        "jti": jti,
        # Integer seconds since the epoch, per RFC 7519. Passing datetimes also
        # works in PyJWT but int is unambiguous about the unit.
        "iat": int(issued.timestamp()),
        "exp": int(expires.timestamp()),
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
        "typ": ACCESS_TOKEN_TYPE,
    }

    token = jwt.encode(
        payload,
        settings.jwt_signing_key,
        algorithm=settings.jwt_algorithm,
    )
    return IssuedAccessToken(
        token=token,
        jti=jti,
        expires_at=expires,
        expires_in_seconds=settings.ACCESS_TOKEN_TTL_SECONDS,
    )


def decode_access_token(token: str) -> AccessTokenClaims:
    """Verify an access token's signature and claims, returning its contents.

    Parameters
    ----------
    token:
        The bare JWT (no `Bearer ` prefix -- strip that in the route).

    Returns
    -------
    `AccessTokenClaims` if and only if every check below passes.

    Raises
    ------
    TokenExpiredError
        `exp` is in the past (beyond `JWT_LEEWAY_SECONDS`).
    TokenInvalidError
        Anything else: bad signature, wrong algorithm, wrong issuer, wrong
        audience, a missing required claim, a `sub` that is not a UUID, or a
        `typ` that is not 'access'.

    Algorithm
    ---------
    1. Verify the signature with the CONFIGURED algorithm, passed as an
       explicit allow-list. This is the single most important line in the
       function: if you let PyJWT read the algorithm from the token's own
       header, an attacker can set `alg: none` (no signature at all) or, with a
       published RS256 public key, set `alg: HS256` and sign the token *with
       that public key* -- which the naive verifier then accepts because it
       uses the same value as an HMAC secret. Passing `algorithms=[...]` makes
       both attacks impossible.
    2. Verify `exp` (with leeway), `iss`, and `aud`. PyJWT raises on mismatch.
    3. Require the claims in `REQUIRED_CLAIMS` to be present, so a token
       without `exp` is rejected instead of being treated as eternal.
    4. Parse `sub` into a UUID and check `typ`.
    """
    settings = get_settings()
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.jwt_verification_key,
            algorithms=[settings.jwt_algorithm],
            audience=settings.JWT_AUDIENCE,
            issuer=settings.JWT_ISSUER,
            leeway=JWT_LEEWAY_SECONDS,
            options={
                "require": list(REQUIRED_CLAIMS),
                "verify_signature": True,
                "verify_exp": True,
                "verify_iss": True,
                "verify_aud": True,
            },
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenExpiredError("access token has expired") from exc
    except jwt.InvalidTokenError as exc:
        # Superclass of InvalidSignatureError, InvalidAudienceError,
        # InvalidIssuerError, MissingRequiredClaimError, DecodeError, ...
        # The reason is deliberately not propagated to the client.
        raise TokenInvalidError("access token is not valid") from exc

    if payload.get("typ") != ACCESS_TOKEN_TYPE:
        raise TokenInvalidError("token is not an access token")

    try:
        subject = uuid.UUID(str(payload["sub"]))
    except (ValueError, TypeError, KeyError) as exc:
        raise TokenInvalidError("token subject is not a valid user id") from exc

    role = payload.get("role")
    if role not in ("admin", "user"):
        # An unknown role must never be treated as elevated. Rejecting the
        # token outright is safer than silently downgrading, because it
        # surfaces a signing bug instead of hiding it.
        raise TokenInvalidError("token carries an unrecognised role")

    return AccessTokenClaims(
        sub=subject,
        email=str(payload.get("email", "")),
        role=role,
        jti=str(payload["jti"]),
        issued_at=datetime.fromtimestamp(int(payload["iat"]), tz=UTC),
        expires_at=datetime.fromtimestamp(int(payload["exp"]), tz=UTC),
        issuer=str(payload["iss"]),
        audience=str(payload["aud"]),
    )


# ---------------------------------------------------------------------------
# Opaque token helpers
# ---------------------------------------------------------------------------


def generate_refresh_token() -> str:
    """Return a fresh, unguessable refresh token.

    Returns
    -------
    ~43 URL-safe characters carrying `REFRESH_TOKEN_BYTES` (32) bytes of
    entropy from the OS CSPRNG.

    `secrets.token_urlsafe` -- not `random`, not `uuid4()`. `random` is a
    Mersenne Twister seeded from the clock: observing a few outputs lets an
    attacker reconstruct the internal state and predict every future token.
    `uuid4()` is CSPRNG-backed but wastes 6 bits on version/variant markers and
    invites the assumption that it is merely "unique" rather than "unguessable".
    """
    return secrets.token_urlsafe(REFRESH_TOKEN_BYTES)


def generate_reset_token() -> str:
    """Return a fresh password-reset token for an emailed link.

    Returns
    -------
    A URL-safe string (`RESET_TOKEN_BYTES` bytes of entropy) suitable for
    dropping straight into `?token=` -- `token_urlsafe` output needs no
    percent-encoding.
    """
    return secrets.token_urlsafe(RESET_TOKEN_BYTES)


def hash_opaque_token(token: str) -> str:
    """Hash an opaque token for storage and lookup.

    Parameters
    ----------
    token:
        A refresh token or password-reset token, as sent to the client.

    Returns
    -------
    Lowercase hex SHA-256 digest, 64 characters -- which is exactly the width
    of `refresh_tokens.token_hash` and `password_reset_tokens.token_hash`.

    Deterministic and unsalted ON PURPOSE, so the column can carry a unique
    index and be found with one equality lookup. See the module docstring for
    why that is safe here but would be indefensible for a password.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def constant_time_equals(left: str, right: str) -> bool:
    """Compare two secrets without leaking their contents through timing.

    Parameters
    ----------
    left, right:
        Any two strings where at least one is secret (a token, a token hash, a
        shared service token).

    Returns
    -------
    True if the strings are byte-identical.

    Why not `==`
    ------------
    Python's `str.__eq__` short-circuits at the first differing byte. An
    attacker who can measure response time precisely, and who can retry, can
    therefore discover a secret one byte at a time: guess byte 0 (256 tries),
    keep the guess that took marginally longer, move to byte 1. That turns an
    impossible 256-bit search into a few thousand requests.
    `hmac.compare_digest` compares every byte regardless, so the timing is
    independent of the content.

    Edge cases
    ----------
    Different-length inputs return False; the length itself is not secret for
    any of our tokens (they are all fixed width).
    """
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


# ---------------------------------------------------------------------------
# Refresh token rotation
# ---------------------------------------------------------------------------


@runtime_checkable
class RefreshTokenRecord(Protocol):
    """The subset of `models.RefreshToken` the rotation algorithm needs.

    Declared as a `Protocol` so the algorithm can be unit tested against an
    in-memory fake with no database, while the real `RefreshToken` ORM class
    satisfies it structurally. See `tests/test_refresh_rotation.py`.
    """

    id: uuid.UUID
    user_id: uuid.UUID
    family_id: uuid.UUID
    expires_at: datetime
    revoked_at: datetime | None
    replaced_by: uuid.UUID | None


class RefreshTokenStore(Protocol):
    """Persistence operations the rotation algorithm needs.

    Two implementations exist: `SqlRefreshTokenStore` in
    `app/security/refresh_store.py` (PostgreSQL) and `FakeRefreshTokenStore` in
    the test suite. Keeping the algorithm behind this seam is what makes the
    theft-detection logic testable without a database, which matters because it
    is the part that must never regress.
    """

    async def find_by_hash(self, token_hash: str) -> RefreshTokenRecord | None:
        """Return the row for `token_hash`, or None if there is no such token.

        Implementations SHOULD lock the row for the duration of the
        transaction; see the concurrency note in `rotate_refresh_token`.
        """
        ...

    async def insert(
        self,
        *,
        token_hash: str,
        user_id: uuid.UUID,
        family_id: uuid.UUID,
        expires_at: datetime,
        ip: str | None,
        user_agent: str | None,
    ) -> RefreshTokenRecord:
        """Persist a newly issued refresh token and return the stored row."""
        ...

    async def mark_replaced(
        self, record_id: uuid.UUID, replacement_id: uuid.UUID, now: datetime
    ) -> None:
        """Stamp `replaced_by` and `revoked_at` on the token being rotated away."""
        ...

    async def revoke_family(self, family_id: uuid.UUID, now: datetime) -> int:
        """Revoke every non-revoked token in a family. Returns how many."""
        ...

    async def revoke_by_hash(self, token_hash: str, now: datetime) -> bool:
        """Revoke one token by hash. Returns whether a live token was revoked."""
        ...

    async def revoke_all_for_user(self, user_id: uuid.UUID, now: datetime) -> int:
        """Revoke every live token for a user. Returns how many."""
        ...


class RefreshPresentation(StrEnum):
    """Classification of a presented refresh token. See `classify_refresh_token`."""

    UNKNOWN = "unknown"
    """No row matched the hash: never issued, or already deleted."""

    EXPIRED = "expired"
    """Past `expires_at`. The session simply aged out; the user logs in again."""

    REVOKED = "revoked"
    """Explicitly killed (logout, password reset, family revocation)."""

    REUSED = "reused"
    """Already rotated away -- `replaced_by` is set. Treated as theft."""

    ACTIVE = "active"
    """Live, unexpired, unrotated. The only classification that may rotate."""


def classify_refresh_token(
    record: RefreshTokenRecord | None, now: datetime
) -> RefreshPresentation:
    """Decide what a presented refresh token is, without touching the database.

    Parameters
    ----------
    record:
        The stored row matching the presented token's hash, or None.
    now:
        Current time, timezone-aware UTC.

    Returns
    -------
    A `RefreshPresentation`.

    Order of checks matters
    -----------------------
    `REUSED` is tested BEFORE `REVOKED`, because rotation stamps both
    `replaced_by` and `revoked_at` on the old row. A token that was rotated
    away and is now presented again must be reported as reuse (which triggers
    family revocation), not as an ordinary revoked token (which would be
    dismissed as a stale client). Getting this order wrong silently disables
    theft detection while all the tests about "revoked tokens are rejected"
    keep passing -- see `tests/test_refresh_rotation.py`.

    `EXPIRED` is tested before both, because a token that expired naturally
    carries no signal about compromise and should not revoke a family.
    """
    if record is None:
        return RefreshPresentation.UNKNOWN
    if record.expires_at <= now:
        return RefreshPresentation.EXPIRED
    if record.replaced_by is not None:
        return RefreshPresentation.REUSED
    if record.revoked_at is not None:
        return RefreshPresentation.REVOKED
    return RefreshPresentation.ACTIVE


@dataclass(frozen=True, slots=True)
class RotationResult:
    """What a successful rotation produced."""

    user_id: uuid.UUID
    family_id: uuid.UUID
    refresh_token: str
    """The NEW plaintext refresh token. Returned to the client exactly once and
    never stored -- only its hash is persisted."""
    expires_at: datetime
    """Inherited from the family, not extended. See `issue_refresh_token`."""


async def issue_refresh_token(
    store: RefreshTokenStore,
    *,
    user_id: uuid.UUID,
    family_id: uuid.UUID | None = None,
    expires_at: datetime | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    now: datetime | None = None,
) -> tuple[str, RefreshTokenRecord]:
    """Create and persist a refresh token.

    Parameters
    ----------
    store:
        Persistence seam.
    user_id:
        Owner of the session.
    family_id:
        Pass None at LOGIN to start a new family (a new device/session). Pass
        the existing family id during ROTATION so the lineage is preserved and
        reuse detection can revoke the whole chain at once.
    expires_at:
        Absolute deadline, timezone-aware UTC. None means
        `now + REFRESH_TOKEN_TTL_SECONDS` (a fresh login). During rotation the
        caller passes the family's ORIGINAL deadline, which is what stops a
        session living forever by refreshing forever -- after 30 days the user
        re-authenticates, no matter how active they were.
    ip, user_agent:
        Forensic breadcrumbs only. Never used to accept or reject a token; see
        the comment on `models.RefreshToken`.
    now:
        Time override for tests.

    Returns
    -------
    `(plaintext_token, stored_record)`. The plaintext is the ONLY copy that
    will ever exist outside the client -- there is no recovery path if the
    caller drops it.
    """
    issued = now or datetime.now(UTC)
    settings = get_settings()
    token = generate_refresh_token()
    record = await store.insert(
        token_hash=hash_opaque_token(token),
        user_id=user_id,
        family_id=family_id or uuid.uuid4(),
        expires_at=expires_at
        or (issued + timedelta(seconds=settings.REFRESH_TOKEN_TTL_SECONDS)),
        ip=ip,
        user_agent=user_agent,
    )
    return token, record


async def rotate_refresh_token(
    store: RefreshTokenStore,
    presented_token: str,
    *,
    ip: str | None = None,
    user_agent: str | None = None,
    now: datetime | None = None,
) -> RotationResult:
    """Exchange a refresh token for a new one, detecting theft.

    Parameters
    ----------
    store:
        Persistence seam.
    presented_token:
        The plaintext refresh token from the client's request body.
    ip, user_agent:
        Recorded on the newly issued token for forensics.
    now:
        Time override for tests.

    Returns
    -------
    `RotationResult` carrying the NEW refresh token. The caller mints a new
    access token separately and commits the transaction.

    Raises
    ------
    RefreshTokenReuseError
        The token had already been rotated away. The entire family has been
        revoked by the time this is raised. The caller must audit-log it (
        `refresh.reuse_detected`) and return a generic 401.
    TokenInvalidError
        Unknown, expired, or already-revoked token. Generic 401, no detail.

    =====================================================================
    THE ROTATION ALGORITHM, STEP BY STEP
    =====================================================================
    Step 1. Hash the presented token (SHA-256) and look up the row. We never
            compare plaintext against the database; the plaintext is discarded
            immediately after hashing.

    Step 2. Classify it (`classify_refresh_token`).

    Step 3. If it was ALREADY ROTATED AWAY, treat it as theft:

            Why? A legitimate client rotates and throws the old token away, so
            it has no reason to ever present it again. If the old token shows
            up, one of exactly two things happened:
                (a) an attacker stole the token, used it, and the real user
                    then tried to use their now-invalidated copy; or
                (b) an attacker stole the token and used it AFTER the real
                    user had already rotated it.
            We cannot tell (a) from (b) -- crucially, we cannot tell which of
            the two presenters is the thief. So we do the only safe thing:
            revoke the ENTIRE FAMILY. Both parties are logged out and must
            re-authenticate with the password (which the thief does not have).

            This is the property that makes a 30-day refresh token defensible.
            A stolen token buys the attacker at most one refresh before the
            theft becomes visible and self-limiting.

    Step 4. If it is unknown, expired, or plainly revoked, reject with a
            generic error. None of these revoke a family: an expired token is
            just an old session, and revoking on "unknown" would let anyone
            grief a user by posting random strings.

    Step 5. Issue a NEW token in the SAME family, inheriting the family's
            original `expires_at` (no sliding window -- see
            `issue_refresh_token`).

    Step 6. Stamp the old row with `replaced_by = <new id>` and `revoked_at`.
            The link is what makes Step 3 possible on the next presentation.

    =====================================================================
    CONCURRENCY
    =====================================================================
    Two refreshes racing with the SAME token (a mobile app firing two requests
    when it wakes up) look exactly like theft. Handled as follows:

      * `refresh_store.SqlRefreshTokenStore.find_by_hash` takes a row lock
        (`SELECT ... FOR UPDATE`), so the second request waits for the first to
        commit and then observes `replaced_by` set -- a deterministic outcome
        rather than two valid tokens.
      * The second request therefore fails closed (family revoked) instead of
        failing open (two live sessions). Fail-closed is the right default for
        a credential.
      * The client's obligation is to serialise its own refreshes; `apps/mobile`
        does this with a single in-flight refresh promise. That is a documented
        contract, not an accident.
    """
    moment = now or datetime.now(UTC)
    presented_hash = hash_opaque_token(presented_token)

    record = await store.find_by_hash(presented_hash)
    classification = classify_refresh_token(record, moment)

    if classification is RefreshPresentation.REUSED:
        # `record` is non-None whenever the classification is REUSED.
        assert record is not None
        revoked = await store.revoke_family(record.family_id, moment)
        # Note what is NOT logged here: the token. Only ids.
        logger.warning(
            "refresh token reuse detected for user_id=%s family_id=%s; revoked %d token(s)",
            record.user_id,
            record.family_id,
            revoked,
        )
        raise RefreshTokenReuseError(record.user_id, record.family_id, revoked)

    if classification is not RefreshPresentation.ACTIVE:
        raise TokenInvalidError(f"refresh token is {classification.value}")

    assert record is not None  # ACTIVE implies a row exists
    new_token, new_record = await issue_refresh_token(
        store,
        user_id=record.user_id,
        family_id=record.family_id,
        # Inherit, do not extend.
        expires_at=record.expires_at,
        ip=ip,
        user_agent=user_agent,
        now=moment,
    )
    await store.mark_replaced(record.id, new_record.id, moment)

    return RotationResult(
        user_id=record.user_id,
        family_id=record.family_id,
        refresh_token=new_token,
        expires_at=record.expires_at,
    )
