"""
PACKAGE: app.routes

PURPOSE
    HTTP adapters. They parse requests, call the primitives in `app.security`
    and the decision engine in `app.authz`, and shape responses. No
    cryptographic policy lives here -- if a route needs to hash, sign, or
    compare a secret, it imports the function that already does it.

MODULES
    auth      -- public authentication surface (`/auth/*`).
    oauth     -- Google authorization-code flow (`/auth/oauth/google/*`).
    internal  -- service-to-service surface (`/internal/*`), gated by
                 `X-Internal-Token`.
"""
