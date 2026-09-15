"""
MODULE: app.security.otp

PURPOSE
    Issue and verify the six-digit email codes used by two Peapod flows:
      * registration -- prove the person controls the address they signed up
        with (`Register.jsx` shows the six-slot code input right after
        submitting the form), and
      * login of an unverified account -- re-send verification instead of
        letting the account stall.

INPUTS  : a user id, a purpose, and (on verification) six digits from the client
OUTPUTS : the plaintext code (returned ONCE, to be emailed) and verification
          outcomes

CALLED BY
    `app/routes/auth.py` -- register / verify-otp / resend-otp / login.
    The generated code is handed straight to `app/email.py` and is never
    logged, except by the explicitly-labelled development email fallback.

=============================================================================
WHY SIX DIGITS, AND WHY THAT IS SAFE
=============================================================================
Six digits is 10^6 = 1 000 000 possibilities: about 20 bits. That is
laughably weak as a standalone secret. It is acceptable here only because
three independent limits are enforced together, and the security argument
falls apart if any one of them is removed:

    1. TTL -- the code dies after `OTP_TTL_SECONDS` (default 600 s = 10 min).
    2. ATTEMPT CAP -- `MAX_VERIFY_ATTEMPTS` (5) wrong guesses kill the code
       permanently, so one issued code gives an attacker a 5-in-1 000 000
       chance (0.0005%).
    3. ISSUE RATE LIMIT -- `app/security/ratelimit.py` caps how many codes can
       be requested per address per window, so an attacker cannot simply cycle
       through fresh codes to accumulate attempts.

    4. SINGLE USE -- `consumed_at` means a code that worked once cannot work
       again, so a code captured from an inbox after the fact is inert.

Why not a longer code? Because a human has to retype it from an email, and the
alternatives are worse: users who cannot complete verification fall back to
support flows, which are far softer targets than a rate-limited 6-digit code.

=============================================================================
WHY THE STORED HASH IS ARGON2, NOT SHA-256
=============================================================================
This is the exact inverse of the refresh-token decision in `tokens.py`, and
the difference is entropy:

    A refresh token has 256 bits, so SHA-256 of it cannot be reversed.
    A six-digit code has 20 bits, so an attacker holding SHA-256 of it can
    enumerate all 1 000 000 candidates in under a second and recover the code
    from a database dump.

So OTP codes get a memory-hard hash. We do NOT reuse the password parameters:
64 MiB per verification is an easy denial-of-service lever on an endpoint that
unauthenticated callers can hit. The profile below is deliberately lighter and
the reasoning is inline.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from argon2.low_level import Type

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Number of digits in a code. Must stay in sync with the client's six-slot
#: input (`InputOTP maxLength={6}`) and with the `^\d{6}$` pattern in
#: `app/schemas.py`.
OTP_DIGITS = 6

#: Upper bound (exclusive) for the random draw: 10^6.
_OTP_UPPER_BOUND = 10**OTP_DIGITS

# THREAT: online guessing of an issued code.
# 5 attempts against 10^6 candidates is a 1-in-200 000 chance per code. Five
# also comfortably absorbs honest mistakes (a mistyped digit, a stale code from
# a previous email) without a support ticket. Once exceeded, the code is dead
# even if the correct digits arrive next -- otherwise an attacker could grind
# forever as long as they eventually guessed right.
MAX_VERIFY_ATTEMPTS = 5

# Argon2id profile for OTP codes. Much lighter than the password profile.
#
# THREAT 1 (offline): a database dump lets an attacker recover live codes.
#   19 MiB x 2 passes is roughly 25-40 ms per candidate, so sweeping all
#   1 000 000 candidates for ONE code costs on the order of a CPU-day. Since a
#   code is dead within 10 minutes, that is comfortably beyond useful.
# THREAT 2 (online): an unauthenticated attacker floods /auth/verify-otp to
#   exhaust CPU and memory. This is why we do NOT use the 64 MiB password
#   profile: 19 MiB x (a few concurrent verifications) stays small, and the
#   per-IP budget in `ratelimit.py` caps the rate on top.
# 19456 KiB (19 MiB) with t=2, p=1 is OWASP's documented minimum Argon2id
# configuration -- appropriate as a floor for a secret that only lives for ten
# minutes and is additionally attempt-capped.
OTP_ARGON2_TIME_COST = 2
OTP_ARGON2_MEMORY_COST = 19_456
OTP_ARGON2_PARALLELISM = 1

_OTP_HASHER = PasswordHasher(
    time_cost=OTP_ARGON2_TIME_COST,
    memory_cost=OTP_ARGON2_MEMORY_COST,
    parallelism=OTP_ARGON2_PARALLELISM,
    hash_len=32,
    salt_len=16,
    type=Type.ID,
)


class OtpVerdict(StrEnum):
    """Why an OTP verification succeeded or failed.

    Route handlers collapse every failure into ONE generic client message.
    These values exist for the audit log and the tests. Reporting "expired"
    versus "wrong" to the client is a mild oracle (it confirms a code was
    issued for that address at all), and reporting "too many attempts" versus
    "wrong" tells an attacker exactly when to start a fresh code.
    """

    OK = "ok"
    NO_CODE = "no_code"
    """No unconsumed code exists for this user and purpose."""
    EXPIRED = "expired"
    CONSUMED = "consumed"
    TOO_MANY_ATTEMPTS = "too_many_attempts"
    MISMATCH = "mismatch"


@dataclass(frozen=True, slots=True)
class GeneratedOtp:
    """A newly minted code.

    Attributes
    ----------
    code:
        The plaintext six digits. Emailed once. When OTP_STORE_PLAINTEXT is
        on, the same digits are also written to `otp_codes.code_hash`.
    code_hash:
        What goes in `otp_codes.code_hash` (plaintext or Argon2).
    expires_at:
        Absolute deadline, timezone-aware UTC.
    """

    code: str
    code_hash: str
    expires_at: datetime


def generate_code() -> str:
    """Return a cryptographically random six-digit code as a string.

    Returns
    -------
    Exactly `OTP_DIGITS` characters, zero-padded, e.g. `"004291"`.

    Why `secrets.randbelow`
    -----------------------
    * It draws from the OS CSPRNG. `random.randint` uses the Mersenne Twister,
      whose entire internal state is recoverable from 624 observed outputs --
      an attacker who watches enough codes could then PREDICT the next one, and
      an unlimited supply of observations is available to anyone who can
      register accounts.
    * `randbelow(1_000_000)` is uniform over 0..999999. Naive alternatives are
      not: `randbits(20) % 1_000_000` is biased toward low values because
      2^20 (1 048 576) is not a multiple of 1 000 000, so the first 48 576
      codes are ~2x as likely. `randbelow` rejects and re-draws instead.

    Why zero-padding matters
    ------------------------
    The code is a STRING of six characters, not an integer. `4291` and
    `"004291"` must not both be accepted, or the effective keyspace shrinks and
    the client's fixed six-slot input cannot express half the codes.
    """
    return f"{secrets.randbelow(_OTP_UPPER_BOUND):0{OTP_DIGITS}d}"


def _store_otp_plaintext() -> bool:
    """Isolated switch for plaintext OTP rows.

    Revert: set OTP_STORE_PLAINTEXT=false (or delete the flag; hashing
    functions below are unchanged). Read at call time so tests can flip
    Settings without reimporting this module.
    """
    from app.config import get_settings

    return bool(get_settings().OTP_STORE_PLAINTEXT)


def hash_code(code: str) -> str:
    """Value written to `otp_codes.code_hash`.

    Parameters
    ----------
    code:
        Six digits.

    Returns
    -------
    The plaintext code when `OTP_STORE_PLAINTEXT` is on (dev/debug).
    Otherwise an Argon2 encoded hash.
    """
    if _store_otp_plaintext():
        return code
    return _OTP_HASHER.hash(code)


def verify_code_hash(code_hash: str, submitted: str) -> bool:
    """Compare a submitted code against the stored `otp_codes.code_hash` value.

    Parameters
    ----------
    code_hash:
        Value from `otp_codes.code_hash` (plaintext six digits, or a leftover
        Argon2 hash from before the plaintext switch).
    submitted:
        Six digits from the client (already shape-validated by the Pydantic
        schema, so this function does not need to police the format).

    Returns
    -------
    True on match, False on mismatch or on a corrupt stored hash.

    Plaintext path uses `secrets.compare_digest` so length-equal codes do not
    leak via early-exit. Leftover Argon2 rows still verify so in-flight codes
    issued before the switch keep working until they expire.
    """
    stored = (code_hash or "").strip()
    if len(stored) == OTP_DIGITS and stored.isdigit():
        return secrets.compare_digest(stored, submitted)
    try:
        _OTP_HASHER.verify(stored, submitted)
    except VerifyMismatchError:
        return False
    except InvalidHashError:
        logger.error("stored OTP hash is malformed; treating verification as failed")
        return False
    except VerificationError:
        logger.error("OTP verification failed for an unexpected reason")
        return False
    return True


def generate(ttl_seconds: int, now: datetime | None = None) -> GeneratedOtp:
    """Create a code, its stored form, and its expiry in one step.

    Parameters
    ----------
    ttl_seconds:
        Lifetime in SECONDS -- pass `Settings.OTP_TTL_SECONDS`. Not read from
        configuration inside this function so that callers with a different
        policy (and tests) can be explicit.
    now:
        Time override for tests; timezone-aware UTC.

    Returns
    -------
    `GeneratedOtp`. `code_hash` is plaintext when OTP_STORE_PLAINTEXT is on.
    """
    issued = now or datetime.now(UTC)
    code = generate_code()
    return GeneratedOtp(
        code=code,
        code_hash=hash_code(code),
        expires_at=issued + timedelta(seconds=ttl_seconds),
    )


@dataclass(frozen=True, slots=True)
class OtpCandidate:
    """The fields of an `otp_codes` row that verification needs.

    A plain dataclass rather than the ORM model so the decision function below
    can be unit tested without a database. `app/routes/auth.py` builds one from
    the row it loaded.
    """

    code_hash: str
    expires_at: datetime
    consumed_at: datetime | None
    attempt_count: int


def check_candidate(
    candidate: OtpCandidate | None,
    submitted: str,
    now: datetime,
) -> OtpVerdict:
    """Decide whether a submitted code is acceptable. Pure function.

    Parameters
    ----------
    candidate:
        The stored code to check against, or None when the user has no code for
        this purpose.
    submitted:
        Six digits from the client.
    now:
        Current time, timezone-aware UTC.

    Returns
    -------
    An `OtpVerdict`. The CALLER is responsible for the side effects implied by
    it, because they need a database transaction:
        * `OK`                -> stamp `consumed_at` (single use).
        * `MISMATCH`          -> increment `attempt_count`.
        * anything else       -> no state change.

    Order of checks
    ---------------
    Existence, then expiry, then single-use, then the attempt cap, and only
    then the code comparison. Cheap disqualifications first.

    Edge cases
    ----------
    * `attempt_count >= MAX_VERIFY_ATTEMPTS` returns TOO_MANY_ATTEMPTS *without*
      comparing, so a burned code cannot be brute-forced further even with the
      right answer.
    * Expiry uses `<=`: a code whose deadline is exactly now is expired. Off by
      one second in the safe direction.
    """
    if candidate is None:
        return OtpVerdict.NO_CODE
    if candidate.consumed_at is not None:
        return OtpVerdict.CONSUMED
    if candidate.expires_at <= now:
        return OtpVerdict.EXPIRED
    if candidate.attempt_count >= MAX_VERIFY_ATTEMPTS:
        return OtpVerdict.TOO_MANY_ATTEMPTS
    if not verify_code_hash(candidate.code_hash, submitted):
        return OtpVerdict.MISMATCH
    return OtpVerdict.OK
