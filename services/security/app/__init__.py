"""
PACKAGE: app

PURPOSE
    The Peapod security service -- the only process in the monorepo that is
    allowed to touch credentials (password hashes, OTP codes, refresh tokens,
    password-reset tokens, OAuth identities) and the only process that mints
    access tokens.

    HTTP lives in `app.routes`. Cryptographic primitives live in `app.security`.
    Authorization decisions live in `app.authz` so they exist in exactly one
    place.

CALLED BY
    * The mobile / web client, directly, for the auth screens.
    * `services/api`, over `/internal/*`, to turn a bearer token into a
      principal and to ask "may this user do this?".
"""
