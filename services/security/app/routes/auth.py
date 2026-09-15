"""
MODULE: app.routes.auth

PURPOSE
    The public authentication surface the mobile / web client talks to
    directly: register, verify/resend OTP, login, refresh, logout,
    forgot/reset password, the "who am I" endpoints, and account deletion.

INPUTS  : JSON bodies documented in `app/schemas.py`
OUTPUTS : tokens, profile snapshots, or generic success/error bodies

CALLED BY
    The Peapod client. `services/api` does not use these routes -- it
    authenticates via `/internal/verify-token`.

TRANSACTION POLICY
    Handlers commit explicitly (see `app/db.py`). A failed-login counter
    increment is committed even though the response is 401; a half-finished
    registration is rolled back by the session dependency if we raise
    before committing.

GENERIC ERRORS
    Login, OTP verify, and reset-password collapse every failure into one
    message. Revealing "no such email" versus "wrong password" versus
    "expired token" is an account-enumeration oracle.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta

import anyio
from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import delete as sql_delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditAction, append_audit
from app.config import get_settings
from app.deps import (
    CurrentUserDep,
    IpDep,
    LimiterDep,
    SessionDep,
    UserAgentDep,
)
from app.email import send_otp_email, send_password_reset_email
from app.models import (
    AuthCredential,
    OAuthIdentity,
    OtpCode,
    OtpPurpose,
    PasswordResetToken,
    UserProfile,
    utcnow,
)
from app.schemas import (
    DeleteAccountRequest,
    EmailSentResponse,
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    PatchMeRequest,
    RefreshRequest,
    RegisterRequest,
    RegisterResponse,
    ResetPasswordRequest,
    ResendOtpRequest,
    TokenResponse,
    UserPublic,
    VerifyOtpRequest,
)
from app.security.otp import OtpCandidate, OtpVerdict, check_candidate, generate
from app.security.passwords import hash_password, verify_password
from app.security.ratelimit import RateLimitAction
from app.security.refresh_store import SqlRefreshTokenStore
from app.security.tokens import (
    RefreshTokenReuseError,
    TokenError,
    generate_reset_token,
    hash_opaque_token,
    issue_access_token,
    issue_refresh_token,
    rotate_refresh_token,
)

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lockout
# ---------------------------------------------------------------------------
# THREAT: credential stuffing against one account. The per-IP limiter in
# `ratelimit.py` stops one address spraying many accounts; this stops many
# addresses spraying one account. Both are required.

#: Consecutive failed password checks before `locked_until` is set.
#: 10 matches the budget commentary in `ratelimit.py` ("lockout after 10
#: total failures"). A human who has forgotten their password will have
#: clicked "Forgot password?" long before this; a stuffing bot will not.
LOCKOUT_THRESHOLD = 10

#: How long a lockout lasts, in SECONDS. 900 s = 15 minutes: long enough
#: that a stuffing burst dies, short enough that a legitimate user who
#: mashed the keyboard is not locked out of their evening.
LOCKOUT_SECONDS = 900

_INVALID_CREDENTIALS = "Invalid email or password"
_INVALID_OTP = "Invalid or expired code"
_INVALID_RESET = "Invalid or expired token"
_UNAUTHENTICATED = "Not authenticated"


def serialise_user(profile: UserProfile) -> UserPublic:
    """Build the public profile snapshot from an ORM row."""
    return UserPublic.model_validate(profile)


async def issue_session_tokens(
    session: AsyncSession,
    profile: UserProfile,
    *,
    ip: str | None,
    user_agent: str | None,
) -> TokenResponse:
    """Mint an access token and a fresh refresh-token family for `profile`.

    Parameters
    ----------
    session:
        Used by the refresh store. Caller commits.
    profile:
        Live user. `id` / `email` / `role` go into the JWT.
    ip, user_agent:
        Forensic breadcrumbs on the refresh row only.

    Returns
    -------
    `TokenResponse` including the public user snapshot.
    """
    access = issue_access_token(
        user_id=profile.id,
        email=profile.email,
        role=profile.role,
    )
    store = SqlRefreshTokenStore(session)
    refresh_token, _record = await issue_refresh_token(
        store,
        user_id=profile.id,
        ip=ip,
        user_agent=user_agent,
    )
    return TokenResponse(
        access_token=access.token,
        refresh_token=refresh_token,
        token_type="bearer",
        expires_in=access.expires_in_seconds,
        user=serialise_user(profile),
    )


async def _load_credential_by_email(
    session: AsyncSession, email: str, *, for_update: bool = False
) -> AuthCredential | None:
    """Look up the credential row for a normalised email."""
    statement = select(AuthCredential).where(AuthCredential.email == email)
    if for_update:
        statement = statement.with_for_update()
    return (await session.execute(statement)).scalar_one_or_none()


async def _load_profile(session: AsyncSession, user_id: uuid.UUID) -> UserProfile | None:
    """Load the API-owned profile row. None if the API has not migrated it."""
    return (
        await session.execute(select(UserProfile).where(UserProfile.id == user_id))
    ).scalar_one_or_none()


async def _consume_live_otps(
    session: AsyncSession,
    user_id: uuid.UUID,
    purpose: OtpPurpose,
    now: datetime,
) -> None:
    """Kill every unconsumed code for this user+purpose.

    Issuing a new code without this would leave every previously emailed
    code live until its own TTL, multiplying the attacker's 5-guess window
    by however many mails the inbox still holds.
    """
    await session.execute(
        update(OtpCode)
        .where(
            OtpCode.user_id == user_id,
            OtpCode.purpose == purpose,
            OtpCode.consumed_at.is_(None),
        )
        .values(consumed_at=now)
    )


async def issue_and_send_otp(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    email: str,
    purpose: OtpPurpose,
    ip: str | None,
    user_agent: str | None,
) -> bool:
    """Create one OTP row and try to email the plaintext code.

    Parameters
    ----------
    session:
        Caller commits after this returns.
    user_id, email, purpose:
        Identity and why the code exists.
    ip, user_agent:
        Audit breadcrumbs.

    Returns
    -------
    `email_sent` from the mailer. The row is created even if send fails so
    a subsequent resend has something to replace.

    CPU
    ---
    When OTP_STORE_PLAINTEXT is on, generate() is cheap and stays on the
    event loop via the same worker-thread call for a stable call site.
    """
    settings = get_settings()
    now = utcnow()
    await _consume_live_otps(session, user_id, purpose, now)
    generated = await anyio.to_thread.run_sync(generate, settings.OTP_TTL_SECONDS)
    session.add(
        OtpCode(
            user_id=user_id,
            code_hash=generated.code_hash,
            purpose=purpose,
            expires_at=generated.expires_at,
        )
    )
    await session.flush()
    sent = await send_otp_email(email, generated.code, purpose)
    await append_audit(
        session,
        actor_id=user_id,
        action=AuditAction.OTP_ISSUE,
        resource=f"user:{user_id}",
        ip=ip,
        user_agent=user_agent,
        extra={"purpose": purpose.value, "email_sent": sent},
    )
    return sent


def _apply_lockout(credential: AuthCredential, now: datetime) -> bool:
    """Increment the failure counter and lock if the threshold is crossed.

    Parameters
    ----------
    credential:
        Mutated in place. Caller flushes/commits.
    now:
        Timezone-aware UTC.

    Returns
    -------
    True if this failure engaged a new lockout (so the caller can audit
    `login.lockout` as well as `login.failure`).
    """
    credential.failed_attempt_count += 1
    credential.updated_at = now
    if credential.failed_attempt_count >= LOCKOUT_THRESHOLD:
        credential.locked_until = now + timedelta(seconds=LOCKOUT_SECONDS)
        return True
    return False


def _clear_expired_lockout(credential: AuthCredential, now: datetime) -> None:
    """If a previous lockout has aged out, reset the counter.

    Without this, the 11th attempt after the window would instantly
    re-lock because `failed_attempt_count` would still be 10.
    """
    if credential.locked_until is not None and credential.locked_until <= now:
        credential.locked_until = None
        credential.failed_attempt_count = 0


# ---------------------------------------------------------------------------
# POST /auth/register
# ---------------------------------------------------------------------------


@router.post(
    "/register",
    response_model=RegisterResponse,
    status_code=status.HTTP_201_CREATED,
)
async def register(
    body: RegisterRequest,
    session: SessionDep,
    limiter: LimiterDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> RegisterResponse:
    """Create a profile + credential in one transaction and email an OTP.

    Returns `{user_id, email_sent}`. Tokens are issued only after
    `POST /auth/verify-otp`, so a registration with somebody else's address
    cannot be used until that inbox produces the code.
    """
    limiter.check(RateLimitAction.REGISTER, identifier=body.email)

    cred_table = AuthCredential.__tablename__
    users_table = UserProfile.__tablename__
    print(
        f"[auth.register] existence check table={cred_table!r} "
        f"(also unique on {users_table!r}.email) email={body.email!r}",
        flush=True,
    )
    existing = await _load_credential_by_email(session, body.email)
    if existing is not None:
        # 409 is an enumeration signal, accepted deliberately: the user is
        # trying to sign up and needs to know to log in instead. Login and
        # forgot-password stay silent.
        print(
            f"[auth.register] 409 account exists table={cred_table!r} "
            f"email={body.email!r} user_id={existing.user_id} "
            f"email_verified={existing.email_verified}",
            flush=True,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        )

    user_id = uuid.uuid4()
    now = utcnow()
    password_hash = await anyio.to_thread.run_sync(hash_password, body.password)

    profile = UserProfile(
        id=user_id,
        email=body.email,
        display_name=body.display_name,
        avatar_url=None,
        permissions_granted=False,
        role="user",
        created_at=now,
        updated_at=now,
        created_by_id=user_id,
    )
    credential = AuthCredential(
        user_id=user_id,
        email=body.email,
        password_hash=password_hash,
        email_verified=False,
        failed_attempt_count=0,
        locked_until=None,
        created_at=now,
        updated_at=now,
    )
    session.add(profile)
    session.add(credential)

    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        orig = getattr(exc, "orig", None)
        diag = getattr(orig, "diag", None)
        table = getattr(diag, "table_name", None) if diag is not None else None
        constraint = getattr(diag, "constraint_name", None) if diag is not None else None
        blob = f"{orig} {exc}".lower()
        if not table:
            if "auth_credentials" in blob:
                table = cred_table
            elif "users" in blob:
                table = users_table
            else:
                table = f"unknown ({orig!r})"
        print(
            f"[auth.register] 409 IntegrityError table={table!r} "
            f"constraint={constraint!r} email={body.email!r} orig={orig!r}",
            flush=True,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        ) from exc

    sent = await issue_and_send_otp(
        session,
        user_id=user_id,
        email=body.email,
        purpose=OtpPurpose.REGISTER,
        ip=ip,
        user_agent=user_agent,
    )
    await append_audit(
        session,
        actor_id=user_id,
        action=AuditAction.REGISTER,
        resource=f"user:{user_id}",
        ip=ip,
        user_agent=user_agent,
        extra={"email_sent": sent},
    )
    await session.commit()
    return RegisterResponse(user_id=user_id, email_sent=sent)


# ---------------------------------------------------------------------------
# POST /auth/verify-otp
# ---------------------------------------------------------------------------


@router.post("/verify-otp", response_model=TokenResponse)
async def verify_otp(
    body: VerifyOtpRequest,
    session: SessionDep,
    limiter: LimiterDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> TokenResponse:
    """Spend a one-time code. On success, mark the email verified and sign in."""
    limiter.check(RateLimitAction.OTP_VERIFY, identifier=body.email)
    now = utcnow()

    credential = await _load_credential_by_email(session, body.email, for_update=True)
    if credential is None:
        # Burn a dummy check so the "no account" path is not a fast 401.
        await anyio.to_thread.run_sync(
            check_candidate,
            None,
            body.code,
            now,
        )
        await append_audit(
            session,
            actor_id=None,
            action=AuditAction.OTP_VERIFY_FAILURE,
            resource=body.email,
            ip=ip,
            user_agent=user_agent,
            extra={"purpose": body.purpose.value, "reason": "no_account"},
        )
        await session.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_INVALID_OTP)

    row = (
        await session.execute(
            select(OtpCode)
            .where(
                OtpCode.user_id == credential.user_id,
                OtpCode.purpose == body.purpose,
            )
            .order_by(OtpCode.created_at.desc())
            .limit(1)
            .with_for_update()
        )
    ).scalar_one_or_none()

    candidate = (
        None
        if row is None
        else OtpCandidate(
            code_hash=row.code_hash,
            expires_at=row.expires_at,
            consumed_at=row.consumed_at,
            attempt_count=row.attempt_count,
        )
    )
    verdict = await anyio.to_thread.run_sync(check_candidate, candidate, body.code, now)

    if verdict is OtpVerdict.MISMATCH and row is not None:
        row.attempt_count += 1

    if verdict is not OtpVerdict.OK:
        await append_audit(
            session,
            actor_id=credential.user_id,
            action=AuditAction.OTP_VERIFY_FAILURE,
            resource=f"user:{credential.user_id}",
            ip=ip,
            user_agent=user_agent,
            extra={"purpose": body.purpose.value, "verdict": verdict.value},
        )
        await session.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_INVALID_OTP)

    assert row is not None  # OK implies a live row
    row.consumed_at = now
    credential.email_verified = True
    credential.failed_attempt_count = 0
    credential.locked_until = None
    credential.updated_at = now

    profile = await _load_profile(session, credential.user_id)
    if profile is None:
        await session.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_INVALID_OTP)

    tokens = await issue_session_tokens(session, profile, ip=ip, user_agent=user_agent)
    await append_audit(
        session,
        actor_id=credential.user_id,
        action=AuditAction.OTP_VERIFY_SUCCESS,
        resource=f"user:{credential.user_id}",
        ip=ip,
        user_agent=user_agent,
        extra={"purpose": body.purpose.value},
    )
    await session.commit()
    return tokens


# ---------------------------------------------------------------------------
# POST /auth/resend-otp
# ---------------------------------------------------------------------------


@router.post("/resend-otp", response_model=EmailSentResponse)
async def resend_otp(
    body: ResendOtpRequest,
    session: SessionDep,
    limiter: LimiterDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> EmailSentResponse:
    """Issue a fresh code. Always 200, so the route cannot enumerate accounts."""
    limiter.check(RateLimitAction.OTP_RESEND, identifier=body.email)
    credential = await _load_credential_by_email(session, body.email)
    if credential is None:
        await append_audit(
            session,
            actor_id=None,
            action=AuditAction.OTP_ISSUE,
            resource=body.email,
            ip=ip,
            user_agent=user_agent,
            extra={"purpose": body.purpose.value, "reason": "no_account"},
        )
        await session.commit()
        return EmailSentResponse(email_sent=True)

    await issue_and_send_otp(
        session,
        user_id=credential.user_id,
        email=credential.email,
        purpose=body.purpose,
        ip=ip,
        user_agent=user_agent,
    )
    await session.commit()
    # Always report True to the client so this route cannot enumerate
    # accounts. Whether the mailer actually handed the message off is
    # already on the audit row written by `issue_and_send_otp`.
    return EmailSentResponse(email_sent=True)


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    session: SessionDep,
    limiter: LimiterDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> TokenResponse:
    """Verify email+password, with lockout and dummy-hash equalisation.

    Unverified accounts: the password is checked (so we know it is them)
    and a registration OTP is re-sent instead of minting tokens. That is
    a 403, not a 401 -- they proved the password, they just have not
    proved the inbox.
    """
    limiter.check(RateLimitAction.LOGIN, identifier=body.email)
    now = utcnow()
    credential = await _load_credential_by_email(session, body.email, for_update=True)

    stored_hash = credential.password_hash if credential is not None else None
    result = await anyio.to_thread.run_sync(verify_password, stored_hash, body.password)

    if credential is None or not result.ok:
        locked_now = False
        if credential is not None:
            _clear_expired_lockout(credential, now)
            if credential.locked_until is not None and credential.locked_until > now:
                locked_now = True
            else:
                locked_now = _apply_lockout(credential, now)
        await append_audit(
            session,
            actor_id=credential.user_id if credential is not None else None,
            action=AuditAction.LOGIN_LOCKOUT if locked_now else AuditAction.LOGIN_FAILURE,
            resource=body.email if credential is None else f"user:{credential.user_id}",
            ip=ip,
            user_agent=user_agent,
            extra={"locked": locked_now},
        )
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_INVALID_CREDENTIALS,
        )

    _clear_expired_lockout(credential, now)
    if credential.locked_until is not None and credential.locked_until > now:
        # Password was correct but the account is still in a lockout window.
        # Do NOT reveal that -- same 401 as a wrong password -- otherwise an
        # attacker who stuffed until lockout could confirm they have the
        # right password by watching the error change.
        await append_audit(
            session,
            actor_id=credential.user_id,
            action=AuditAction.LOGIN_LOCKOUT,
            resource=f"user:{credential.user_id}",
            ip=ip,
            user_agent=user_agent,
            extra={"still_locked": True},
        )
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_INVALID_CREDENTIALS,
        )

    if result.upgraded_hash is not None:
        credential.password_hash = result.upgraded_hash

    if not credential.email_verified:
        credential.failed_attempt_count = 0
        credential.locked_until = None
        credential.updated_at = now
        sent = await issue_and_send_otp(
            session,
            user_id=credential.user_id,
            email=credential.email,
            purpose=OtpPurpose.REGISTER,
            ip=ip,
            user_agent=user_agent,
        )
        await append_audit(
            session,
            actor_id=credential.user_id,
            action=AuditAction.LOGIN_UNVERIFIED,
            resource=f"user:{credential.user_id}",
            ip=ip,
            user_agent=user_agent,
            extra={"email_sent": sent},
        )
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"detail": "email not verified", "email_sent": sent},
        )

    credential.failed_attempt_count = 0
    credential.locked_until = None
    credential.updated_at = now

    profile = await _load_profile(session, credential.user_id)
    if profile is None:
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_INVALID_CREDENTIALS,
        )

    tokens = await issue_session_tokens(session, profile, ip=ip, user_agent=user_agent)
    await append_audit(
        session,
        actor_id=credential.user_id,
        action=AuditAction.LOGIN_SUCCESS,
        resource=f"user:{credential.user_id}",
        ip=ip,
        user_agent=user_agent,
        extra=None,
    )
    await session.commit()
    return tokens


# ---------------------------------------------------------------------------
# POST /auth/refresh
# ---------------------------------------------------------------------------


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest,
    session: SessionDep,
    limiter: LimiterDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> TokenResponse:
    """Rotate a refresh token and mint a new access token.

    Reuse of an already-rotated token revokes the whole family and returns
    the same generic 401 as an unknown token. See
    `tokens.rotate_refresh_token` for the theft-detection reasoning.
    """
    limiter.check(RateLimitAction.TOKEN_REFRESH)
    store = SqlRefreshTokenStore(session)
    try:
        rotation = await rotate_refresh_token(
            store,
            body.refresh_token,
            ip=ip,
            user_agent=user_agent,
        )
    except RefreshTokenReuseError as exc:
        await append_audit(
            session,
            actor_id=exc.user_id,
            action=AuditAction.REFRESH_REUSE,
            resource=f"user:{exc.user_id}",
            ip=ip,
            user_agent=user_agent,
            extra={"family_id": str(exc.family_id), "revoked_count": exc.revoked_count},
        )
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_UNAUTHENTICATED,
        ) from exc
    except TokenError as exc:
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_UNAUTHENTICATED,
        ) from exc

    profile = await _load_profile(session, rotation.user_id)
    if profile is None:
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_UNAUTHENTICATED,
        )

    access = issue_access_token(
        user_id=profile.id,
        email=profile.email,
        role=profile.role,
    )
    await append_audit(
        session,
        actor_id=profile.id,
        action=AuditAction.TOKEN_REFRESH,
        resource=f"user:{profile.id}",
        ip=ip,
        user_agent=user_agent,
        extra={"family_id": str(rotation.family_id)},
    )
    await session.commit()
    return TokenResponse(
        access_token=access.token,
        refresh_token=rotation.refresh_token,
        token_type="bearer",
        expires_in=access.expires_in_seconds,
        user=serialise_user(profile),
    )


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    body: LogoutRequest,
    session: SessionDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> Response:
    """Revoke the presented refresh token. Always 204 -- never confirm it existed."""
    store = SqlRefreshTokenStore(session)
    presented_hash = hash_opaque_token(body.refresh_token)
    revoked = await store.revoke_by_hash(presented_hash, utcnow())
    await append_audit(
        session,
        actor_id=None,
        action=AuditAction.LOGOUT,
        resource=None,
        ip=ip,
        user_agent=user_agent,
        extra={"revoked": revoked},
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# POST /auth/forgot-password
# ---------------------------------------------------------------------------


@router.post("/forgot-password", response_model=EmailSentResponse)
async def forgot_password(
    body: ForgotPasswordRequest,
    session: SessionDep,
    limiter: LimiterDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> EmailSentResponse:
    """Always 200. If the address exists, email a single-use reset link.

    Returning the same body for known and unknown addresses is what stops
    this endpoint being used to mine the user table.
    """
    limiter.check(RateLimitAction.PASSWORD_RESET_REQUEST, identifier=body.email)
    try:
        credential = await _load_credential_by_email(session, body.email)

        if credential is not None and credential.password_hash is not None:
            settings = get_settings()
            now = utcnow()
            token = generate_reset_token()
            session.add(
                PasswordResetToken(
                    user_id=credential.user_id,
                    token_hash=hash_opaque_token(token),
                    expires_at=now + timedelta(seconds=settings.PASSWORD_RESET_TTL_SECONDS),
                    requested_ip=ip,
                )
            )
            await session.flush()
            sent = await send_password_reset_email(credential.email, token)
            await append_audit(
                session,
                actor_id=credential.user_id,
                action=AuditAction.PASSWORD_RESET_REQUEST,
                resource=f"user:{credential.user_id}",
                ip=ip,
                user_agent=user_agent,
                extra={"email_sent": sent},
            )
        else:
            await append_audit(
                session,
                actor_id=credential.user_id if credential is not None else None,
                action=AuditAction.PASSWORD_RESET_REQUEST,
                resource=body.email,
                ip=ip,
                user_agent=user_agent,
                extra={"reason": "no_account_or_oauth_only"},
            )

        await session.commit()
    except Exception:
        # Must still be 200: a 500 only for known addresses is an enumeration
        # oracle, and a mail/table failure must not brick the screen.
        logger.exception("forgot-password failed after rate-limit check")
        try:
            await session.rollback()
        except Exception:
            logger.exception("forgot-password rollback failed")
    return EmailSentResponse(email_sent=True)


# ---------------------------------------------------------------------------
# POST /auth/reset-password
# ---------------------------------------------------------------------------


@router.post("/reset-password", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(
    body: ResetPasswordRequest,
    session: SessionDep,
    limiter: LimiterDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> Response:
    """Consume a reset token, set a new password, revoke every live session.

    Revoking sessions is the point of a reset: the usual reason someone
    resets is that they believe someone else has the old password, and
    leaving that person's 30-day refresh token alive would make the reset
    pointless.
    """
    limiter.check(RateLimitAction.PASSWORD_RESET_SUBMIT)
    now = utcnow()
    token_hash = hash_opaque_token(body.token)
    row = (
        await session.execute(
            select(PasswordResetToken)
            .where(PasswordResetToken.token_hash == token_hash)
            .with_for_update()
        )
    ).scalar_one_or_none()

    if (
        row is None
        or row.consumed_at is not None
        or row.expires_at <= now
    ):
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_INVALID_RESET,
        )

    credential = (
        await session.execute(
            select(AuthCredential)
            .where(AuthCredential.user_id == row.user_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if credential is None:
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_INVALID_RESET,
        )

    new_hash = await anyio.to_thread.run_sync(hash_password, body.password)
    row.consumed_at = now
    credential.password_hash = new_hash
    credential.email_verified = True
    credential.failed_attempt_count = 0
    credential.locked_until = None
    credential.updated_at = now

    store = SqlRefreshTokenStore(session)
    revoked = await store.revoke_all_for_user(credential.user_id, now)
    await append_audit(
        session,
        actor_id=credential.user_id,
        action=AuditAction.PASSWORD_RESET_COMPLETE,
        resource=f"user:{credential.user_id}",
        ip=ip,
        user_agent=user_agent,
        extra={"sessions_revoked": revoked},
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# GET /auth/me
# ---------------------------------------------------------------------------


@router.get("/me", response_model=UserPublic)
async def read_me(current: CurrentUserDep) -> UserPublic:
    """Return the live profile for the Bearer token's subject."""
    return serialise_user(current.profile)


