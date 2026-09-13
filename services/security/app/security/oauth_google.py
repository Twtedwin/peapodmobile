"""
MODULE: app.security.oauth_google

PURPOSE
    Implement Google sign-in as an OAuth 2.0 / OpenID Connect
    AUTHORIZATION-CODE flow with PKCE, and verify the resulting ID token
    against Google's published signing keys.

INPUTS  : an inbound `code` + `state` from Google's redirect
OUTPUTS : a verified `GoogleIdentity` (provider subject + email) for
          `app/routes/oauth.py` to match against `oauth_identities`

CALLED BY
    `app/routes/oauth.py` only:
        GET /auth/oauth/google/start     -> build_authorization_url()
        GET /auth/oauth/google/callback  -> consume_state(), exchange_code(),
                                            verify_id_token()
    `Login.jsx` / `Register.jsx` reach the start endpoint via
    "Continue with Google".

=============================================================================
WHY THE AUTHORIZATION-CODE FLOW AND NOT THE IMPLICIT FLOW
=============================================================================
The implicit flow returns tokens directly in the browser's URL fragment, where
they land in browser history, in `Referer` headers, and in any analytics
script on the page. The authorization-code flow returns only a short-lived,
single-use `code`; the actual tokens are fetched by THIS SERVER over a direct
TLS connection to Google, using the client secret. The tokens never touch the
user's browser. The implicit flow is deprecated for exactly this reason.

=============================================================================
THE THREE ANTI-FORGERY MECHANISMS, AND WHAT EACH ONE STOPS
=============================================================================
`state` -- an unguessable value we generate, hand to Google, and require back.
    THREAT: login CSRF. An attacker completes a Google login as themselves,
    intercepts the redirect, and then tricks a victim's browser into visiting
    that callback URL. Without `state`, the victim's Peapod session silently
    becomes the attacker's Google account -- and anything the victim then saves
    goes into the attacker's pod. Because we only accept a `state` value this
    server generated and has not yet consumed, a replayed or attacker-authored
    callback is rejected.

`code_verifier` / `code_challenge` (PKCE, RFC 7636)
    THREAT: authorization-code interception. On mobile, the redirect travels
    through the OS (a custom scheme or an app link) and can be observed by
    another app. PKCE means the `code` alone is useless: redemption also
    requires the random `code_verifier`, which never left this server -- only
    its SHA-256 hash (`code_challenge`) went to Google. PKCE is mandatory for
    public clients and recommended for confidential ones like this.

`nonce`
    THREAT: ID-token replay. An ID token obtained in some other session is
    injected here. We embed a random `nonce` in the authorization request and
    require the returned ID token to carry the same value. Strictly speaking
    the code flow already makes this hard (the ID token arrives over our own
    TLS connection to Google, not via the browser), but it is one line and it
    turns "hard" into "impossible".

=============================================================================
KNOWN LIMITATION: PENDING FLOWS ARE HELD IN MEMORY
=============================================================================
`state -> (code_verifier, nonce)` must survive between the two requests. It is
kept in a process-local dictionary with a TTL, which means:
    * With multiple workers, the callback must land on the same worker that
      served /start, or the state lookup fails and the user sees a generic
      "sign-in could not be completed" error (they simply retry).
    * A restart mid-flow has the same effect.
Acceptable because the window is seconds to a minute and the failure mode is a
retry, not a security hole (failing closed). Moving this to Redis, or to a
signed, encrypted cookie, is the documented production follow-up in
SETUP-EXTERNAL-APIS.md.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from app.config import get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Google endpoints
# ---------------------------------------------------------------------------
# Hard-coded rather than discovered from
# https://accounts.google.com/.well-known/openid-configuration at runtime:
# discovery adds a network dependency to every sign-in, and these URLs have
# been stable for a decade. If Google ever moves them, this is the one place to
# change (and SETUP-EXTERNAL-APIS.md points here).
GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs"

# Google signs ID tokens with one of two `iss` spellings, both legitimate.
# Checked explicitly because PyJWT's `issuer=` option accepts only a single
# string.
GOOGLE_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})

# The minimum scopes needed to create a Peapod profile: an account identifier
# and an email address. We deliberately do NOT request calendar, contacts, or
# anything else -- every extra scope is a bigger consent screen, a bigger
# breach if our client secret leaks, and data we would then be responsible for.
GOOGLE_SCOPES = ("openid", "email", "profile")

# Seconds a /start flow may sit unfinished before its state is discarded.
# Long enough for a slow consent screen and a password re-entry, short enough
# that abandoned flows do not accumulate.
PENDING_FLOW_TTL_SECONDS = 600

# THREAT: unbounded memory growth from someone hammering /start. Combined with
# the OAUTH_START rate-limit budget this bounds the dictionary; on overflow we
# refuse to start new flows rather than evict live ones (a legitimate user
# mid-consent must not lose their state because an attacker spammed /start).
MAX_PENDING_FLOWS = 10_000

# How long a fetched JWKS is trusted before refetching, in SECONDS. Google
# rotates its signing keys roughly daily and publishes the new key well before
# using it, so an hour of caching is safe and saves a network round trip on
# every sign-in. On a `kid` we do not recognise we refetch immediately
# regardless of this TTL, which is what actually handles rotation; the TTL is
# just background hygiene.
JWKS_CACHE_TTL_SECONDS = 3600

# Every outbound call gets a timeout. Without one, a hung Google endpoint pins
# a worker until the OS gives up (minutes), and enough of those take the whole
# service down -- an availability bug caused by someone else's outage.
HTTP_TIMEOUT_SECONDS = 10.0

# Clock-skew allowance when validating the ID token's `exp`/`iat`, in SECONDS.
# Our clock and Google's can differ by a second or two.
ID_TOKEN_LEEWAY_SECONDS = 30


class OAuthError(Exception):
    """Any failure in the Google flow.

    Routes translate this into one generic user-facing error. The message is
    for our logs: telling the caller "the ID token audience did not match"
    helps an attacker probe our configuration and helps a real user not at all.
    """


@dataclass(frozen=True, slots=True)
class PendingFlow:
    """Server-side state for one in-progress sign-in."""

    code_verifier: str
    nonce: str
    created_at: float
    """`time.monotonic()` at creation -- monotonic so an NTP step cannot make a
    flow look expired or eternal."""


@dataclass(frozen=True, slots=True)
class AuthorizationRequest:
    """What `/auth/oauth/google/start` needs to redirect the browser."""

    url: str
    state: str


@dataclass(frozen=True, slots=True)
class GoogleIdentity:
    """A verified identity asserted by Google.

    Attributes
    ----------
    subject:
        Google's `sub` claim -- an opaque, immutable, per-account identifier.
        THIS is what `oauth_identities.provider_subject` stores and what we
        match on. Never match on email: Google Workspace addresses get
        reassigned, so matching on email would eventually hand one person's
        Peapod account to whoever inherits their old address.
    email:
        Lowercased address from the token.
    email_verified:
        Google's assertion that it verified the address. We refuse to
        auto-link an account when this is false; otherwise someone could
        create a Google account claiming a victim's email and use it to take
        over the matching Peapod account.
    display_name, picture:
        Optional profile hints used to seed `users.display_name` /
        `users.avatar_url`.
    """

    subject: str
    email: str
    email_verified: bool
    display_name: str | None
    picture: str | None


# ---------------------------------------------------------------------------
# Pending flow store
# ---------------------------------------------------------------------------

_pending_flows: dict[str, PendingFlow] = {}

# Cached JWKS: `kid -> JWK dict`, plus when it was fetched.
_jwks_cache: dict[str, dict[str, Any]] = {}
_jwks_fetched_at: float = 0.0


def _prune_pending(now: float) -> None:
    """Delete expired pending flows. Cheap and called on every access."""
    stale = [
        state
        for state, flow in _pending_flows.items()
        if now - flow.created_at > PENDING_FLOW_TTL_SECONDS
    ]
    for state in stale:
        del _pending_flows[state]


def build_authorization_url() -> AuthorizationRequest:
    """Create a Google consent URL and remember the matching PKCE state.

    Returns
    -------
    `AuthorizationRequest` with the absolute URL to redirect the browser to and
    the `state` value that must come back.

    Raises
    ------
    OAuthError
        If Google credentials are not configured, or if too many flows are
        already pending.

    Algorithm
    ---------
    1. `state`: 32 random bytes, URL-safe. Unguessable, so only a callback we
       initiated can be honoured.
    2. `code_verifier`: 64 random bytes -> ~86 URL-safe characters, inside
       RFC 7636's 43-128 character range. (Longer than the 43-character
       minimum for no reason other than that it is free.)
    3. `code_challenge`: BASE64URL(SHA256(code_verifier)), '=' padding
       stripped -- RFC 7636 requires unpadded base64url. `code_challenge_method
       =S256`; the alternative, `plain`, sends the verifier itself and provides
       no protection at all.
    4. `nonce`: 16 random bytes, echoed in the ID token.
    5. Store `(code_verifier, nonce)` under `state`; only the CHALLENGE goes to
       Google.
    6. Assemble the query string. `access_type=offline` is intentionally
       omitted: we do not want a Google refresh token, because we never call
       Google APIs on the user's behalf after sign-in. Asking for credentials
       you will not use is a liability. `prompt=select_account` makes account
       switching possible on a shared device.
    """
    settings = get_settings()
    if not settings.google_oauth_configured:
        raise OAuthError("Google sign-in is not configured (GOOGLE_CLIENT_ID/SECRET missing)")

    now = time.monotonic()
    _prune_pending(now)
    if len(_pending_flows) >= MAX_PENDING_FLOWS:
        raise OAuthError("too many sign-in flows in progress")

    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)
    nonce = secrets.token_urlsafe(16)
    _pending_flows[state] = PendingFlow(
        code_verifier=code_verifier, nonce=nonce, created_at=now
    )

    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("ascii")).digest())
        .decode("ascii")
        .rstrip("=")
    )

    query = urllib.parse.urlencode(
        {
            "client_id": settings.GOOGLE_CLIENT_ID or "",
            "redirect_uri": settings.GOOGLE_REDIRECT_URI,
            "response_type": "code",
            "scope": " ".join(GOOGLE_SCOPES),
            "state": state,
            "nonce": nonce,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "prompt": "select_account",
        }
    )
    return AuthorizationRequest(url=f"{GOOGLE_AUTHORIZATION_ENDPOINT}?{query}", state=state)


def consume_state(state: str) -> PendingFlow:
    """Look up and REMOVE the pending flow for `state`.

    Parameters
    ----------
    state:
        The value Google echoed back on the callback.

    Returns
    -------
    The stored `PendingFlow`.

    Raises
    ------
    OAuthError
        Unknown, already used, or expired state.

    Single use is the point: `pop` means a callback URL cannot be replayed,
    even within the TTL. A replayable callback is a login-CSRF primitive.
    """
    now = time.monotonic()
    _prune_pending(now)
    flow = _pending_flows.pop(state, None)
    if flow is None:
        raise OAuthError("unknown or expired OAuth state")
    return flow


def reset_pending_flows() -> None:
    """Drop all pending flows. For tests and for graceful shutdown."""
    _pending_flows.clear()


# ---------------------------------------------------------------------------
# Code exchange
# ---------------------------------------------------------------------------


async def exchange_code(code: str, code_verifier: str) -> str:
    """Redeem an authorization code for an ID token.

    Parameters
    ----------
    code:
        The single-use `code` query parameter from Google's redirect.
    code_verifier:
        The PKCE verifier stored against the flow's `state`.

    Returns
    -------
    The raw, still-UNVERIFIED `id_token` (a JWT). Pass it to
    `verify_id_token`; nothing in it may be trusted before that.

    Raises
    ------
    OAuthError
        Network failure, non-2xx from Google, or a response with no `id_token`.

    Notes
    -----
    * The request is form-encoded (`application/x-www-form-urlencoded`), as the
      OAuth 2.0 token endpoint requires; a JSON body is rejected by Google.
    * `redirect_uri` is sent again even though no redirect happens here. Google
      requires it to match the value from the authorization request; it is an
      additional binding between the two legs of the flow.
    * The access token Google also returns is deliberately discarded. We do not
      call Google APIs, so holding it would be a liability with no benefit.
    * Nothing from this response is logged. The body contains bearer tokens.
    """
    settings = get_settings()
    if settings.GOOGLE_CLIENT_SECRET is None or not settings.GOOGLE_CLIENT_ID:
        raise OAuthError("Google sign-in is not configured")

    payload = {
        "code": code,
        "client_id": settings.GOOGLE_CLIENT_ID,
        "client_secret": settings.GOOGLE_CLIENT_SECRET.get_secret_value(),
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
        "grant_type": "authorization_code",
        "code_verifier": code_verifier,
    }

    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = await client.post(GOOGLE_TOKEN_ENDPOINT, data=payload)
    except httpx.HTTPError as exc:
        raise OAuthError(f"could not reach Google's token endpoint: {exc!r}") from exc

    if response.status_code != httpx.codes.OK:
        # Log the status only. The body of a failed token exchange can echo
        # request parameters, which include the client secret.
        raise OAuthError(f"Google token endpoint returned HTTP {response.status_code}")

    try:
        body: dict[str, Any] = response.json()
    except ValueError as exc:
        raise OAuthError("Google token endpoint returned a non-JSON body") from exc

    id_token = body.get("id_token")
    if not isinstance(id_token, str) or not id_token:
        raise OAuthError("Google token response contained no id_token")
    return id_token


# ---------------------------------------------------------------------------
# ID token verification
# ---------------------------------------------------------------------------


async def _fetch_jwks(force: bool = False) -> dict[str, dict[str, Any]]:
    """Return Google's signing keys as `{kid: jwk}`, using a cached copy.

    Parameters
    ----------
    force:
        Refetch even if the cache is fresh. Used when a token names a `kid` we
        have never seen, which is exactly what happens when Google rotates.

    Returns
    -------
    A dict of key id to JWK.

    Raises
    ------
    OAuthError
        If Google's JWKS cannot be fetched and no cached copy exists.

    On failure with a warm cache we keep serving from cache and log a warning:
    a JWKS blip should not break sign-in when we hold keys that still verify.
    """
    global _jwks_cache, _jwks_fetched_at
    now = time.monotonic()
    if not force and _jwks_cache and (now - _jwks_fetched_at) < JWKS_CACHE_TTL_SECONDS:
        return _jwks_cache

    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = await client.get(GOOGLE_JWKS_URI)
            response.raise_for_status()
            document: dict[str, Any] = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        if _jwks_cache:
            logger.warning("could not refresh Google JWKS (%r); using cached keys", exc)
            return _jwks_cache
        raise OAuthError(f"could not fetch Google's JWKS: {exc!r}") from exc

    keys = {
        str(key["kid"]): key
        for key in document.get("keys", [])
        if isinstance(key, dict) and key.get("kid")
    }
    if not keys:
        if _jwks_cache:
            return _jwks_cache
        raise OAuthError("Google's JWKS contained no usable keys")

    _jwks_cache = keys
    _jwks_fetched_at = now
    logger.info("cached %d Google signing key(s)", len(keys))
    return _jwks_cache


def reset_jwks_cache() -> None:
    """Clear the cached JWKS. For tests."""
    global _jwks_cache, _jwks_fetched_at
    _jwks_cache = {}
    _jwks_fetched_at = 0.0


async def verify_id_token(id_token: str, expected_nonce: str) -> GoogleIdentity:
    """Fully verify a Google ID token and extract the identity it asserts.

    Parameters
    ----------
    id_token:
        The raw JWT from `exchange_code`.
    expected_nonce:
        The nonce stored with the flow's `state`.

    Returns
    -------
    A `GoogleIdentity`.

    Raises
    ------
    OAuthError
        On any verification failure. Deliberately one exception type: the
        caller returns a single generic error.

    Algorithm
    ---------
    1. Read `kid` from the token's UNVERIFIED header. This is the one piece of
       unverified data we act on, and it is safe because it only SELECTS a
       candidate key -- an attacker naming a different `kid` gets a key their
       token was not signed with, and verification fails.
    2. Look up that `kid` in the cached JWKS; on a miss, refetch once (key
       rotation) and look again.
    3. Convert the JWK to a public key object and verify the signature with
       `algorithms=["RS256"]` -- an explicit allow-list, never the token's own
       `alg`. Accepting the token's `alg` allows `alg: none` and the
       RS256->HS256 confusion attack where the public key is used as an HMAC
       secret.
    4. Verify `aud` == our `GOOGLE_CLIENT_ID`. THIS IS ESSENTIAL: Google will
       happily issue a valid, correctly-signed ID token to *any* developer's
       OAuth client. Without an audience check, an attacker mints a token for
       their own app, presents it here, and we accept it as proof of identity
       for whatever `sub` they control.
    5. Verify `iss` is one of Google's two spellings.
    6. Verify `nonce` matches, and that the required claims are present.
    7. Require `email_verified`, then return the identity.
    """
    settings = get_settings()
    if not settings.GOOGLE_CLIENT_ID:
        raise OAuthError("Google sign-in is not configured")

    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.InvalidTokenError as exc:
        raise OAuthError("Google ID token is malformed") from exc

    kid = header.get("kid")
    if not kid:
        raise OAuthError("Google ID token has no key id")

    keys = await _fetch_jwks()
    jwk = keys.get(str(kid))
    if jwk is None:
        # Rotation: Google started signing with a key we have not seen.
        keys = await _fetch_jwks(force=True)
        jwk = keys.get(str(kid))
    if jwk is None:
        raise OAuthError("Google ID token was signed with an unknown key")

    try:
        public_key = RSAAlgorithm.from_jwk(json.dumps(jwk))
    except (ValueError, TypeError, KeyError) as exc:
        raise OAuthError("could not parse Google's signing key") from exc

    try:
        claims: dict[str, Any] = jwt.decode(
            id_token,
            public_key,  # type: ignore[arg-type]
            algorithms=["RS256"],
            audience=settings.GOOGLE_CLIENT_ID,
            leeway=ID_TOKEN_LEEWAY_SECONDS,
            options={
                "require": ["iss", "sub", "aud", "exp", "iat"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_aud": True,
            },
        )
    except jwt.InvalidTokenError as exc:
        raise OAuthError(f"Google ID token failed verification: {type(exc).__name__}") from exc

    if str(claims.get("iss")) not in GOOGLE_ISSUERS:
        raise OAuthError("Google ID token has an unexpected issuer")

    # Constant-time comparison: the nonce is a secret we generated, and a
    # byte-by-byte early exit would leak it to an attacker who can retry.
    token_nonce = str(claims.get("nonce", ""))
    if not secrets.compare_digest(token_nonce, expected_nonce):
        raise OAuthError("Google ID token nonce did not match the sign-in request")

    subject = str(claims.get("sub", ""))
    email = str(claims.get("email", "")).strip().lower()
    email_verified = bool(claims.get("email_verified", False))
    if not subject:
        raise OAuthError("Google ID token has no subject")
    if not email:
        raise OAuthError("Google ID token carried no email address")
    if not email_verified:
        # Refusing here is what stops "create a Google account claiming
        # victim@example.com, then sign in to their Peapod account".
        raise OAuthError("Google has not verified this email address")

    display_name = claims.get("name")
    picture = claims.get("picture")
    return GoogleIdentity(
        subject=subject,
        email=email,
        email_verified=True,
        display_name=str(display_name) if display_name else None,
        picture=str(picture) if picture else None,
    )
