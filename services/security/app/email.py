"""
MODULE: app.email

PURPOSE
    Send the two kinds of transactional mail this service produces:

      * a six-digit one-time code (registration / unverified-login), and
      * a password-reset link carrying an opaque token.

    The interface is provider-agnostic: any vendor whose "send one email"
    endpoint accepts a JSON body and `Authorization: Bearer <key>` works
    without a code change. Wiring a real vendor (Resend, Postmark, SES via a
    thin proxy) is documented in SETUP-EXTERNAL-APIS.md.

INPUTS  : destination address, and either a plaintext OTP or a reset token
OUTPUTS : True if the provider (or the development fallback) accepted the mail

CALLED BY
    `app/routes/auth.py` only. Never called by `services/api`.

=============================================================================
THE DEVELOPMENT FALLBACK -- READ THIS BEFORE TOUCHING THE LOG LINES
=============================================================================
When `EMAIL_PROVIDER_API_KEY` is unset, this module PRINTS the message to
stdout under a loud `DEV EMAIL FALLBACK` banner, including the OTP / reset
token. That is the only path in the entire service that is allowed to emit a
one-time code. The production boot check in `app/config.py` refuses to start
if this fallback would be active in staging/production, because printing
codes to container logs is how they end up in a log aggregator, a support
ticket, and then somebody else's inbox.

The production send path logs destination, HTTP status, and the provider
response body (Resend's `{id}` or a 4xx JSON error). NEVER the OTP or
reset token, and never the API key.
"""

from __future__ import annotations

import logging

import httpx

from app.config import Settings, get_settings
from app.models import OtpPurpose

logger = logging.getLogger(__name__)

# Seconds an outbound send may block a worker. A hung provider must not pin
# the whole process; the caller treats a timeout as "email_sent = False" and
# the user can tap Resend.
HTTP_TIMEOUT_SECONDS = 10.0

# Banner width in characters. Wide enough to be unmissable in `docker logs`.
_FALLBACK_BANNER_WIDTH = 72


class EmailDeliveryError(Exception):
    """The provider rejected the send, or the network failed.

    Routes catch this and report `email_sent=False` rather than failing the
    surrounding auth operation: a down mail vendor must not roll back a
    completed registration.
    """


def _purpose_copy(purpose: OtpPurpose) -> tuple[str, str]:
    """Return `(subject, body_intro)` for an OTP mail.

    Parameters
    ----------
    purpose:
        Why the code was issued. The wording differs so a registration code
        cannot be mistaken for a login code if both land in the same inbox
        (they also cannot be *used* interchangeably -- purpose is stored on
        the row -- but the email should still say the right thing).
    """
    if purpose is OtpPurpose.REGISTER:
        return (
            "Your Peapod verification code",
            "Use this code to finish creating your Peapod account.",
        )
    if purpose is OtpPurpose.LOGIN:
        return (
            "Your Peapod sign-in code",
            "Use this code to verify your email and finish signing in.",
        )
    return (
        "Your Peapod reset code",
        "Use this code to continue resetting your Peapod password.",
    )


def _print_dev_fallback(to: str, subject: str, body: str) -> None:
    """Print a mail to stdout. THE ONLY PLACE a code may be emitted.

    Parameters
    ----------
    to, subject, body:
        Fully rendered message. `body` contains the secret (OTP or token).

    Why print and not logger.info
    -----------------------------
    A production log shipper is often level=INFO. Putting the code on an
    info line would mean that if an operator ever *did* boot with the
    fallback in a real environment (they cannot, today -- config refuses),
    the code would be indexed. `print` goes to stdout as a last-resort
    developer affordance and is wrapped in a banner nobody can miss.
    """
    bar = "=" * _FALLBACK_BANNER_WIDTH
    try:
        print(bar, flush=True)
        print("DEV EMAIL FALLBACK -- EMAIL_PROVIDER_API_KEY is unset.", flush=True)
        print("This path is development-only. Production refuses to boot without a key.", flush=True)
        print(f"To: {to}", flush=True)
        print(f"Subject: {subject}", flush=True)
        print(bar, flush=True)
        print(body, flush=True)
        print(bar, flush=True)
    except UnicodeEncodeError:
        # Windows consoles are often cp1252; a failed print must never 500 register.
        logger.warning("DEV EMAIL FALLBACK print failed (encoding) for destination=%s", to)
        return
    logger.warning("DEV EMAIL FALLBACK used for destination=%s (secret not logged)", to)


