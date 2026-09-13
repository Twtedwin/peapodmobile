"""
MODULE: app.schemas

PURPOSE
    Pydantic v2 request/response models for every public and internal HTTP
    body this service accepts or returns. Validation lives here so a bad
    payload is a 422 with a field-level message, not a 500 from a hasher or
    a silent truncation.

INPUTS  : raw JSON from FastAPI
OUTPUTS : typed, normalised models the route handlers can trust

CALLED BY
    `app/routes/auth.py`, `app/routes/oauth.py`, `app/routes/internal.py`.

WHY THE PASSWORD FLOOR IS 10 CHARACTERS
    NIST SP 800-63B recommends a *minimum* of 8 characters and explicitly
    advises AGAINST composition rules (uppercase + digit + punctuation). Those
    rules produce `Password1!` -- short, predictable, and written on stickies.
    We sit 2 characters above the NIST floor: 10 is still demo-friendly (a
    short passphrase, a generated password, anything a mobile keyboard can
    type without a manager) while cutting off the most common 6-8 character
    dictionary passwords. Length is the only complexity we enforce; the
    Argon2id parameters in `app/security/passwords.py` do the rest.

    A mechanical byte cap (`MAX_PASSWORD_BYTES` = 1024) is enforced at hash
    time to bound CPU/memory; the Pydantic `max_length` below is characters
    and exists so the client gets a 422 instead of a 500.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator
from email_validator import EmailNotValidError, validate_email

from app.models import OtpPurpose
from app.security.otp import OTP_DIGITS

# ---------------------------------------------------------------------------
# Password policy
# ---------------------------------------------------------------------------

#: See the module docstring. Unit: Unicode characters (not bytes).
MIN_PASSWORD_LENGTH = 10

#: Matches `passwords.MAX_PASSWORD_BYTES` in spirit; Pydantic counts characters.
#: A 1024-character password is already past any real passphrase.
MAX_PASSWORD_LENGTH = 1024

# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------
#
# Pydantic's EmailStr uses email-validator, which rejects reserved names
# such as `.local`. The demo seed uses `alex@peapod.local` so a laptop never
# accidentally mails a real inbox. We still run the library for syntax, then
# accept that one reserved-TLD case.


def _parse_email(value: object) -> str:
    """Lowercase and syntax-check an email; allow `.local` / `.test` demo domains."""
    if not isinstance(value, str):
        raise TypeError("email must be a string")
    text = value.strip().lower()
    try:
        return validate_email(text, check_deliverability=False).normalized
    except EmailNotValidError as exc:
        message = str(exc)
        if "special-use or reserved name" in message:
            local, sep, domain = text.partition("@")
            if sep and local and "." in domain and " " not in text:
                return text
        raise ValueError(message) from exc


EmailAddress = Annotated[str, AfterValidator(_parse_email)]


class _ForbidExtra(BaseModel):
    """Reject unknown fields so a mistyped client key is a 422, not a silent drop."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


# ---------------------------------------------------------------------------
# Shared fragments
# ---------------------------------------------------------------------------


