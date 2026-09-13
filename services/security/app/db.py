"""
MODULE: app.db

PURPOSE
    Own the single async SQLAlchemy engine for this process and hand out
    request-scoped `AsyncSession` objects to FastAPI route handlers.

INPUTS
    `Settings.DATABASE_URL` (already normalised onto the asyncpg driver by
    `app/config.py`).

OUTPUTS
    * `get_engine()`      -- the lazily built, process-wide `AsyncEngine`.
    * `get_session()`     -- an async generator used as a FastAPI dependency.
    * `session_scope()`   -- an async context manager for code outside a
                             request (startup checks, background tasks, tests).
    * `create_owned_tables()` / `assert_api_tables_present()` -- called from
      the app lifespan in `app/main.py`.

CALLED BY
    `app/routes/*` (via dependency injection), `app/main.py` (lifespan), and
    `alembic/env.py` (which builds its own engine from the same URL).

TRANSACTION POLICY (read this before writing a route)
    The session dependency does NOT commit for you. Route handlers commit
    explicitly, because in this service the decision of *when* a change becomes
    durable is security-relevant: a failed-login attempt counter must be
    committed even though the request ends in a 401, whereas a half-finished
    registration must not leave a credential row behind. An implicit
    "commit if no exception" wrapper gets both of those wrong.

    The dependency DOES roll back and always closes, so a handler that raises
    can never leak an open transaction and hold locks on `auth_credentials`.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncIterator

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings
from app.models import OWNED_TABLES, USERS_TABLE_NAME, Base

logger = logging.getLogger(__name__)

# Built on first use rather than at import time so that importing `app.db`
# (which `app.models` consumers do transitively) never opens sockets. Tests
# import these modules without a database available.
_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Return the process-wide `AsyncEngine`, creating it on first call.

    Returns
    -------
    The shared engine. Safe to call from any coroutine; engine creation itself
    performs no I/O (asyncpg connects lazily on first checkout).

    Pool sizing
    -----------
    `pool_size=5, max_overflow=5` -> at most 10 connections per worker. This
    service does small, fast queries (one or two per auth request), so a large
    pool buys nothing and risks exhausting PostgreSQL's `max_connections`,
    which is shared with `services/api` and `services/compute`.

    `pool_pre_ping=True` costs one trivial round trip per checkout and makes
    the service survive a database failover or an idle-connection reaper
    without returning 500s for the first request after the connection died.
    """
    global _engine, _session_factory
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.DATABASE_URL,
            # NEVER turn this on outside a local debugging session: SQLAlchemy's
            # echo prints bound parameters, and our bound parameters include
            # password hashes and token hashes.
            echo=False,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=5,
            # Recycle connections before a typical cloud load balancer's idle
            # timeout (often 300-600 s) silently kills them.
            pool_recycle=280,
        )
        _session_factory = async_sessionmaker(
            _engine,
            # Keep attribute values readable after `commit()`. Without this,
            # touching any attribute of a committed ORM object triggers a
            # refresh SELECT, which inside an already-returned response means
            # a `MissingGreenlet` error. Standard for async SQLAlchemy.
            expire_on_commit=False,
            autoflush=False,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Return the session factory, building the engine if needed."""
    get_engine()
    assert _session_factory is not None  # set together with _engine
    return _session_factory


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding one `AsyncSession` per request.

    Yields
    ------
    An `AsyncSession` bound to the shared engine.

    Guarantees
    ----------
    * On a handler exception the transaction is rolled back, so a partially
      applied credential change is never left visible.
    * The session is closed (connection returned to the pool) in all cases.
    * No implicit commit -- see the module docstring.
    """
    factory = get_session_factory()
    session = factory()
    try:
        yield session
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


@contextlib.asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Async context manager version of `get_session` for non-request code.

    Used by the startup lifespan and by scripts. Same no-implicit-commit
    policy: the caller commits.
    """
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


async def create_owned_tables() -> None:
    """Create the tables this service owns, if they do not exist.

    This is a convenience for local development and for a first boot against an
    empty database; `alembic/` remains the source of truth for schema changes
    (see `alembic/versions/0001_initial_security_tables.py`).

    IMPORTANT
    ---------
    Only `OWNED_TABLES` are created. The `users` profile table is deliberately
    excluded: its schema is owned by `services/api/src/db/schema.ts` and
    creating it from here would produce a subtly different table (missing
    columns the API expects, wrong defaults) that the API's own migrations
    would then refuse to reconcile.
    """
    engine = get_engine()
    async with engine.begin() as connection:
        await connection.run_sync(
            Base.metadata.create_all,
            tables=list(OWNED_TABLES),
            checkfirst=True,
        )
    logger.info(
        "security service: ensured %d owned tables exist (%s)",
        len(OWNED_TABLES),
        ", ".join(table.name for table in OWNED_TABLES),
    )


async def assert_api_tables_present() -> None:
    """Warn loudly if the API-owned `users` table is missing.

    Returns
    -------
    None. This function never raises: the security service is allowed to boot
    without `users` so that `/health` answers and an operator can see the
    problem, but registration and `/auth/me` will fail until the API has
    migrated.

    Why a warning and not a hard failure
    ------------------------------------
    In a compose stack the two services start concurrently. Crash-looping
    because the Node API has not finished its migration yet turns a five second
    race into an outage.
    """
    engine = get_engine()
    async with engine.connect() as connection:
        table_names = await connection.run_sync(
            lambda sync_connection: inspect(sync_connection).get_table_names()
        )
    if USERS_TABLE_NAME not in table_names:
        logger.error(
            "security service: table %r is MISSING. It is owned by "
            "services/api/src/db/schema.ts -- run the API's migrations. "
            "Registration and /auth/me will fail until then.",
            USERS_TABLE_NAME,
        )


async def dispose_engine() -> None:
    """Close every pooled connection. Called on application shutdown."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _session_factory = None