# ---------------------------------------------------------------------------
# PATCH /auth/me
# ---------------------------------------------------------------------------


@router.patch("/me", response_model=UserPublic)
async def patch_me(
    body: PatchMeRequest,
    current: CurrentUserDep,
    session: SessionDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> UserPublic:
    """Update display_name / avatar_url / permissions_granted."""
    profile = current.profile
    if body.display_name is not None:
        profile.display_name = body.display_name
    if "avatar_url" in body.model_fields_set:
        # Explicit null clears the avatar; omitted leaves it alone.
        profile.avatar_url = body.avatar_url
    granted_now = False
    if body.permissions_granted is not None:
        granted_now = body.permissions_granted and not profile.permissions_granted
        profile.permissions_granted = body.permissions_granted
    profile.updated_at = utcnow()

    await append_audit(
        session,
        actor_id=profile.id,
        action=AuditAction.PERMISSIONS_GRANT if granted_now else AuditAction.PROFILE_UPDATE,
        resource=f"user:{profile.id}",
        ip=ip,
        user_agent=user_agent,
        extra={"fields": sorted(body.model_fields_set)},
    )
    await session.commit()
    return serialise_user(profile)


# ---------------------------------------------------------------------------
# POST /auth/delete-account
# ---------------------------------------------------------------------------


@router.post("/delete-account", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    body: DeleteAccountRequest,
    current: CurrentUserDep,
    session: SessionDep,
    ip: IpDep,
    user_agent: UserAgentDep,
) -> Response:
    """Revoke every session, delete the credential, and drop the profile row.

    Full domain-data deletion (pods, pings, messages) is the API's job.
    We still delete `users` here when the row is present so a crashed
    follow-up on the API side cannot leave a profile that can be looked
    up but never logged into. OAuth identities and outstanding OTPs /
    reset tokens go too, so the same Google account or inbox code cannot
    resurrect the credential.

    Refresh-token *rows* are revoked and left in place as a forensic trail;
    the unique index is on the hash of a now-useless secret.
    """
    credential = (
        await session.execute(
            select(AuthCredential)
            .where(AuthCredential.user_id == current.profile.id)
            .with_for_update()
        )
    ).scalar_one_or_none()

    stored_hash = credential.password_hash if credential is not None else None
    result = await anyio.to_thread.run_sync(verify_password, stored_hash, body.password)
    if credential is None or not result.ok:
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_INVALID_CREDENTIALS,
        )

    now = utcnow()
    user_id = current.profile.id
    store = SqlRefreshTokenStore(session)
    await store.revoke_all_for_user(user_id, now)

    await session.execute(sql_delete(OtpCode).where(OtpCode.user_id == user_id))
    await session.execute(
        sql_delete(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
    )
    await session.execute(sql_delete(OAuthIdentity).where(OAuthIdentity.user_id == user_id))
    await session.delete(credential)

    profile = await _load_profile(session, user_id)
    if profile is not None:
        await session.delete(profile)

    await append_audit(
        session,
        actor_id=user_id,
        action=AuditAction.ACCOUNT_DELETE,
        resource=f"user:{user_id}",
        ip=ip,
        user_agent=user_agent,
        extra=None,
    )
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
