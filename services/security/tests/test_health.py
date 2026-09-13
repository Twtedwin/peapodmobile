"""
Smoke tests that do not need a database.

The security service's lifespan opens Postgres; these tests import the app
factory without running that lifespan, so CI can assert the module graph
loads (missing imports, a Settings validator raising, a circular import)
without standing up Docker.
"""

from __future__ import annotations


def test_create_app_imports() -> None:
    """The FastAPI app factory must be importable with default settings."""
    from app.main import create_app

    application = create_app()
    paths = {getattr(route, "path", "") for route in application.routes}
    assert "/health" in paths
    assert "/auth/register" in paths
    assert "/auth/login" in paths
    assert "/internal/verify-token" in paths
    assert "/internal/authorize" in paths
    assert application.title == "Peapod security"


def test_module_level_app_exists() -> None:
    """uvicorn loads `app.main:app`; that attribute must exist after import."""
    from app.main import app

    assert app is not None
    assert app.router is not None
