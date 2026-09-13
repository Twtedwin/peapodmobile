"""
MODULE: app.config

PURPOSE
    Load, validate, and hand out this service's configuration exactly once.
    Every secret the security service holds (JWT signing key, Google OAuth
    client secret, email provider key, the service-to-service token) enters the
    process here and nowhere else.

INPUTS
    Process environment variables, optionally seeded from a `.env` file sitting
    next to the service (see `.env.example`). Nothing is read from the
    filesystem at request time.

OUTPUTS
    A cached, frozen-ish `Settings` instance via `get_settings()`.

CALLED BY
    Every other module in this service. Nothing outside `services/security`
    imports it.

DESIGN NOTES
    * Secrets are typed `SecretStr`. That is not decoration: `repr()` of a
      `SecretStr` prints `**********`, so a stray `logger.info(settings)` or a
      FastAPI validation error dump cannot spill a signing key into a log
      aggregator. Reading the real value requires an explicit
      `.get_secret_value()` call, which is easy to grep for in review.
    * `get_settings()` is lazy (`functools.lru_cache`) rather than a module
      level `settings = Settings()`. A module-level instance would make merely
      *importing* any module require a full valid environment, which breaks
      unit tests and makes import errors look like config errors.
    * Startup fails LOUDLY (raises, so the process exits non-zero and a
      container orchestrator will not route traffic to it) when a
      production-critical secret is missing or still set to a known dev
      default. A security service that boots with `JWT_SECRET=change-me` is
      worse than one that refuses to boot, because it looks healthy.
"""

from __future__ import annotations

import functools
import logging
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# services/security/app/config.py → repo root is three parents up.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_SERVICE_DIR = Path(__file__).resolve().parents[1]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Known-bad values
# ---------------------------------------------------------------------------

# THREAT: a deployment inherits the placeholder values from `.env.example` (or
# from a developer's shell) and ships to production signing tokens with a
# secret that is committed to the repository and therefore known to anyone who
# can read it. Anybody could then mint an access token for any user id with
# `role: "admin"`.
#
# Every string that appears as a placeholder anywhere in this repository must be
# listed here. Comparison is case-insensitive and whitespace-trimmed.
DEV_PLACEHOLDER_SECRETS: frozenset[str] = frozenset(
    {
        "",
        "change-me",
        "changeme",
        "dev",
        "dev-secret",
        "development",
        "insecure",
        "placeholder",
        "secret",
        "test",
        "todo",
        "xxx",
        # The exact defaults used by this module and by `.env.example`.
        "dev-only-insecure-jwt-secret-do-not-use-in-production",
        "dev-only-insecure-internal-service-token",
    }
)

# A signing secret shorter than this is brute-forceable offline once an attacker
# holds a single token: HS256 tokens are an oracle for their own key. 32 bytes
# (256 bits) matches the output size of SHA-256, which is the security ceiling
# of HMAC-SHA256 anyway, so more entropy buys nothing and less buys trouble.
MIN_SHARED_SECRET_LENGTH = 32

# The internal token is compared with `hmac.compare_digest` on every call the
# Node API makes. It is a bearer credential for a *fully privileged* surface
# (`/internal/authorize` can be asked to approve anything), so it gets the same
# minimum as the signing secret.
MIN_INTERNAL_TOKEN_LENGTH = 32


