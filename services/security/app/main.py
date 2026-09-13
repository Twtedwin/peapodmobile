"""
MODULE: app.main

PURPOSE
    Assemble the FastAPI application: lifespan (create owned tables, dispose
    the engine), CORS, routers, a liveness probe, and optional request-id
    plumbing.

INPUTS  : process environment via `app.config.get_settings()`
OUTPUTS : the ASGI `app` object `uvicorn` serves

CALLED BY
    `uvicorn app.main:app --host 0.0.0.0 --port 8081` (Dockerfile CMD, and
    the local `uvicorn --reload` workflow).

PORT
    8081. `services/api` is 8080 and `services/compute` is 8082, so a
    developer looking at `localhost:8081` knows they are on the credential
    process. The Dockerfile CMD hard-codes the port; `PORT` in compose is
    documentation for operators, not read here, because a mismatch between
    EXPOSE and the actually-bound port is how health checks go green
    against the wrong process.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.config import get_settings
from app.db import assert_api_tables_present, create_owned_tables, dispose_engine
from app.routes.auth import router as auth_router
from app.routes.internal import router as internal_router
from app.routes.oauth import router as oauth_router
from app.security.passwords import describe_parameters

logger = logging.getLogger(__name__)


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Stamp every request and response with `X-Request-ID`.

    If the caller already sent one we echo it (so a trace that started in
    the Node API continues here); otherwise we mint a UUID4. Optional in
    the sense that nothing *functional* depends on it -- it is how you
    grep one login attempt out of a JSON log stream after an incident.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Create the tables this service owns, then tear the engine down.

    `create_owned_tables` is a convenience for a first boot against an
    empty database; `alembic/` remains the source of truth for schema
    changes. `users` is deliberately not created -- see `app/db.py`.
    """
    await create_owned_tables()
    await assert_api_tables_present()
    logger.info(
        "peapod-security listening (issuer=%s audience=%s)",
        get_settings().JWT_ISSUER,
        get_settings().JWT_AUDIENCE,
    )
    try:
        yield
    finally:
        await dispose_engine()


def create_app() -> FastAPI:
    """Build a configured FastAPI application.

    Returns
    -------
    A new `FastAPI` instance. Extracted from module level so tests can
    import the factory without binding a socket or opening a database
    connection (the lifespan does that, and tests that only care about
    import do not run the lifespan).
    """
    settings = get_settings()
    application = FastAPI(
        title="Peapod security",
        description=(
            "Authentication, credentials, and the single source of truth for "
            "authorization decisions. Issuer "
            f"`{settings.JWT_ISSUER}`, audience `{settings.JWT_AUDIENCE}`."
        ),
        version="0.1.0",
        lifespan=lifespan,
    )
    application.add_middleware(RequestIdMiddleware)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(auth_router)
    application.include_router(oauth_router)
    application.include_router(internal_router)

    @application.get("/health", tags=["meta"])
    async def health() -> dict[str, object]:
        """Liveness probe. Does not touch the database on purpose.

        A health check that SELECT 1's will fail when Postgres is briefly
        unreachable and an orchestrator will kill a process that was
        otherwise fine -- then the thundering herd of replacements makes
        the outage worse. Readiness (should we receive traffic?) is a
        different probe and belongs at the compose/k8s layer.
        """
        return {
            "status": "ok",
            "service": "peapod-security",
            "environment": settings.ENVIRONMENT,
            "jwt_algorithm": settings.jwt_algorithm,
            "issuer": settings.JWT_ISSUER,
            "audience": settings.JWT_AUDIENCE,
            "password_hash": describe_parameters(),
        }

    return application


# The object uvicorn loads: `uvicorn app.main:app`.
app = create_app()
