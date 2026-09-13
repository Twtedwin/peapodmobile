"""
PACKAGE: app.security

PURPOSE
    The cryptographic and abuse-prevention primitives used by the Peapod
    security service. Nothing in here talks to HTTP; the modules are pure
    building blocks so they can be unit tested without a running server or a
    database.

MODULES
    passwords     -- Argon2id hashing, verification, and rehash-on-login.
    tokens        -- JWT access tokens + opaque, rotating refresh tokens.
    otp           -- 6-digit emailed one-time codes.
    ratelimit     -- per-IP and per-identifier request budgets.
    oauth_google  -- Google authorization-code flow with PKCE and JWKS
                     verification.

CALLED BY
    `app/routes/*` and `app/authz.py`.
"""