class Settings(BaseSettings):
    """Typed view over the process environment.

    Field names are UPPER_CASE so that they match the environment variable
    names one-for-one; `pydantic-settings` is case-insensitive when matching,
    but keeping them identical means a reader never has to guess whether
    `ACCESS_TOKEN_TTL_SECONDS` maps to `access_token_ttl_seconds`.

    All TTLs are in SECONDS. There is no field in this class measured in
    minutes, hours, or milliseconds -- mixed units in a token-expiry config is
    how you end up with a 30-day access token.
    """

    model_config = SettingsConfigDict(
        # Look at the monorepo root first: `uvicorn` and `seed_demo.py` run
        # with cwd `services/security`, so a bare `.env` would miss the file
        # the README tells you to copy next to docker-compose.yml.
        env_file=(
            str(_REPO_ROOT / ".env"),
            str(_REPO_ROOT / ".env.local"),
            str(_SERVICE_DIR / ".env"),
            str(_SERVICE_DIR / ".env.local"),
        ),
        env_file_encoding="utf-8",
        case_sensitive=False,
        # Ignore unrelated variables (the monorepo shares a shell with the Node
        # API and the Rust compute service, both of which export their own).
        extra="ignore",
    )

    # -- Runtime ------------------------------------------------------------
    ENVIRONMENT: Literal["development", "test", "staging", "production"] = "development"

    # -- Database -----------------------------------------------------------
    # One PostgreSQL database is shared with `services/api`. This service owns
    # the credential tables; the API owns the domain tables. See app/models.py
    # for the ownership boundary.
    DATABASE_URL: str = "postgresql+asyncpg://peapod:peapod_dev_password@localhost:5432/peapod"

    # -- Token signing ------------------------------------------------------
    # Preferred: RS256 with an asymmetric key pair. The private key never
    # leaves this service; the public key can be handed to anyone (including
    # the Node API) so they can verify a token offline without being able to
    # mint one. That asymmetry is the whole point: a compromised API process
    # cannot forge tokens.
    JWT_PRIVATE_KEY: SecretStr | None = None
    JWT_PUBLIC_KEY: str | None = None
    # Dev fallback: HS256 with a shared secret. Symmetric, so anybody who can
    # verify can also forge. Acceptable on a laptop, refused in production by
    # the validator below.
    JWT_SECRET: SecretStr = SecretStr("dev-only-insecure-jwt-secret-do-not-use-in-production")

    # `iss` and `aud` claims. Verified on every decode so that a token minted
    # for a different Peapod environment (staging) cannot be replayed against
    # production, and so a token issued for some other audience entirely
    # cannot be repurposed here.
    JWT_ISSUER: str = "peapod-security"
    JWT_AUDIENCE: str = "peapod-api"

    # 900 s = 15 minutes. Access tokens are bearer credentials that we
    # deliberately do NOT check against the database on every request (that is
    # the performance reason they exist), so the only bound on the damage from a
    # stolen one is its lifetime. 15 minutes is the usual balance point: short
    # enough that a leaked token in a log or a proxy cache is stale before it is
    # useful, long enough that a mobile client is not refreshing constantly on a
    # flaky connection.
    ACCESS_TOKEN_TTL_SECONDS: int = Field(default=900, ge=60, le=3600)

    # 2 592 000 s = 30 days. This is the "stay logged in" window for the mobile
    # app. It is safe to make it long *because* refresh tokens are opaque,
    # stored hashed, single-use, and rotated -- see app/security/tokens.py. A
    # stolen refresh token is detectable (reuse revokes the whole family) in a
    # way a stolen long-lived access token never is.
    REFRESH_TOKEN_TTL_SECONDS: int = Field(default=2_592_000, ge=3600, le=31_536_000)

    # -- Google OAuth -------------------------------------------------------
    GOOGLE_CLIENT_ID: str | None = None
    GOOGLE_CLIENT_SECRET: SecretStr | None = None
    # Must match EXACTLY (byte for byte, including trailing slash) one of the
    # redirect URIs registered in the Google Cloud console, or Google returns
    # `redirect_uri_mismatch` before the user ever sees a consent screen.
    GOOGLE_REDIRECT_URI: str = "http://localhost:8081/auth/oauth/google/callback"

    # -- Transactional email ------------------------------------------------
    EMAIL_PROVIDER_API_KEY: SecretStr | None = None
    # Provider-agnostic: any provider whose "send one email" endpoint accepts a
    # JSON body and a `Authorization: Bearer <key>` header works without a code
    # change. See app/email.py and SETUP-EXTERNAL-APIS.md.
    EMAIL_PROVIDER_API_URL: str = "https://api.resend.com/emails"
    EMAIL_FROM: str = "Peapod <no-reply@peapod.app>"

    # 600 s = 10 minutes. An email one-time code has to survive a slow mail
    # relay and a human alt-tabbing to their inbox, but every extra minute is
    # another minute in which a code sitting in an unlocked inbox (or captured
    # by a mail scanner) still works. 10 minutes is the industry norm and
    # matches the pod-invite expiry already used elsewhere in Peapod.
    OTP_TTL_SECONDS: int = Field(default=600, ge=60, le=3600)

    # 3600 s = 1 hour for password-reset links. Longer than an OTP because the
    # link is often opened on a different device (phone -> desktop) and users
    # routinely walk away mid-flow; still short enough that an old email
    # forwarded months later is inert.
    PASSWORD_RESET_TTL_SECONDS: int = Field(default=3600, ge=300, le=86_400)

    # -- Service-to-service -------------------------------------------------
    # Shared secret presented by `services/api` in the `X-Internal-Token`
    # header on every `/internal/*` call. This is the ONLY authentication on
    # that surface, so `/internal/*` must never be exposed to the public
    # internet -- keep it on the private network / inside the compose network.
    INTERNAL_SERVICE_TOKEN: SecretStr = SecretStr("dev-only-insecure-internal-service-token")

    # -- HTTP ---------------------------------------------------------------
    # Comma-separated list. The mobile app is a native client and sends no
    # Origin header, so CORS only matters for the local web build and for
    # browser-based OAuth redirects.
    CORS_ALLOW_ORIGINS: str = "http://localhost:5173,http://localhost:8081"

    # Where the password-reset email points the user. The service does not
    # render UI, so it needs to be told the client's URL. `?token=` is appended.
    PASSWORD_RESET_URL: str = "http://localhost:5173/reset-password"

    # Where the OAuth callback bounces the browser once tokens are minted. The
    # client reads the tokens from the URL fragment.
    OAUTH_SUCCESS_REDIRECT_URL: str = "http://localhost:5173/auth/callback"

    # ------------------------------------------------------------------
    # Normalisation
    # ------------------------------------------------------------------

    @field_validator("DATABASE_URL")
    @classmethod
    def _force_asyncpg_driver(cls, value: str) -> str:
        """Rewrite a plain PostgreSQL URL onto the asyncpg driver.

        Parameters
        ----------
        value:
            Anything of the form ``postgres://``, ``postgresql://`` or
            ``postgresql+asyncpg://``.

        Returns
        -------
        The same URL guaranteed to carry the ``+asyncpg`` driver suffix.

        Why
        ---
        Docker Compose, managed Postgres providers, and the Node API all hand
        out `postgresql://...`. Passing that to `create_async_engine` raises
        `InvalidRequestError: The asyncio extension requires an async driver`,
        which is an unhelpful error to debug at 3am. Rewriting it here means
        one `DATABASE_URL` value works for the Node service and this one.

        Edge cases
        ----------
        A URL that already names a *different* driver (e.g. `+psycopg`) is left
        alone -- the operator presumably meant it, and silently swapping the
        driver would be worse than the resulting error.
        """
        if value.startswith("postgres://"):
            return "postgresql+asyncpg://" + value[len("postgres://") :]
        if value.startswith("postgresql://"):
            return "postgresql+asyncpg://" + value[len("postgresql://") :]
        return value

    # ------------------------------------------------------------------
    # Derived values
    # ------------------------------------------------------------------

    @property
    def is_production(self) -> bool:
        """True for the environments that must never run on dev defaults."""
        return self.ENVIRONMENT in ("staging", "production")

    @property
    def jwt_algorithm(self) -> Literal["RS256", "HS256"]:
        """Which JWT algorithm this process will sign and verify with.

        RS256 when an asymmetric key pair is configured, otherwise the HS256
        development fallback. Note that the algorithm is decided HERE, from
        configuration, and passed explicitly to every `jwt.decode` call --
        never read from the token's own header. Trusting the header is the
        classic `alg: none` / algorithm-confusion vulnerability.
        """
        if self.JWT_PRIVATE_KEY is not None and self.JWT_PUBLIC_KEY:
            return "RS256"
        return "HS256"

    @property
    def jwt_signing_key(self) -> str:
        """The key used to SIGN access tokens (private key or shared secret)."""
        if self.jwt_algorithm == "RS256":
            # Non-None by construction of `jwt_algorithm`.
            assert self.JWT_PRIVATE_KEY is not None
            return self.JWT_PRIVATE_KEY.get_secret_value()
        return self.JWT_SECRET.get_secret_value()

    @property
    def jwt_verification_key(self) -> str:
        """The key used to VERIFY access tokens (public key or shared secret)."""
        if self.jwt_algorithm == "RS256":
            assert self.JWT_PUBLIC_KEY is not None
            return self.JWT_PUBLIC_KEY
        return self.JWT_SECRET.get_secret_value()

    @property
    def cors_allow_origins(self) -> list[str]:
        """`CORS_ALLOW_ORIGINS` split into a list, blanks removed."""
        return [origin.strip() for origin in self.CORS_ALLOW_ORIGINS.split(",") if origin.strip()]

    @property
    def google_oauth_configured(self) -> bool:
        """Whether the Google sign-in routes can do anything useful."""
        return bool(self.GOOGLE_CLIENT_ID) and self.GOOGLE_CLIENT_SECRET is not None

    @property
    def email_delivery_configured(self) -> bool:
        """False means OTP emails are printed to stdout instead of sent."""
        return self.EMAIL_PROVIDER_API_KEY is not None and bool(
            self.EMAIL_PROVIDER_API_KEY.get_secret_value().strip()
        )

    # ------------------------------------------------------------------
    # Production guard rails
    # ------------------------------------------------------------------

    @model_validator(mode="after")
    def _reject_insecure_production_config(self) -> Settings:
        """Refuse to construct a production `Settings` that is unsafe.

        Returns
        -------
        `self`, unchanged, when the configuration is acceptable.

        Raises
        ------
        ValueError
            Listing *every* problem found, not just the first, so an operator
            fixes one deployment rather than playing whack-a-mole. The message
            names the offending variable but NEVER echoes its value.

        Checks performed (production and staging only)
        ---------------------------------------------
        1. Token signing must be RS256. HS256 means the verification key is
           also the signing key, so every service that can validate a token can
           also mint one -- including a compromised Node API. Asymmetric keys
           contain the blast radius.
        2. `INTERNAL_SERVICE_TOKEN` must be present, long, and not a
           placeholder. It guards an endpoint that can authorise anything.
        3. `EMAIL_PROVIDER_API_KEY` must be present, because without it
           `app/email.py` falls back to *printing one-time codes to stdout*.
           That fallback is correct for a laptop and catastrophic in production.
        4. Google OAuth must be either fully configured or not configured; a
           half-configured client id with no secret produces a confusing
           runtime failure on the callback instead of at boot.
        5. Nothing may point at localhost, which would mean the reset-password
           and OAuth redirect emails/links are broken for real users.
        """
        if not self.is_production:
            # Development / test: warn loudly but stay usable. A developer
            # should never need to generate an RSA key pair to run tests.
            if self.jwt_algorithm == "HS256":
                logger.warning(
                    "SECURITY: signing access tokens with the HS256 development "
                    "fallback. Set JWT_PRIVATE_KEY/JWT_PUBLIC_KEY for RS256 before "
                    "deploying. (ENVIRONMENT=%s)",
                    self.ENVIRONMENT,
                )
            return self

        problems: list[str] = []

        if self.jwt_algorithm != "RS256":
            problems.append(
                "JWT_PRIVATE_KEY/JWT_PUBLIC_KEY are required in "
                f"ENVIRONMENT={self.ENVIRONMENT} (the HS256 JWT_SECRET fallback is "
                "development-only, because a symmetric key lets every verifier forge tokens)"
            )
        elif _is_placeholder(self.JWT_PRIVATE_KEY):
            problems.append("JWT_PRIVATE_KEY is empty or a known placeholder value")

        internal = self.INTERNAL_SERVICE_TOKEN.get_secret_value()
        if _is_placeholder(self.INTERNAL_SERVICE_TOKEN):
            problems.append("INTERNAL_SERVICE_TOKEN is unset or a known placeholder value")
        elif len(internal) < MIN_INTERNAL_TOKEN_LENGTH:
            problems.append(
                f"INTERNAL_SERVICE_TOKEN is shorter than {MIN_INTERNAL_TOKEN_LENGTH} characters"
            )

        if not self.email_delivery_configured:
            problems.append(
                "EMAIL_PROVIDER_API_KEY is unset, which would activate the development "
                "email fallback that PRINTS ONE-TIME CODES TO STDOUT"
            )

        if bool(self.GOOGLE_CLIENT_ID) != (self.GOOGLE_CLIENT_SECRET is not None):
            problems.append(
                "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together "
                "(or both left unset to disable Google sign-in)"
            )

        for name in ("GOOGLE_REDIRECT_URI", "PASSWORD_RESET_URL", "OAUTH_SUCCESS_REDIRECT_URL"):
            value = getattr(self, name)
            if isinstance(value, str) and ("localhost" in value or "127.0.0.1" in value):
                problems.append(f"{name} still points at localhost")

        if problems:
            raise ValueError(
                "Refusing to start the Peapod security service with an insecure "
                f"configuration (ENVIRONMENT={self.ENVIRONMENT}):\n  - "
                + "\n  - ".join(problems)
            )
        return self


