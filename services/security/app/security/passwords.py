"""
MODULE: app.security.passwords

PURPOSE
    Turn a user-supplied password into something safe to store, and check a
    submitted password against a stored hash. This module is the only place in
    the Peapod monorepo that ever sees a plaintext password.

INPUTS  : plaintext passwords (str) and stored Argon2 encoded hashes (str)
OUTPUTS : encoded hashes, and verification results that may carry an upgraded
          hash for the caller to persist

CALLED BY
    `app/routes/auth.py` (register, login, reset-password, delete-account).
    Never called by `services/api` -- the Node API cannot reach this code and
    never receives a hash.

=============================================================================
WHY ARGON2id
=============================================================================
A password hash has one job: make an offline attack against a stolen database
so slow that it is not worth running. That means the hash must be deliberately
expensive, and expensive in a way that does not get cheap when the attacker
buys different hardware.

    * SHA-256 / SHA-512 are wrong. They are designed to be fast; a commodity
      GPU computes billions per second.
    * PBKDF2 is CPU-hard but not memory-hard, so a GPU with thousands of tiny
      cores parallelises it almost perfectly.
    * bcrypt is memory-hard-ish but fixed at ~4 KB of working memory, which
      fits in GPU cache, and it silently truncates input at 72 bytes.
    * Argon2id (the winner of the Password Hashing Competition, and the
      algorithm OWASP recommends first) is BOTH memory-hard and CPU-hard, and
      the "id" variant combines Argon2i's resistance to side-channel attacks on
      the first pass with Argon2d's resistance to time-memory trade-offs on
      later passes. Forcing an attacker to allocate tens of megabytes per guess
      is what kills GPU and ASIC parallelism: memory bandwidth, not clock
      speed, becomes the bottleneck.

=============================================================================
BLOCKING / EVENT LOOP
=============================================================================
Hashing here is intentionally slow (~50-100 ms) and is pure CPU work, which
would stall the asyncio event loop if called directly from a coroutine. Callers
in `app/routes/auth.py` therefore invoke these functions through
`anyio.to_thread.run_sync`. The functions themselves are synchronous on
purpose: they are also used from tests and from a future CLI, and wrapping
thread offloading inside the primitive would hide the cost.
"""

from __future__ import annotations

import logging
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import HashingError, InvalidHashError, VerificationError, VerifyMismatchError

# `Type` is re-exported by the top-level package too, but importing it from
# `low_level` is the spelling argon2-cffi documents and guarantees.
from argon2.low_level import Type

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Argon2id parameters
# ---------------------------------------------------------------------------
# These are the knobs that decide how expensive one guess is. They are spelled
# out explicitly rather than left to argon2-cffi's defaults so that (a) the
# reasoning is reviewable and (b) a library upgrade cannot silently weaken --
# or silently multiply the cost of -- every login in production.
#
# THREAT: an attacker who has stolen `auth_credentials` runs a dictionary
# attack offline. Our only lever is the cost per guess.

# Number of passes over memory. Each pass re-reads and re-mixes the whole
# buffer, so cost scales linearly. 3 is OWASP's recommended pass count when
# paired with a large memory setting; going higher trades a lot of login
# latency for a small factor of attacker cost compared with raising memory.
ARGON2_TIME_COST = 3

# Working memory per hash, in KIBIBYTES. 65536 KiB = 64 MiB.
# This is the parameter that actually defeats GPUs: a modern GPU has tens of
# gigabytes of RAM but only a few megabytes of fast cache per compute unit, so
# at 64 MiB per guess it can keep only a handful of guesses in flight instead
# of thousands. OWASP's floor is 19 MiB; 64 MiB is a comfortable margin that
# still lets a small container serve logins.
#
# CAPACITY NOTE: peak memory is roughly ARGON2_MEMORY_COST x (concurrent
# hashes). With the login rate limits in `ratelimit.py` and the default thread
# pool, worst case is well under 1 GiB. If you raise this, raise the
# container's memory limit too, or logins will be OOM-killed.
ARGON2_MEMORY_COST = 65_536

# Number of lanes the algorithm may compute in parallel. 2 lets one hash use
# two cores and finish in about half the wall-clock time, which improves login
# latency without reducing the memory an attacker must commit per guess.
# Deliberately conservative: a container is typically limited to 1-2 CPUs, and
# asking for 4 lanes on 1 CPU just adds scheduling overhead.
ARGON2_PARALLELISM = 2

# Output length in bytes. 32 bytes = 256 bits, matching the security level of
# everything else here. Longer output adds storage, not strength.
ARGON2_HASH_LENGTH = 32

# Per-password random salt length in bytes. 16 bytes = 128 bits, the RFC 9106
# recommendation. The salt is what makes rainbow tables and cross-account
# "these two users share a password" analysis useless. argon2-cffi generates it
# and embeds it in the encoded hash string, so there is no separate column.
ARGON2_SALT_LENGTH = 16

