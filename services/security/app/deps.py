"""
MODULE: app.deps

PURPOSE
    FastAPI dependencies shared by every route: the request-scoped database
    session, the client IP, the rate-limit enforcer, the internal-service
    token gate, and "the user attached to this Bearer JWT".

INPUTS  : a Starlette `Request` (and, for the user, an Authorization header)
OUTPUTS : injected values the route handler can trust

CALLED BY
    `app/routes/*`. Nothing outside this service imports it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.models import UserProfile
from app.security.ratelimit import RateLimitAction, get_limiter
from app.security.tokens import (
    AccessTokenClaims,
    TokenError,
    constant_time_equals,
    decode_access_token,
)

# Re-export so route modules can write `SessionDep` without importing db.py
# and thinking about the generator protocol.
SessionDep = Annotated[AsyncSession, Depends(get_session)]

# `auto_error=False` so a missing header is our generic 401, not FastAPI's
# default 403 (which looks like an authorization failure rather than
# "please log in"). TokenError is also mapped to the same 401 so a bad JWT
# cannot leak "not enough segments" to a client.
_BEARER = HTTPBearer(auto_error=False)

# Generic 401 body. Same string for "no token", "bad signature", "expired",
# "user gone" -- anything more specific is an oracle.
_UNAUTHENTICATED = "Not authenticated"


@dataclass(frozen=True, slots=True)
class CurrentUser:
    """The authenticated principal for a Bearer-protected route.

    `claims` is what the token attested (signed, so trustworthy as a
    snapshot). `profile` is the live row, used for display_name and for a
    fresh `role` on `/auth/me`.
    """

    claims: AccessTokenClaims
    profile: UserProfile


class RateLimitEnforcer:
    """Thin wrapper so a route can `limiter.check(action, identifier=email)`.

    The IP is captured at dependency-resolution time (once per request) so
    handlers do not each re-parse `X-Forwarded-For`.
    """

    def __init__(self, ip: str) -> None:
        self.ip = ip

    def check(self, action: RateLimitAction, identifier: str | None = None) -> None:
        """Consume one unit of allowance or raise 429.

        Parameters
        ----------
        action:
            Which budget pair to apply. See `app/security/ratelimit.py`.
        identifier:
            The submitted email, already normalised, or None for actions
            that only have an IP budget.

        Raises
        ------
        HTTPException
            429 with a `Retry-After` header in SECONDS. The body does not
            say whether the IP or the identifier budget tripped -- that
            distinction would confirm to an attacker that they are hitting
            a real account.
        """
        # Staging/production keep the token buckets. Local `ENVIRONMENT=
        # development` (and pytest) skip them so Expo signup and the API
        # endpoint suite are not locked out for 15 minutes after a few
        # retries. The durable per-account lockout still applies.
        if not get_settings().is_production:
            return
        decision = get_limiter().check(action, ip=self.ip, identifier=identifier)
        if decision.allowed:
            return
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests. Try again later.",
            headers={"Retry-After": str(decision.retry_after_seconds)},
        )


def get_client_ip(request: Request) -> str:
    """Best-effort client address for rate limiting and the audit log.

    Parameters
    ----------
    request:
        The inbound ASGI request.

    Returns
    -------
    At most 64 characters (the column width on `audit_log.ip` /
    `refresh_tokens.created_ip`). Falls back to the literal `'unknown'`
    so the limiter still has a bucket -- requests with no address share
    one budget rather than being exempted.

    `X-Forwarded-For`
    -----------------
    The leftmost hop is the original client when the proxy chain is
    trusted. We take only the first value and do not try to be clever
    about spoofing: if an attacker can set this header, they can already
    pick their rate-limit bucket, which is why this service must sit
    behind a proxy that overwrites (not appends-from-client) the header.
    The per-account lockout does not use the IP, so a spoofed address
    cannot unlock an account.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",", 1)[0].strip()
        if first:
            return first[:64]
    if request.client and request.client.host:
        return request.client.host[:64]
    return "unknown"


def get_user_agent(request: Request) -> str | None:
    """Return the User-Agent header, truncated to the column width (512).

    Attacker-controlled free text. Stored for forensics, never used as an
    authorization input -- binding a session to a User-Agent string logs
    people out when their browser updates.
    """
    value = request.headers.get("user-agent")
    if not value:
        return None
    return value[:512]


def get_rate_limiter(ip: Annotated[str, Depends(get_client_ip)]) -> RateLimitEnforcer:
    """FastAPI dependency yielding a per-request `RateLimitEnforcer`."""
    return RateLimitEnforcer(ip)


async def require_internal_token(
    x_internal_token: Annotated[str | None, Header(alias="X-Internal-Token")] = None,
) -> None:
    """Gate every `/internal/*` route on the shared service token.

    Parameters
    ----------
    x_internal_token:
        Value of the `X-Internal-Token` header, or None if omitted.

    Raises
    ------
    HTTPException 401
        Missing header, or a value that does not match
        `INTERNAL_SERVICE_TOKEN`. Compared with `hmac.compare_digest` via
        `constant_time_equals` so a timing oracle cannot discover the
        token one byte at a time.

    This is the ONLY authentication on `/internal/*`. Those routes must
    never be exposed to the public internet -- keep them on the compose
    network / a private VPC.
    """
    settings = get_settings()
    expected = settings.INTERNAL_SERVICE_TOKEN.get_secret_value()
    presented = x_internal_token or ""
    if not presented or not constant_time_equals(presented, expected):
        # Do not log the presented value. A mistyped token in a log file is
        # still a credential.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_UNAUTHENTICATED,
        )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_BEARER)],
    session: SessionDep,
) -> CurrentUser:
    """Resolve `Authorization: Bearer <jwt>` to a live user.

    Returns
    -------
    `CurrentUser` with verified claims and the profile row.

    Raises
    ------
    HTTPException 401
        Missing header, bad / expired / wrong-audience token, or a `sub`
        whose profile row has been deleted. Same body in every case.
    """
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_UNAUTHENTICATED,
        )
    try:
        claims = decode_access_token(credentials.credentials)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_UNAUTHENTICATED,
        ) from exc

    profile = (
        await session.execute(select(UserProfile).where(UserProfile.id == claims.sub))
    ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_UNAUTHENTICATED,
        )
    return CurrentUser(claims=claims, profile=profile)


# Annotated aliases the route signatures actually use.
IpDep = Annotated[str, Depends(get_client_ip)]
UserAgentDep = Annotated[str | None, Depends(get_user_agent)]
LimiterDep = Annotated[RateLimitEnforcer, Depends(get_rate_limiter)]
CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]
InternalTokenDep = Annotated[None, Depends(require_internal_token)]
