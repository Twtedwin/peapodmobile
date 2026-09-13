"""
MODULE: app.routes.oauth

PURPOSE
    Google sign-in as an OAuth 2.0 / OpenID Connect authorization-code
    flow with PKCE. Two endpoints:

      GET /auth/oauth/google/start     -- redirect the browser to Google
      GET /auth/oauth/google/callback  -- redeem the code, mint Peapod tokens,
                                          bounce the browser to the client
                                          with the tokens in the URL fragment

INPUTS  : query parameters from the browser (`code`, `state`, `error`)
OUTPUTS : a 302 redirect, either to Google or back to the client

CALLED BY
    The Peapod client's "Continue with Google" button. Tokens travel in
    the URL *fragment* (not the query string) so they are not forwarded
    as a `Referer` and do not land in server-side access logs of the
    client origin.

If Google credentials are not configured, `/start` returns 503 with a
message that names the missing variables -- a developer looking at a
blank redirect needs that, and there is no secret in the message.
"""

from __future__ import annotations

import logging
import uuid
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.audit import AuditAction, append_audit
from app.config import get_settings
from app.deps import IpDep, LimiterDep, SessionDep, UserAgentDep
from app.models import AuthCredential, OAuthIdentity, UserProfile, utcnow
from app.routes.auth import issue_session_tokens
from app.security.oauth_google import (
    OAuthError,
    build_authorization_url,
    consume_state,
    exchange_code,
    verify_id_token,
)
from app.security.ratelimit import RateLimitAction

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth/oauth/google", tags=["oauth"])

_GOOGLE_PROVIDER = "google"


def _client_error_redirect(reason: str) -> RedirectResponse:
    """Bounce the browser back to the client with an error in the fragment.

    Parameters
    ----------
    reason:
        A short, non-secret token (`access_denied`, `not_configured`,
        `sign_in_failed`). The client maps it to a human message. We
        deliberately do not put Google's error_description in the URL --
        it can contain email addresses and is not useful to the user.
    """
    settings = get_settings()
    target = settings.OAUTH_SUCCESS_REDIRECT_URL
    return RedirectResponse(url=f"{target}#error={reason}", status_code=302)


@router.get("/start")
async def google_start(
    limiter: LimiterDep,
    ip: IpDep,
    user_agent: UserAgentDep,
    session: SessionDep,
) -> RedirectResponse:
    """Redirect the browser to Google's consent screen.

    Returns 503 when `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are
    unset, rather than a broken redirect that surfaces as a cryptic
    `redirect_uri_mismatch` on Google's page.
    """
    limiter.check(RateLimitAction.OAUTH_START)
    settings = get_settings()
    if not settings.google_oauth_configured:
        await append_audit(
            session,
            actor_id=None,
            action=AuditAction.OAUTH_FAILURE,
            resource="google",
            ip=ip,
            user_agent=user_agent,
            extra={"reason": "not_configured"},
        )
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and "
                "GOOGLE_CLIENT_SECRET, and register GOOGLE_REDIRECT_URI in "
                "the Google Cloud console."
            ),
        )

    try:
        request = build_authorization_url()
    except OAuthError as exc:
        logger.warning("could not start Google sign-in: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google sign-in is temporarily unavailable. Try again shortly.",
        ) from exc

    return RedirectResponse(url=request.url, status_code=302)