def _is_placeholder(secret: SecretStr | None) -> bool:
    """Whether a secret is absent, blank, too short, or a known dev default.

    Parameters
    ----------
    secret:
        The value to inspect. `None` counts as a placeholder.

    Returns
    -------
    True if the value must not be used in production.

    Note
    ----
    This is a *configuration* check run once at startup against values the
    operator supplied, not a check against attacker-supplied input, so plain
    `in` / `<` comparisons are fine here. Constant-time comparison matters when
    comparing a submitted credential against a stored one; see
    `app/routes/internal.py`.
    """
    if secret is None:
        return True
    raw = secret.get_secret_value().strip()
    if raw.lower() in DEV_PLACEHOLDER_SECRETS:
        return True
    # A PEM private key is long; a shared secret must be at least this long.
    return len(raw) < MIN_SHARED_SECRET_LENGTH


@functools.lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide `Settings`, constructing it on first use.

    Returns
    -------
    The cached `Settings` instance.

    Raises
    ------
    pydantic.ValidationError
        If the environment is malformed (e.g. a non-numeric TTL) or, in
        production, insecure. Allowed to propagate: an unstartable security
        service is the correct outcome, and uvicorn will exit non-zero.

    Testing
    -------
    Tests mutate `os.environ` and then call `get_settings.cache_clear()` to
    pick up the change. See `tests/conftest.py`.
    """
    return Settings()