# THREAT: memory-exhaustion denial of service. Argon2 hashes its input into a
# fixed-size buffer, so a huge password does not increase Argon2's memory use
# much -- but it does mean we accept, copy, and encode an unbounded string per
# request. 1024 bytes is far beyond any real passphrase (and beyond what the
# mobile keyboard can produce) while capping the work an attacker can buy with
# one request. Note this is a BYTE limit after UTF-8 encoding, not a character
# count, because a 1024-character emoji password is 4 KiB of bytes.
MAX_PASSWORD_BYTES = 1024

#: The shared hasher. `PasswordHasher` is stateless with respect to a single
#: hash operation (a fresh salt is drawn per call) and is safe to reuse across
#: threads, so one module-level instance is correct and avoids re-validating
#: parameters on every login.
_HASHER = PasswordHasher(
    time_cost=ARGON2_TIME_COST,
    memory_cost=ARGON2_MEMORY_COST,
    parallelism=ARGON2_PARALLELISM,
    hash_len=ARGON2_HASH_LENGTH,
    salt_len=ARGON2_SALT_LENGTH,
    # Explicit: argon2-cffi's default is already Argon2id, but relying on a
    # default for the algorithm variant is exactly the kind of thing a major
    # version bump changes.
    type=Type.ID,
)

#: A hash of a random throwaway string, used to burn the same amount of CPU
#: when the submitted email does not exist or the account is OAuth-only.
#:
#: THREAT: a timing oracle for account enumeration. If a login against an
#: unknown address returns in 2 ms while a login against a known address takes
#: 80 ms (because it actually ran Argon2), an attacker can enumerate which
#: addresses have Peapod accounts by measuring response time -- defeating the
#: generic "Invalid email or password" message entirely. Verifying against this
#: dummy hash makes both paths cost the same.
#:
#: Built once at import time so the cost is paid at startup, not on the first
#: unlucky request.
_DUMMY_HASH = _HASHER.hash(secrets.token_urlsafe(32))


class PasswordPolicyError(ValueError):
    """Raised when a password cannot be hashed because it is unusable.

    Only covers mechanical limits (empty, absurdly long). Length and complexity
    rules live in `app/schemas.py` so the client gets a 422 with a field-level
    message instead of a 500.
    """


def hash_password(plaintext: str) -> str:
    """Hash a password for storage.

    Parameters
    ----------
    plaintext:
        The password exactly as the user typed it. Not trimmed, not
        case-folded, not normalised -- trailing spaces and casing are part of
        the secret, and silently altering it would mean a password that works
        on one client and not another.

    Returns
    -------
    The Argon2 encoded hash, e.g.
    ``$argon2id$v=19$m=65536,t=3,p=2$<salt-b64>$<hash-b64>``.
    Self-describing: the algorithm, every parameter, and the salt all travel
    with the digest, which is what makes the `needs_rehash` upgrade path below
    possible without a schema change.

    Raises
    ------
    PasswordPolicyError
        If the password is empty or exceeds `MAX_PASSWORD_BYTES`.
    HashingError
        If the underlying C library fails (out of memory).

    Timing
    ------
    ~50-100 ms of CPU at the parameters above. Call from a worker thread.
    """
    _assert_hashable(plaintext)
    return _HASHER.hash(plaintext)


class VerifyResult:
    """Outcome of a password check.

    Attributes
    ----------
    ok:
        Whether the password matched.
    upgraded_hash:
        A freshly computed hash using the CURRENT parameters, present only when
        `ok` is True and the stored hash used outdated parameters. The caller
        must persist it (see `verify_password` docs). `None` otherwise.
    """

    __slots__ = ("ok", "upgraded_hash")

    def __init__(self, ok: bool, upgraded_hash: str | None = None) -> None:
        self.ok = ok
        self.upgraded_hash = upgraded_hash

    def __bool__(self) -> bool:
        return self.ok

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        # Never include `upgraded_hash` itself.
        return f"<VerifyResult ok={self.ok} upgrade={self.upgraded_hash is not None}>"


