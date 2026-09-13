"""
MODULE: app.routes.internal

PURPOSE
    Service-to-service surface used by `services/api`. Every route requires
    the `X-Internal-Token` header, compared in constant time against
    `INTERNAL_SERVICE_TOKEN`. This is the ONLY authentication on this
    surface -- it must never be published to the internet.

INPUTS  : JSON bodies / path / query from the Node API
OUTPUTS : principals, allow/deny decisions, profile snapshots

ENDPOINTS
    POST /internal/verify-token     -- JWT -> {user_id, email, role, display_name}
    POST /internal/authorize        -- {user_id, action, resource} -> {allowed, reason}
    GET  /internal/users/{id}       -- profile by id
    GET  /internal/users?email=     -- profile by normalised email

CALLED BY
    `services/api` only. The mobile client never sees these URLs.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from app.audit import AuditAction, append_audit
from app.authz import authorize
from app.deps import InternalTokenDep, IpDep, SessionDep, UserAgentDep
from app.models import AuthCredential, UserProfile, normalise_email
from app.schemas import (
    AuthorizeRequest,
    AuthorizeResponse,
    UserPublic,
    VerifyTokenRequest,
    VerifyTokenResponse,
)
from app.security.tokens import TokenError, decode_access_token

router = APIRouter(prefix="/internal", tags=["internal"])


@router.post("/verify-token", response_model=VerifyTokenResponse)
async def verify_token(
    body: VerifyTokenRequest,
    session: SessionDep,
    _: InternalTokenDep,
) -> VerifyTokenResponse:
    """Decode a Bearer JWT and return the live principal.

    `role` and `display_name` are read from the *profile row*, not from the
    token snapshot, so a platform-admin demotion takes effect on the next
    API request rather than waiting out the 15-minute access-token TTL.
    The token is still what *authenticates* the caller; we just refresh
    the authorization-relevant fields.
    """
    try:
        claims = decode_access_token(body.access_token)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        ) from exc

    profile = (
        await session.execute(select(UserProfile).where(UserProfile.id == claims.sub))
    ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    # No audit row on the success path: this endpoint is on the hot path
    # of every API request, and logging it would double-write the database
    # for no investigative value (the API already logs the request).
    return VerifyTokenResponse(
        user_id=profile.id,
        email=profile.email,
        role=profile.role if profile.role in ("admin", "user") else "user",
        display_name=profile.display_name,
    )


@router.post("/authorize", response_model=AuthorizeResponse)
async def authorize_action(
    body: AuthorizeRequest,
    session: SessionDep,
    ip: IpDep,
    user_agent: UserAgentDep,
    _: InternalTokenDep,
) -> AuthorizeResponse:
    """Ask the decision engine whether `user_id` may perform `action`."""
    decision = await authorize(
        session,
        user_id=body.user_id,
        action=body.action,
        resource=body.resource,
    )
    # Denials only. Allows are the common case (every pod read) and would
    # drown the table; the reason string on a denial is what an incident
    # review actually needs.
    if not decision.allowed:
        await append_audit(
            session,
            actor_id=body.user_id,
            action=AuditAction.AUTHZ_DENY,
            resource=body.action,
            ip=ip,
            user_agent=user_agent,
            extra={"reason": decision.reason, "action": body.action},
        )
        await session.commit()
    return AuthorizeResponse(allowed=decision.allowed, reason=decision.reason)


def _profile_or_404(profile: UserProfile | None) -> UserPublic:
    """Raise 404 if the profile is missing; otherwise serialise it."""
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return UserPublic.model_validate(profile)


@router.get("/users/{user_id}", response_model=UserPublic)
async def get_user_by_id(
    user_id: uuid.UUID,
    session: SessionDep,
    _: InternalTokenDep,
) -> UserPublic:
    """Profile lookup by id. Used by the API to render member lists."""
    profile = (
        await session.execute(select(UserProfile).where(UserProfile.id == user_id))
    ).scalar_one_or_none()
    return _profile_or_404(profile)


@router.get("/users", response_model=UserPublic)
async def get_user_by_email(
    session: SessionDep,
    _: InternalTokenDep,
    email: str = Query(..., min_length=3, max_length=320),
) -> UserPublic:
    """Profile lookup by email. The address is normalised (strip + lower).

    We look up `auth_credentials.email` first (the unique, normalised
    index this service owns) and then load the profile, so a casing
    mismatch on the API-owned `users.email` column cannot hide an account.
    """
    normalised = normalise_email(email)
    credential = (
        await session.execute(select(AuthCredential).where(AuthCredential.email == normalised))
    ).scalar_one_or_none()
    if credential is None:
        # Fall back to the profile table in case a row was created by the
        # API without a credential (should not happen; fail closed as 404).
        profile = (
            await session.execute(select(UserProfile).where(UserProfile.email == normalised))
        ).scalar_one_or_none()
        return _profile_or_404(profile)

    profile = (
        await session.execute(select(UserProfile).where(UserProfile.id == credential.user_id))
    ).scalar_one_or_none()
    return _profile_or_404(profile)