@router.get("/callback")
async def google_callback(
    session: SessionDep,
    ip: IpDep,
    user_agent: UserAgentDep,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> RedirectResponse:
    """Redeem Google's `code`, match or create a Peapod user, mint tokens.

    Algorithm
    ---------
    1. Consume `state` (single use -- a replayed callback is login CSRF).
    2. If Google sent `error` (the user hit Cancel), bounce back.
    3. Exchange `code` + PKCE verifier for an ID token.
    4. Verify the ID token against Google's JWKS (signature, aud, iss,
       nonce, email_verified).
    5. Match `oauth_identities (google, sub)`. On a hit, that is the user.
    6. Otherwise match `auth_credentials.email`. On a hit, LINK the
       Google identity to the existing account -- we only do this because
       Google asserted `email_verified`. Matching on unverified email is
       how you hand a victim's account to an attacker who created a
       Google account claiming the same address.
    7. Otherwise create profile + OAuth-only credential (password_hash
       NULL) + identity, in one transaction.
    8. Redirect to `OAUTH_SUCCESS_REDIRECT_URL` with tokens in the fragment.
    """
    settings = get_settings()

    if not state:
        return _client_error_redirect("sign_in_failed")

    try:
        pending = consume_state(state)
    except OAuthError:
        await append_audit(
            session,
            actor_id=None,
            action=AuditAction.OAUTH_FAILURE,
            resource="google",
            ip=ip,
            user_agent=user_agent,
            extra={"reason": "bad_state"},
        )
        await session.commit()
        return _client_error_redirect("sign_in_failed")

    if error or not code:
        # User cancelled, or Google bounced us without a code. State is
        # already spent, so a later crafted callback cannot reuse it.
        return _client_error_redirect(error or "sign_in_failed")

    try:
        id_token = await exchange_code(code, pending.code_verifier)
        identity = await verify_id_token(id_token, pending.nonce)
    except OAuthError as exc:
        logger.warning("Google token exchange/verify failed: %s", exc)
        await append_audit(
            session,
            actor_id=None,
            action=AuditAction.OAUTH_FAILURE,
            resource="google",
            ip=ip,
            user_agent=user_agent,
            extra={"reason": "verify_failed"},
        )
        await session.commit()
        return _client_error_redirect("sign_in_failed")

    now = utcnow()
    existing_identity = (
        await session.execute(
            select(OAuthIdentity).where(
                OAuthIdentity.provider == _GOOGLE_PROVIDER,
                OAuthIdentity.provider_subject == identity.subject,
            )
        )
    ).scalar_one_or_none()

    linked = False
    if existing_identity is not None:
        existing_identity.last_login_at = now
        user_id = existing_identity.user_id
        profile = (
            await session.execute(select(UserProfile).where(UserProfile.id == user_id))
        ).scalar_one_or_none()
        if profile is None:
            await session.commit()
            return _client_error_redirect("sign_in_failed")
    else:
        credential = (
            await session.execute(
                select(AuthCredential).where(AuthCredential.email == identity.email)
            )
        ).scalar_one_or_none()

        if credential is not None:
            # Link. Google asserted email_verified (verify_id_token refuses
            # otherwise), so this is the same person, not an account takeover.
            user_id = credential.user_id
            credential.email_verified = True
            credential.updated_at = now
            session.add(
                OAuthIdentity(
                    provider=_GOOGLE_PROVIDER,
                    provider_subject=identity.subject,
                    user_id=user_id,
                    provider_email=identity.email,
                    last_login_at=now,
                )
            )
            profile = (
                await session.execute(select(UserProfile).where(UserProfile.id == user_id))
            ).scalar_one_or_none()
            if profile is None:
                await session.commit()
                return _client_error_redirect("sign_in_failed")
            linked = True
        else:
            user_id = uuid.uuid4()
            display_name = (identity.display_name or identity.email.split("@", 1)[0])[:120]
            profile = UserProfile(
                id=user_id,
                email=identity.email,
                display_name=display_name,
                avatar_url=identity.picture,
                permissions_granted=False,
                role="user",
                created_at=now,
                updated_at=now,
                created_by_id=user_id,
            )
            credential = AuthCredential(
                user_id=user_id,
                email=identity.email,
                password_hash=None,
                email_verified=True,
                failed_attempt_count=0,
                locked_until=None,
                created_at=now,
                updated_at=now,
            )
            session.add(profile)
            session.add(credential)
            session.add(
                OAuthIdentity(
                    provider=_GOOGLE_PROVIDER,
                    provider_subject=identity.subject,
                    user_id=user_id,
                    provider_email=identity.email,
                    last_login_at=now,
                )
            )
            try:
                await session.flush()
            except IntegrityError:
                await session.rollback()
                return _client_error_redirect("sign_in_failed")
            linked = True

    tokens = await issue_session_tokens(session, profile, ip=ip, user_agent=user_agent)
    await append_audit(
        session,
        actor_id=profile.id,
        action=AuditAction.OAUTH_LINK if linked else AuditAction.OAUTH_LOGIN,
        resource=f"user:{profile.id}",
        ip=ip,
        user_agent=user_agent,
        extra={"provider": _GOOGLE_PROVIDER},
    )
    await session.commit()

    fragment = urlencode(
        {
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "token_type": "bearer",
            "expires_in": str(tokens.expires_in),
        }
    )
    return RedirectResponse(
        url=f"{settings.OAUTH_SUCCESS_REDIRECT_URL}#{fragment}",
        status_code=302,
    )