class UserPublic(BaseModel):
    """The profile fields a client is allowed to see. Never a hash, never a token."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    display_name: str
    avatar_url: str | None = None
    permissions_granted: bool
    role: Literal["admin", "user"]
    created_at: datetime
    updated_at: datetime
    created_by_id: uuid.UUID


class TokenResponse(BaseModel):
    """Access + refresh pair returned on login, OTP verify, and refresh.

    `token_type` is the OAuth-style hint the client puts in the
    `Authorization` header (`Bearer <access_token>`). `expires_in` is
    SECONDS until the *access* token dies, so the client can refresh
    proactively instead of waiting for a 401.
    """

    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: UserPublic | None = None


# ---------------------------------------------------------------------------
# Auth requests
# ---------------------------------------------------------------------------


class RegisterRequest(_ForbidExtra):
    """`POST /auth/register` body."""

    email: EmailAddress
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)
    display_name: str = Field(min_length=1, max_length=120)

    @field_validator("email", mode="before")
    @classmethod
    def _lower_email(cls, value: object) -> object:
        """Normalise before EmailStr runs, so `Sam@X.com` and `sam@x.com` collide."""
        return value.strip().lower() if isinstance(value, str) else value


class VerifyOtpRequest(_ForbidExtra):
    """`POST /auth/verify-otp` body."""

    email: EmailAddress
    code: str = Field(pattern=rf"^\d{{{OTP_DIGITS}}}$")
    purpose: OtpPurpose

    @field_validator("email", mode="before")
    @classmethod
    def _lower_email(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value


class ResendOtpRequest(_ForbidExtra):
    """`POST /auth/resend-otp` body."""

    email: EmailAddress
    purpose: OtpPurpose

    @field_validator("email", mode="before")
    @classmethod
    def _lower_email(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value


class LoginRequest(_ForbidExtra):
    """`POST /auth/login` body."""

    email: EmailAddress
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)

    @field_validator("email", mode="before")
    @classmethod
    def _lower_email(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value


class RefreshRequest(_ForbidExtra):
    """`POST /auth/refresh` body."""

    refresh_token: str = Field(min_length=1, max_length=128)


class LogoutRequest(_ForbidExtra):
    """`POST /auth/logout` body."""

    refresh_token: str = Field(min_length=1, max_length=128)


class ForgotPasswordRequest(_ForbidExtra):
    """`POST /auth/forgot-password` body."""

    email: EmailAddress

    @field_validator("email", mode="before")
    @classmethod
    def _lower_email(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value


class ResetPasswordRequest(_ForbidExtra):
    """`POST /auth/reset-password` body."""

    token: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)


class PatchMeRequest(_ForbidExtra):
    """`PATCH /auth/me` body. Every field is optional; omitted means "leave alone"."""

    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    avatar_url: str | None = Field(default=None, max_length=2048)
    permissions_granted: bool | None = None


class DeleteAccountRequest(_ForbidExtra):
    """`POST /auth/delete-account` body. Password re-confirms the session."""

    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


# ---------------------------------------------------------------------------
# Small auth responses
# ---------------------------------------------------------------------------


class RegisterResponse(BaseModel):
    """Returned after a successful registration. Tokens wait on OTP verify."""

    user_id: uuid.UUID
    email_sent: bool


class EmailSentResponse(BaseModel):
    """Generic "we did a thing that may have sent mail" body.

    Used by resend-otp and forgot-password. The boolean is *not* a reliable
    signal of whether an account exists -- both of those routes always return
    the same shape regardless.
    """

    email_sent: bool = True


class UnverifiedLoginResponse(BaseModel):
    """Returned with HTTP 403 when the password was right but email is unverified."""

    detail: str = "email not verified"
    email_sent: bool = True


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------


class VerifyTokenRequest(_ForbidExtra):
    """`POST /internal/verify-token` body."""

    access_token: str = Field(min_length=1)


class VerifyTokenResponse(BaseModel):
    """Live principal the Node API may trust for the rest of the request."""

    user_id: uuid.UUID
    email: str
    role: Literal["admin", "user"]
    display_name: str


class AuthorizeRequest(_ForbidExtra):
    """`POST /internal/authorize` body.

    `resource` is a free-form JSON object the API already has in hand (the
    row, or the intended write). Recognised keys: `id`, `pod_id`,
    `created_by_id`, `recipient_id`, `kind`. Unknown keys are ignored so a
    schema addition on the API side does not break this service.
    """

    user_id: uuid.UUID
    action: str = Field(min_length=1, max_length=64)
    resource: dict[str, Any] | None = None


class AuthorizeResponse(BaseModel):
    """Allow/deny plus a machine-readable reason for the audit log / API logs.

    `reason` is NOT shown to end users; the API translates a denial into a
    generic 403. Spelling out "not a pod member" to the client would confirm
    that the pod exists.
    """

    allowed: bool
    reason: str