def verify_password(stored_hash: str | None, plaintext: str) -> VerifyResult:
    """Check a submitted password against a stored hash.

    Parameters
    ----------
    stored_hash:
        The encoded hash from `auth_credentials.password_hash`, or `None` for an
        OAuth-only account that has never set a password.
    plaintext:
        The submitted password.

    Returns
    -------
    `VerifyResult`. `result.ok` is False for every failure mode -- wrong
    password, no password set, corrupt stored hash. The caller must not
    distinguish between them in its response.

    When `result.ok` is True and `result.upgraded_hash` is not None, the caller
    should write that value back to `auth_credentials.password_hash` in the
    same transaction. This is the rehash-on-login upgrade path:

        Step 1. We raise `ARGON2_MEMORY_COST` (say from 64 MiB to 256 MiB in
                2028, because hardware got faster).
        Step 2. Every existing row still holds a hash produced with the old
                parameters. We cannot recompute them -- we do not have anyone's
                password.
        Step 3. The next time a user logs in we DO have their password for a
                few milliseconds. `PasswordHasher.check_needs_rehash` reads the
                parameters out of the encoded hash, notices they are weaker
                than the current settings, and we transparently replace the row.
        Step 4. Over one login cycle the whole table migrates itself, with no
                password resets and no user-visible change.

    Edge cases
    ----------
    * `stored_hash is None` (OAuth-only account): returns ok=False, but ONLY
      after verifying against `_DUMMY_HASH`, so the response time matches a
      real password check and does not reveal that the account exists but has
      no password.
    * An empty or over-long submission returns ok=False without hashing; the
      request never got as far as a real credential, and there is nothing to
      enumerate because the same rejection happens for every account.
    * A corrupt stored hash (`InvalidHashError`) is logged as an operational
      error -- it means the column was tampered with or truncated -- and
      treated as a failed login.
    """
    if stored_hash is None:
        # Equalise timing against the "account exists with a password" path.
        _verify_dummy()
        return VerifyResult(False)

    try:
        _assert_hashable(plaintext)
    except PasswordPolicyError:
        return VerifyResult(False)

    try:
        # argon2-cffi's `verify` re-derives the hash using the parameters and
        # salt embedded in `stored_hash` and compares the result in constant
        # time inside the C library. It raises rather than returning False.
        _HASHER.verify(stored_hash, plaintext)
    except VerifyMismatchError:
        return VerifyResult(False)
    except InvalidHashError:
        logger.error(
            "stored password hash is not a valid Argon2 encoded hash; "
            "treating login as failed (no hash material logged)"
        )
        return VerifyResult(False)
    except VerificationError:
        # Catch-all for other argon2 verification failures (e.g. an unsupported
        # variant written by a different tool).
        logger.error("password verification failed for an unexpected reason")
        return VerifyResult(False)

    upgraded: str | None = None
    try:
        if _HASHER.check_needs_rehash(stored_hash):
            upgraded = _HASHER.hash(plaintext)
            logger.info("upgrading a stored password hash to current Argon2id parameters")
    except (HashingError, InvalidHashError):
        # An upgrade failure must never turn a successful login into a failure.
        logger.warning("could not compute an upgraded password hash; keeping the existing one")

    return VerifyResult(True, upgraded)


def needs_rehash(stored_hash: str) -> bool:
    """Whether `stored_hash` was produced with weaker-than-current parameters.

    Parameters
    ----------
    stored_hash:
        An Argon2 encoded hash.

    Returns
    -------
    True if it should be replaced on next successful login. False if it is
    current, or if it cannot be parsed (in which case there is nothing sensible
    to compare against).

    Exposed separately from `verify_password` for tests and for an offline
    audit script that wants to count stale rows without touching passwords.
    """
    try:
        return bool(_HASHER.check_needs_rehash(stored_hash))
    except InvalidHashError:
        return False


def describe_parameters() -> dict[str, int | str]:
    """Return the active Argon2id parameters for `/health` and for the audit log.

    Returns
    -------
    A dict of parameter names to values. Contains NO secret material -- these
    are public tuning constants, and publishing them tells an attacker only
    what they could already read out of any stolen hash string.
    """
    return {
        "algorithm": "argon2id",
        "time_cost": ARGON2_TIME_COST,
        "memory_cost_kib": ARGON2_MEMORY_COST,
        "parallelism": ARGON2_PARALLELISM,
        "hash_len_bytes": ARGON2_HASH_LENGTH,
        "salt_len_bytes": ARGON2_SALT_LENGTH,
    }


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------


def _assert_hashable(plaintext: str) -> None:
    """Reject inputs that must never reach the hasher.

    Raises
    ------
    PasswordPolicyError
        If the password is empty or longer than `MAX_PASSWORD_BYTES` when
        UTF-8 encoded.
    """
    if not plaintext:
        raise PasswordPolicyError("password must not be empty")
    if len(plaintext.encode("utf-8")) > MAX_PASSWORD_BYTES:
        raise PasswordPolicyError(f"password must be at most {MAX_PASSWORD_BYTES} bytes")


def _verify_dummy() -> None:
    """Burn one Argon2 verification's worth of CPU and discard the result.

    Used to keep the "no such account" and "wrong password" paths
    indistinguishable by response time. The mismatch is expected, so the
    exception is swallowed.
    """
    try:
        _HASHER.verify(_DUMMY_HASH, "not-the-dummy-password")
    except VerificationError:
        pass
