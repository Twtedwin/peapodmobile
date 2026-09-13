"""
MODULE: app.security.ratelimit

PURPOSE
    Cap how often an unauthenticated caller may hit the expensive and
    abuse-prone auth endpoints. This is the outermost defence in front of
    password verification, OTP verification, and email sending.

INPUTS  : an action, the client IP, and (where applicable) the submitted
          identifier (an email address)
OUTPUTS : an allow/deny decision carrying `retry_after_seconds`

CALLED BY
    `app/routes/auth.py` and `app/routes/oauth.py`, via
    `app/deps.py::enforce_rate_limit`. Never called by `services/api`, which
    does its own coarse limiting at the edge.

=============================================================================
WHY HAND-ROLLED INSTEAD OF slowapi
=============================================================================
The brief allowed either. Three reasons this module exists:

  1. TWO KEYS PER CALL. Every protected action is limited on the client IP
     *and* on the submitted email, independently. Both are necessary:
        - IP only: an attacker with one IP can still spray 10 000 different
          addresses at /auth/forgot-password to mine which ones exist, as long
          as they stay under the IP budget.
        - Identifier only: a botnet with 10 000 IPs can grind ONE account's
          password, because each IP only spends one attempt.
     slowapi's decorators key off the Request object; expressing "these two
     budgets, and tell me which one tripped" means fighting the library.

  2. PER-ACTION BUDGETS AND AN HONEST Retry-After. Login, register, OTP
     verify, OTP resend, and password reset all have different cost and
     different abuse profiles, and the 429 needs to say exactly how long to
     wait. That is what this ~200 lines does.

  3. FEWER DEPENDENCIES IN THE CREDENTIAL PROCESS. Every third-party package
     in the service that holds the password hashes is supply-chain surface.

=============================================================================
KNOWN LIMITATION: STATE IS PER-PROCESS
=============================================================================
Buckets live in this process's memory. Consequences an operator must know:

  * Running N uvicorn workers multiplies every budget by N (each worker has
    its own view). The numbers below are chosen so that even x4 they are still
    restrictive.
  * A restart forgets all buckets, so a rolling deploy briefly resets budgets.
  * This is NOT a defence against a large distributed attack; that belongs at
    the edge (CDN/WAF), where the traffic can be dropped before it costs us a
    TLS handshake.

The per-ACCOUNT lockout in `auth_credentials.locked_until` is the durable,
shared-state defence that survives all three of those, which is exactly why
both mechanisms exist. Replacing these in-memory buckets with Redis is the
documented production follow-up (see SETUP-EXTERNAL-APIS.md and README.md).
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum

logger = logging.getLogger(__name__)


class RateLimitAction(StrEnum):
    """The protected operations. One budget pair per member."""

    LOGIN = "login"
    REGISTER = "register"
    OTP_VERIFY = "otp_verify"
    OTP_RESEND = "otp_resend"
    PASSWORD_RESET_REQUEST = "password_reset_request"
    PASSWORD_RESET_SUBMIT = "password_reset_submit"
    TOKEN_REFRESH = "token_refresh"
    OAUTH_START = "oauth_start"


@dataclass(frozen=True, slots=True)
class Budget:
    """`capacity` requests allowed per `window_seconds`, refilling smoothly.

    Attributes
    ----------
    capacity:
        Maximum burst -- the number of requests allowed back to back from cold.
    window_seconds:
        The period over which a full `capacity` worth of allowance is restored,
        in SECONDS. The refill rate is therefore `capacity / window_seconds`
        tokens per second.

    Why a token bucket rather than a fixed window
    ---------------------------------------------
    A fixed window ("5 per 15 minutes, counter resets on the quarter hour")
    permits a 2x burst across the boundary: 5 attempts at 14:59 and 5 more at
    15:00 is 10 attempts in seconds. A token bucket refills continuously, so
    the sustained rate is honest while still allowing a legitimate burst of
    `capacity` (a user fat-fingering their password three times in a row is
    normal and must not be punished).
    """

    capacity: int
    window_seconds: int

    @property
    def refill_per_second(self) -> float:
        """Tokens restored per second."""
        return self.capacity / self.window_seconds


@dataclass(frozen=True, slots=True)
class ActionBudgets:
    """The per-IP and per-identifier budgets for one action.

    `per_identifier` is None for actions with no meaningful identifier -- e.g.
    a token refresh, where the only identifier IS the secret and keying a
    limiter on it would both be useless (an attacker just sends new random
    strings) and require holding a credential in a limiter key.
    """

    per_ip: Budget
    per_identifier: Budget | None


# =============================================================================
# THE BUDGETS
# =============================================================================
# Each number below is a trade-off between "a real user must never hit this"
# and "an attacker must not get enough attempts to matter". The per-identifier
# budgets are the tight ones because they protect a specific account; the
# per-IP budgets are looser because a whole household, office, or mobile
# carrier NAT can share one address.
# -----------------------------------------------------------------------------
BUDGETS: dict[RateLimitAction, ActionBudgets] = {
    # LOGIN -- the classic credential-stuffing target, and our most expensive
    # endpoint (one Argon2id verification at 64 MiB per call).
    #   per-email 5 / 15 min: a human who has forgotten their password tries
    #     two or three variations and then clicks "Forgot password?". Five is
    #     generous for that and useless for a dictionary attack. Combined with
    #     the account lockout after 10 total failures, a targeted attacker gets
    #     ~20 password guesses per hour against one account.
    #   per-IP 20 / 15 min: covers a family or a small office behind one NAT
    #     (four people, five tries each) while capping how many DIFFERENT
    #     accounts one address can probe.
    RateLimitAction.LOGIN: ActionBudgets(
        per_ip=Budget(capacity=20, window_seconds=900),
        per_identifier=Budget(capacity=5, window_seconds=900),
    ),
    # REGISTER -- each call sends an email, so abuse costs us money and, worse,
    # burns our sending domain's reputation if a spammer uses us to mail
    # strangers.
    #   per-email 3 / hour: one signup attempt plus two retries after a typo.
    #   per-IP 5 / hour: nobody legitimately creates six accounts an hour from
    #     one address; a shared-office signup burst is vanishingly rare
    #     compared with the cost of being used as a mail cannon.
    RateLimitAction.REGISTER: ActionBudgets(
        per_ip=Budget(capacity=5, window_seconds=3600),
        per_identifier=Budget(capacity=3, window_seconds=3600),
    ),
    # OTP VERIFY -- online brute force of a 20-bit code.
    #   per-email 5 / 10 min: deliberately EQUAL to `otp.MAX_VERIFY_ATTEMPTS`
    #     and aligned to the default `OTP_TTL_SECONDS` (600 s). The per-code
    #     attempt counter is the real cap; this budget is what stops an
    #     attacker from cheaply discovering that the counter has burned out and
    #     immediately requesting a new code, and it caps the Argon2 CPU spend.
    #   per-IP 30 / 15 min: a busy shared network verifying several signups.
    RateLimitAction.OTP_VERIFY: ActionBudgets(
        per_ip=Budget(capacity=30, window_seconds=900),
        per_identifier=Budget(capacity=5, window_seconds=600),
    ),
    # OTP RESEND -- pure email amplification: one request, one email to an
    # address the requester does not have to control.
    #   per-email 3 / 15 min: matches what a user does when the first mail is
    #     slow (wait, resend, wait, resend). More than that is not impatience,
    #     it is an attempt to mail-bomb an inbox.
    #   per-IP 10 / hour.
    RateLimitAction.OTP_RESEND: ActionBudgets(
        per_ip=Budget(capacity=10, window_seconds=3600),
        per_identifier=Budget(capacity=3, window_seconds=900),
    ),
    # PASSWORD RESET REQUEST -- also email amplification, and the endpoint an
    # attacker would use for account enumeration if the response differed by
    # whether the address exists (it does not; see `app/routes/auth.py`).
    #   per-email 3 / hour, per-IP 10 / hour.
    RateLimitAction.PASSWORD_RESET_REQUEST: ActionBudgets(
        per_ip=Budget(capacity=10, window_seconds=3600),
        per_identifier=Budget(capacity=3, window_seconds=3600),
    ),
    # PASSWORD RESET SUBMIT -- guessing a 256-bit token is hopeless, so this
    # budget exists only to stop someone burning our CPU and filling the audit
    # log. No identifier: the request carries only the token, and a token is a
    # credential we will not use as a limiter key.
    RateLimitAction.PASSWORD_RESET_SUBMIT: ActionBudgets(
        per_ip=Budget(capacity=15, window_seconds=900),
        per_identifier=None,
    ),
    # TOKEN REFRESH -- called by every signed-in client roughly once per access
    # token lifetime (15 min).
    #   per-IP 60 / 5 min is very loose on purpose: an office of 30 people
    #   behind one NAT, each waking their phone and refreshing, must never see
    #   a 429 -- a rate-limited refresh looks to the user like being randomly
    #   logged out. Refresh is cheap (one indexed lookup, no Argon2) and is
    #   already protected by the rotation/reuse mechanism, so the budget is
    #   about accident containment, not about defeating an attacker.
    RateLimitAction.TOKEN_REFRESH: ActionBudgets(
        per_ip=Budget(capacity=60, window_seconds=300),
        per_identifier=None,
    ),
    # OAUTH START -- cheap, but each call allocates a pending-flow entry, so
    # cap it to bound that dictionary's growth.
    RateLimitAction.OAUTH_START: ActionBudgets(
        per_ip=Budget(capacity=20, window_seconds=900),
        per_identifier=None,
    ),
}

# THREAT: memory exhaustion of the limiter itself. Every distinct key allocates
# a small bucket, and the key space includes attacker-chosen emails, so an
# attacker could otherwise grow this dictionary without bound (a slow-motion
# denial of service against the very component meant to stop them).
#
# 50 000 buckets is roughly a few megabytes and far more than Peapod's real
# traffic needs. On overflow we drop buckets that have refilled to full --
# those carry no information, since a full bucket is indistinguishable from a
# key that has never been seen.
MAX_TRACKED_KEYS = 50_000


@dataclass(frozen=True, slots=True)
class RateLimitDecision:
    """Outcome of a limiter check."""

    allowed: bool
    retry_after_seconds: int
    """Whole seconds the caller should wait. Always >= 1 when denied, because a
    `Retry-After: 0` invites an immediate retry."""
    scope: str
    """Which budget tripped: 'ip', 'identifier', or '' when allowed. Recorded
    in the audit log; NOT returned to the client, because telling an attacker
    that the *identifier* budget tripped confirms the address is being
    targeted successfully."""


class _Bucket:
    """Mutable token-bucket state for one key. Internal to this module."""

    __slots__ = ("tokens", "updated_at")

    def __init__(self, tokens: float, updated_at: float) -> None:
        self.tokens = tokens
        self.updated_at = updated_at


class RateLimiter:
    """In-memory, per-process token-bucket limiter.

    Thread safety
    -------------
    Guarded by a `threading.Lock`. FastAPI handlers all run on one event loop
    thread, so contention is nil, but sync endpoints and `to_thread` callers
    would otherwise be able to interleave a read-modify-write of the same
    bucket and lose an increment -- a small correctness hole that costs one
    uncontended lock to close.
    """

    def __init__(self, clock: Callable[[], float] | None = None) -> None:
        """
        Parameters
        ----------
        clock:
            Seconds-resolution monotonic clock. Injectable so tests can advance
            time without sleeping. Defaults to `time.monotonic`, NOT
            `time.time`: a wall-clock step (NTP correction, a daylight-saving
            change on a badly configured host) could otherwise appear to
            refill every bucket instantly or freeze them for an hour.
        """
        self._clock = clock or time.monotonic
        self._buckets: dict[tuple[str, str, str], _Bucket] = {}
        self._lock = threading.Lock()

    def check(
        self,
        action: RateLimitAction,
        *,
        ip: str | None,
        identifier: str | None = None,
    ) -> RateLimitDecision:
        """Consume one unit of allowance for `action`, or deny.

        Parameters
        ----------
        action:
            Which budget pair applies.
        ip:
            Client address. None (or unknown) is bucketed under the literal
            key 'unknown', which means all such callers share one budget --
            fail closed rather than exempting requests with no address.
        identifier:
            The submitted email, or None. Normalised and hashed before use as a
            key.

        Returns
        -------
        `RateLimitDecision`. When `allowed` is False, NOTHING was consumed from
        either bucket, so a denied request cannot also burn the caller's other
        budget.

        Algorithm
        ---------
        1. Resolve the budgets for the action.
        2. For each applicable scope, compute the bucket's current token count:
           `min(capacity, tokens + elapsed_seconds * refill_per_second)`.
        3. If ANY scope has less than one token, deny and report the longest
           wait across the failing scopes.
        4. Otherwise subtract one token from EVERY scope and allow. Checking
           all scopes before consuming any is what makes step 3's guarantee
           hold.
        """
        budgets = BUDGETS[action]
        ip_key = ("ip", action.value, _hash_key(ip or "unknown"))
        keys: list[tuple[tuple[str, str, str], Budget]] = [(ip_key, budgets.per_ip)]
        if budgets.per_identifier is not None and identifier:
            keys.append(
                (("id", action.value, _hash_key(identifier.strip().lower())), budgets.per_identifier)
            )

        now = self._clock()
        with self._lock:
            self._evict_if_needed(now)

            # --- Step 2 + 3: look before you leap -------------------------
            worst_wait = 0.0
            failing_scope = ""
            for key, budget in keys:
                bucket = self._buckets.get(key)
                available = (
                    budget.capacity
                    if bucket is None
                    else min(
                        float(budget.capacity),
                        bucket.tokens + (now - bucket.updated_at) * budget.refill_per_second,
                    )
                )
                if available < 1.0:
                    wait = (1.0 - available) / budget.refill_per_second
                    if wait > worst_wait:
                        worst_wait = wait
                        failing_scope = key[0]

            if failing_scope:
                return RateLimitDecision(
                    allowed=False,
                    # Round UP, and never below 1: a client that retries at
                    # exactly the computed instant would be denied again.
                    retry_after_seconds=max(1, int(worst_wait) + 1),
                    scope="ip" if failing_scope == "ip" else "identifier",
                )

            # --- Step 4: consume ------------------------------------------
            for key, budget in keys:
                bucket = self._buckets.get(key)
                if bucket is None:
                    self._buckets[key] = _Bucket(budget.capacity - 1.0, now)
                else:
                    refilled = min(
                        float(budget.capacity),
                        bucket.tokens + (now - bucket.updated_at) * budget.refill_per_second,
                    )
                    bucket.tokens = refilled - 1.0
                    bucket.updated_at = now

        return RateLimitDecision(allowed=True, retry_after_seconds=0, scope="")

    def reset(self) -> None:
        """Forget all buckets. For tests and for an operator-triggered flush."""
        with self._lock:
            self._buckets.clear()

    def _evict_if_needed(self, now: float) -> None:
        """Drop uninformative buckets once the table gets too large.

        Caller must hold `self._lock`.

        A bucket that has refilled to capacity is equivalent to no bucket at
        all, so removing it cannot grant anyone extra allowance. If that is not
        enough to get under the cap (a genuine flood from many keys), we clear
        everything and log it -- losing limiter state is bad, but unbounded
        memory growth in the auth service is worse, and the durable per-account
        lockout still applies.
        """
        if len(self._buckets) <= MAX_TRACKED_KEYS:
            return

        for key in [
            key
            for key, bucket in self._buckets.items()
            if _is_full(bucket, key, now)
        ]:
            del self._buckets[key]

        if len(self._buckets) > MAX_TRACKED_KEYS:
            logger.warning(
                "rate limiter tracking %d keys after eviction; clearing all buckets. "
                "This usually means a distributed attack -- add edge rate limiting.",
                len(self._buckets),
            )
            self._buckets.clear()


def _is_full(bucket: _Bucket, key: tuple[str, str, str], now: float) -> bool:
    """Whether a bucket has refilled to capacity and can be safely forgotten."""
    action = RateLimitAction(key[1])
    budgets = BUDGETS[action]
    budget = budgets.per_ip if key[0] == "ip" else (budgets.per_identifier or budgets.per_ip)
    refilled = bucket.tokens + (now - bucket.updated_at) * budget.refill_per_second
    return refilled >= budget.capacity


def _hash_key(raw: str) -> str:
    """Hash a limiter key component.

    Parameters
    ----------
    raw:
        An IP address or a normalised email.

    Returns
    -------
    The first 32 hex characters of SHA-256 (128 bits -- collisions are
    irrelevant here, and a collision would merely make two keys share a
    budget).

    Why hash at all
    ---------------
    Not for secrecy -- an email address is not a secret. It keeps raw addresses
    and IPs out of a process memory dump, out of any future Prometheus label,
    and out of exception messages that mention limiter keys, and it bounds key
    length so an attacker cannot bloat memory with 10 KB "email" strings.
    """
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


# The process-wide limiter. A module-level singleton (rather than app state)
# because it is also used from `app/deps.py` and must be the same instance for
# every route.
_LIMITER = RateLimiter()


def get_limiter() -> RateLimiter:
    """Return the process-wide `RateLimiter`."""
    return _LIMITER
