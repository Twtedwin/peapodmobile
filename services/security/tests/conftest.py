"""
PACKAGE: tests

PURPOSE
    Pytest suite for the Peapod security service. This conftest makes the
    `app` package importable when pytest is launched from `services/security`
    and forces `ENVIRONMENT=test` so production guard rails in Settings
    do not trip on the development JWT secret.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# `services/security` is the project root for this suite. Inserting it lets
# `from app.main import create_app` work without an editable install.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Set before any `app.config` import so the cached Settings picks it up.
os.environ.setdefault("ENVIRONMENT", "test")
