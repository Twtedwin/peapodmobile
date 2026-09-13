"""
MODULE: app.authz

PURPOSE
    The single source of truth for "may this user do this to that?". The
    Node API never decides this itself: every mutating (and most read)
    request calls `POST /internal/authorize`, which is a thin wrapper around
    `authorize()` in this file.

INPUTS  : a user id, an action string, and a resource descriptor
OUTPUTS : `{allowed: bool, reason: str}`

CALLED BY
    `app/routes/internal.py` only. Clients never hit this module directly.

=============================================================================
RULE MATRIX (the whole point of this file)
=============================================================================
Platform admin (`users.role = 'admin'`) is an escape hatch on every *known*
action. An unknown action is still denied even for a platform admin -- a
typo must never become an implicit allow-all.

    Action                      Who is allowed
    --------------------------  ----------------------------------------------
    pod.create                  Any authenticated user (they become the Seed).
    pod.update                  Pod admin (UI: "Seed") OR platform admin.
    pod.delete                  Pod admin OR platform admin.
    pod.invite                  Pod admin OR platform admin.
    pod.remove_member           Pod admin OR platform admin.
    pod.change_role             Pod admin OR platform admin.

    record.create               Member of `resource.pod_id` (or any
                                authenticated user when the record is not
                                pod-scoped).
    record.read                 Member of the pod; OR, for a personal
                                (no-pod) record, `created_by_id == user`.
    record.update               Owner (`created_by_id == user`) AND, when
                                pod-scoped, still a member. Platform admin
                                bypasses both.
    record.delete               Same as record.update.

    notification.read           `recipient_id == user` OR creator
                                (`created_by_id == user`) OR platform admin.
    notification.update         Same.
    notification.delete         Same.

"Pod admin" means `pod_memberships.role = 'admin'` for that `(user, pod)`.
That role is shown in the UI as a "Seed". It is NOT `users.role` -- mixing
the two would silently promote every pod Seed to a Peapod operator.

=============================================================================
MEMBERSHIP IS REFLECTED, NOT OWNED
=============================================================================
`pod_memberships` is created and migrated by `services/api`. We query it
with raw SQL so this service cannot accidentally emit DDL for it. If the
table is missing (API has not migrated yet, or we are running in isolation)
the check returns "unavailable" and the decision is DENY -- except for a
platform admin, who is allowed through so an operator can still recover a
broken environment.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.exc import ProgrammingError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import UserProfile

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Actions the API is allowed to ask about. Anything else is denied.
# ---------------------------------------------------------------------------


class AuthzAction(StrEnum):
    """The closed set of actions `/internal/authorize` understands."""

    POD_CREATE = "pod.create"
    POD_UPDATE = "pod.update"
    POD_DELETE = "pod.delete"
    POD_INVITE = "pod.invite"
    POD_REMOVE_MEMBER = "pod.remove_member"
    POD_CHANGE_ROLE = "pod.change_role"
    RECORD_CREATE = "record.create"
    RECORD_READ = "record.read"
    RECORD_UPDATE = "record.update"
    RECORD_DELETE = "record.delete"
    NOTIFICATION_READ = "notification.read"
    NOTIFICATION_UPDATE = "notification.update"
    NOTIFICATION_DELETE = "notification.delete"


#: Pod mutations that require the Seed role (or a platform admin).
POD_MUTATIONS: frozenset[AuthzAction] = frozenset(
    {
        AuthzAction.POD_UPDATE,
        AuthzAction.POD_DELETE,
        AuthzAction.POD_INVITE,
        AuthzAction.POD_REMOVE_MEMBER,
        AuthzAction.POD_CHANGE_ROLE,
    }
)

#: In-pod role stored on `pod_memberships.role`. 'admin' is the Seed.
POD_ROLE_ADMIN = "admin"

#: Raw SQL against the API-owned table. Bound parameters only -- never
#: interpolate user input into the statement text.
_MEMBERSHIP_SQL = text(
    """
    SELECT role
    FROM pod_memberships
    WHERE user_id = :user_id
      AND pod_id = :pod_id
    LIMIT 1
    """
)


@dataclass(frozen=True, slots=True)
class AuthzDecision:
    """Outcome of `authorize`. Serialised as `{allowed, reason}`."""

    allowed: bool
    reason: str

    def as_dict(self) -> dict[str, bool | str]:
        """JSON-ready payload for the internal HTTP response."""
        return {"allowed": self.allowed, "reason": self.reason}


def allow(reason: str) -> AuthzDecision:
    """Shorthand for a successful decision."""
    return AuthzDecision(True, reason)


def deny(reason: str) -> AuthzDecision:
    """Shorthand for a failed decision. Fail-closed is the default."""
    return AuthzDecision(False, reason)


def is_platform_admin(user: UserProfile) -> bool:
    """Whether `user` is a Peapod operator.

    Parameters
    ----------
    user:
        The live profile row. Role is read from the database, NOT from the
        access-token snapshot, so a demotion takes effect on the next
        authorize call rather than waiting out the 15-minute access TTL.

    Returns
    -------
    True only for `role == "admin"`. Any other string (including a future
    unknown role) is treated as a regular user -- fail closed.
    """
    return user.role == "admin"


def _as_uuid(value: object) -> uuid.UUID | None:
    """Parse a UUID from a resource field. Invalid values become None.

    A malformed id must not 500 the authorize call (the API would then fail
    open or fail closed unpredictably). Treating it as missing makes the
    relevant branch deny for lack of data, which is the safe direction.
    """
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


@dataclass(frozen=True, slots=True)
class ResourceView:
    """The subset of a resource descriptor this engine actually reads."""

    id: uuid.UUID | None
    pod_id: uuid.UUID | None
    created_by_id: uuid.UUID | None
    recipient_id: uuid.UUID | None
    kind: str | None


def parse_resource(resource: dict[str, Any] | None) -> ResourceView:
    """Extract recognised keys from the API's resource object.

    Parameters
    ----------
    resource:
        Free-form JSON. Missing / null / garbage values become None.

    Returns
    -------
    `ResourceView`. `pod_id` falls back to `id` when `kind` looks like a
    pod (or when `pod_id` is absent and `id` is the only identifier) -- the
    API sometimes sends `{id: <pod uuid>}` for pod mutations.
    """
    resource = resource or {}
    kind = str(resource["kind"]) if resource.get("kind") is not None else None
    resource_id = _as_uuid(resource.get("id"))
    pod_id = _as_uuid(resource.get("pod_id"))
    # For pod.* actions the row IS the pod, so `id` is the pod id.
    if pod_id is None and kind in (None, "pod"):
        pod_id = resource_id
    return ResourceView(
        id=resource_id,
        pod_id=pod_id,
        created_by_id=_as_uuid(resource.get("created_by_id")),
        recipient_id=_as_uuid(resource.get("recipient_id")),
        kind=kind,
    )


class MembershipUnavailable(Exception):
    """`pod_memberships` could not be queried (missing table / schema drift)."""


async def _lookup_membership_role(
    session: AsyncSession,
    user_id: uuid.UUID,
    pod_id: uuid.UUID,
) -> str | None:
    """Return the in-pod role, or None if the user is not a member.

    Parameters
    ----------
    session:
        Request-scoped session.
    user_id, pod_id:
        The pair to look up. Units: UUIDs, matching the API's columns.

    Returns
    -------
    The `role` string (`'admin'` or `'member'`), or None.

    Raises
    ------
    MembershipUnavailable
        The table does not exist or the query failed in a way that indicates
        schema absence. The caller DENIES (unless platform admin, which is
        decided before this is called).

    Why raw SQL
    -----------
    Mapping `pod_memberships` as an ORM class would put it on
    `Base.metadata`, and the next `create_all` / alembic autogenerate would
    be tempted to own it. `text()` keeps the API's table out of our
    metadata entirely.
    """
    try:
        result = await session.execute(
            _MEMBERSHIP_SQL,
            {"user_id": user_id, "pod_id": pod_id},
        )
        row = result.first()
    except ProgrammingError as exc:
        # UndefinedTableError and friends. The transaction is now aborted
        # in PostgreSQL; roll back so the caller can still write an audit
        # row in a fresh transaction if they want.
        await session.rollback()
        logger.error(
            "pod_memberships is unavailable (API-owned table missing or drifted): %s",
            type(getattr(exc, "orig", exc)).__name__,
        )
        raise MembershipUnavailable from exc
    except SQLAlchemyError as exc:
        await session.rollback()
        logger.error("pod_memberships query failed: %s", type(exc).__name__)
        raise MembershipUnavailable from exc

    if row is None:
        return None
    role = row[0]
    return str(role) if role is not None else None


async def is_pod_member(
    session: AsyncSession,
    user_id: uuid.UUID,
    pod_id: uuid.UUID,
) -> bool:
    """Whether `user_id` currently belongs to `pod_id`.

    Returns
    -------
    True if a membership row exists, regardless of role.

    Raises
    ------
    MembershipUnavailable
        See `_lookup_membership_role`.
    """
    role = await _lookup_membership_role(session, user_id, pod_id)
    return role is not None


async def is_pod_admin(
    session: AsyncSession,
    user_id: uuid.UUID,
    pod_id: uuid.UUID,
) -> bool:
    """Whether `user_id` is the Seed (pod admin) of `pod_id`.

    Returns
    -------
    True only for `role == 'admin'`. A regular member is False.
    """
    role = await _lookup_membership_role(session, user_id, pod_id)
    return role == POD_ROLE_ADMIN


async def authorize(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    action: str,
    resource: dict[str, Any] | None,
) -> AuthzDecision:
    """Decide whether `user_id` may perform `action` on `resource`.

    Parameters
    ----------
    session:
        Used to load the live profile and (when needed) `pod_memberships`.
    user_id:
        The principal. Taken from the API, which got it from
        `/internal/verify-token` -- we still load the live row so a deleted
        or demoted user cannot ride a leftover token's `sub`.
    action:
        One of `AuthzAction` values. Unknown strings are denied.
    resource:
        Optional descriptor. See `parse_resource` for recognised keys.

    Returns
    -------
    `AuthzDecision`. `reason` is for the API's logs and our audit log, not
    for the end user.

    Algorithm
    ---------
    1. Load the live profile. No profile -> deny ("user not found").
    2. Parse the action. Unknown -> deny, even for platform admins.
    3. Platform admin -> allow (known actions only).
    4. Dispatch on the action family (pod / record / notification).
    5. Membership queries that fail because the table is missing -> deny.
    """
    profile = (
        await session.execute(select(UserProfile).where(UserProfile.id == user_id))
    ).scalar_one_or_none()
    if profile is None:
        return deny("user not found")

    try:
        parsed_action = AuthzAction(action)
    except ValueError:
        return deny("unknown action")

    # Escape hatch. Checked AFTER the action is known so a typo cannot
    # authorise an endpoint we have never reasoned about.
    if is_platform_admin(profile):
        return allow("platform admin")

    view = parse_resource(resource)

    try:
        if parsed_action is AuthzAction.POD_CREATE:
            # Creating a pod does not require prior membership -- the creator
            # becomes the Seed in the same API transaction.
            return allow("authenticated user may create a pod")

        if parsed_action in POD_MUTATIONS:
            return await _decide_pod_mutation(session, user_id, view)

        if parsed_action in (
            AuthzAction.RECORD_CREATE,
            AuthzAction.RECORD_READ,
            AuthzAction.RECORD_UPDATE,
            AuthzAction.RECORD_DELETE,
        ):
            return await _decide_record(session, user_id, parsed_action, view)

        if parsed_action in (
            AuthzAction.NOTIFICATION_READ,
            AuthzAction.NOTIFICATION_UPDATE,
            AuthzAction.NOTIFICATION_DELETE,
        ):
            return _decide_notification(user_id, view)
    except MembershipUnavailable:
        return deny("membership table unavailable")

    return deny("unknown action")


async def _decide_pod_mutation(
    session: AsyncSession,
    user_id: uuid.UUID,
    view: ResourceView,
) -> AuthzDecision:
    """Pod update / delete / invite / remove_member / change_role."""
    # The row IS the pod for these actions, so `id` is an acceptable alias
    # for `pod_id` when the API sends only one of them.
    pod_id = view.pod_id or view.id
    if pod_id is None:
        return deny("pod_id required")
    if await is_pod_admin(session, user_id, pod_id):
        return allow("pod admin (Seed)")
    return deny("pod admin required")


async def _decide_record(
    session: AsyncSession,
    user_id: uuid.UUID,
    action: AuthzAction,
    view: ResourceView,
) -> AuthzDecision:
    """Pod-scoped and personal records.

    Ownership branch
    ----------------
    `created_by_id == user` is the owner. Update and delete require it so
    that being in a pod does not let you edit someone else's ping, place,
    or plan. Create and read of a *pod-scoped* row only require membership:
    the whole point of a pod is that members can see each other's location
    and plans.

    Personal records (no `pod_id`) fall back to ownership for every verb,
    including create (anyone authenticated may create a personal row --
    there is no pod to be a member of).
    """
    if view.pod_id is not None:
        member = await is_pod_member(session, user_id, view.pod_id)
        if not member:
            return deny("pod membership required")
        if action in (AuthzAction.RECORD_CREATE, AuthzAction.RECORD_READ):
            return allow("pod member")
        # update / delete: still a member (checked above) AND owner.
        if view.created_by_id is None:
            return deny("created_by_id required for ownership check")
        if view.created_by_id == user_id:
            return allow("record owner")
        return deny("record owner required")

    # Not pod-scoped: ownership is the only lever.
    if action is AuthzAction.RECORD_CREATE:
        return allow("authenticated user may create a personal record")
    if view.created_by_id is None:
        return deny("created_by_id required for ownership check")
    if view.created_by_id == user_id:
        return allow("record owner")
    return deny("record owner required")


def _decide_notification(user_id: uuid.UUID, view: ResourceView) -> AuthzDecision:
    """Notifications are addressed to one person.

    The recipient must be able to mark-read / dismiss. The creator (usually
    a system job running as a user, or a member who nudged) must be able to
    retract. Platform admin is already handled by the caller.
    """
    if view.recipient_id is not None and view.recipient_id == user_id:
        return allow("notification recipient")
    if view.created_by_id is not None and view.created_by_id == user_id:
        return allow("notification creator")
    return deny("notification recipient or creator required")