async def _deliver(
    *,
    to: str,
    subject: str,
    text: str,
    html: str,
    settings: Settings | None = None,
) -> bool:
    """Send one message, or print it when no provider is configured.

    Parameters
    ----------
    to:
        Already-normalised destination address.
    subject, text, html:
        Fully rendered content. `text` is the plaintext part (and what the
        fallback prints); `html` is a trivial wrapper for providers that
        prefer it.
    settings:
        Injected in tests; defaults to the process-wide settings.

    Returns
    -------
    True if the provider accepted the message (2xx) or the fallback printed
    it. False on a network / provider failure -- the secret is NOT logged.

    Raises
    ------
    Never. A mail failure must not take down an auth request. The boolean
    is how the caller reports `email_sent`.
    """
    cfg = settings or get_settings()

    try:
        if not cfg.email_delivery_configured:
            _print_dev_fallback(to, subject, text)
            return True

        payload = {
            "from": cfg.EMAIL_FROM,
            "to": [to],
            "subject": subject,
            "text": text,
            "html": html,
        }
        api_key = cfg.EMAIL_PROVIDER_API_KEY
        assert api_key is not None  # email_delivery_configured guarantees this
        headers = {
            "Authorization": f"Bearer {api_key.get_secret_value()}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            response = await client.post(
                cfg.EMAIL_PROVIDER_API_URL,
                json=payload,
                headers=headers,
            )
        # Always print the raw provider reply. Resend can return HTTP 200 with
        # an id while still dropping the message (unverified domain, test-mode
        # recipient). Logging only the status hid 4xx JSON such as
        # "domain is not verified". Never log the API key or the OTP body.
        print(
            f"[resend] httpx.post url={cfg.EMAIL_PROVIDER_API_URL} "
            f"status_code={response.status_code} text={response.text}",
            flush=True,
        )
        logger.info(
            "email provider HTTP %s body=%s from=%s destination=%s url=%s",
            response.status_code,
            response.text,
            cfg.EMAIL_FROM,
            to,
            cfg.EMAIL_PROVIDER_API_URL,
        )
    except Exception as exc:
        # A mail failure must not 500 register / forgot-password. The OTP row
        # is already written; the user can tap Resend.
        print(
            f"[resend] httpx.post FAILED url={cfg.EMAIL_PROVIDER_API_URL} "
            f"exception={type(exc).__name__}: {exc!r}",
            flush=True,
        )
        logger.exception("email delivery failed for destination=%s", to)
        return False

    if response.status_code >= 300:
        logger.error(
            "email provider returned HTTP %s for destination=%s body=%s",
            response.status_code,
            to,
            response.text,
        )
        return False
    return True


async def send_otp_email(
    to: str,
    code: str,
    purpose: OtpPurpose,
    *,
    settings: Settings | None = None,
) -> bool:
    """Email a six-digit one-time code.

    Parameters
    ----------
    to:
        Normalised destination.
    code:
        The plaintext six digits. Lives in this stack frame long enough to
        be put in the body; never written to a logger on the production path.
    purpose:
        Selects the subject line.
    settings:
        Optional override for tests.

    Returns
    -------
    True if delivered (or printed via the development fallback).
    """
    subject, intro = _purpose_copy(purpose)
    # TTL is mentioned in minutes because that is how humans read an email.
    # The actual lifetime is `OTP_TTL_SECONDS` (default 600 s = 10 min).
    cfg = settings or get_settings()
    ttl_minutes = max(1, cfg.OTP_TTL_SECONDS // 60)
    text = (
        f"{intro}\n\n"
        f"Your code is: {code}\n\n"
        f"It expires in {ttl_minutes} minute(s) and can be used only once. "
        f"If you did not request this, you can ignore this email."
    )
    html = (
        f"<p>{intro}</p>"
        f"<p style=\"font-size:24px;letter-spacing:0.3em\"><strong>{code}</strong></p>"
        f"<p>It expires in {ttl_minutes} minute(s) and can be used only once.</p>"
    )
    return await _deliver(to=to, subject=subject, text=text, html=html, settings=cfg)


async def send_password_reset_email(
    to: str,
    token: str,
    *,
    settings: Settings | None = None,
) -> bool:
    """Email a single-use password-reset link.

    Parameters
    ----------
    to:
        Normalised destination.
    token:
        The plaintext reset token. Dropped into `?token=`; `token_urlsafe`
        output needs no percent-encoding. Never logged on the production path.
    settings:
        Optional override for tests.

    Returns
    -------
    True if delivered (or printed via the development fallback).
    """
    cfg = settings or get_settings()
    # `PASSWORD_RESET_URL` is the client page; we only append the query.
    separator = "&" if "?" in cfg.PASSWORD_RESET_URL else "?"
    reset_url = f"{cfg.PASSWORD_RESET_URL}{separator}token={token}"
    ttl_minutes = max(1, cfg.PASSWORD_RESET_TTL_SECONDS // 60)
    subject = "Reset your Peapod password"
    text = (
        "We received a request to reset the password on your Peapod account.\n\n"
        f"Open this link to choose a new password:\n{reset_url}\n\n"
        f"This link expires in {ttl_minutes} minute(s) and can be used only once. "
        "If you did not request a reset, you can ignore this email -- "
        "your password will not change."
    )
    html = (
        "<p>We received a request to reset the password on your Peapod account.</p>"
        f"<p><a href=\"{reset_url}\">Choose a new password</a></p>"
        f"<p>This link expires in {ttl_minutes} minute(s) and can be used only once.</p>"
    )
    return await _deliver(to=to, subject=subject, text=text, html=html, settings=cfg)
