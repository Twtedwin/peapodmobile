"""
SCRIPT: services/security/scripts/seed_demo.py

PURPOSE
    Create verified email/password credentials for the four demo profiles
    that `services/api` seeds (fixed UUIDs in services/api/src/db/seed.ts).
    This script never writes domain rows -- only `auth_credentials`.

INPUTS  : DATABASE_URL (same Postgres as the API)
OUTPUTS : four credential rows, password printed once

Run AFTER `npm run db:seed` so the `users` profiles already exist.

    cd services/security
    python scripts/seed_demo.py

The password is the same for every demo account, 12 characters, labelled
as a development secret. Production must never run this.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path

# Allow `python scripts/seed_demo.py` from the service directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.db import create_owned_tables, session_scope
from app.models import AuthCredential, normalise_email
from app.security.passwords import hash_password

DEMO_PASSWORD = "peapod-demo-12"

DEMO_USERS = [
    (uuid.UUID("00000000-0000-0000-0000-000000000001"), "alex@peapod.local"),
    (uuid.UUID("00000000-0000-0000-0000-000000000002"), "sarah@peapod.local"),
    (uuid.UUID("00000000-0000-0000-0000-000000000003"), "john@peapod.local"),
    (uuid.UUID("00000000-0000-0000-0000-000000000004"), "emily@peapod.local"),
]


async def main() -> None:
    if os.environ.get("ENVIRONMENT") == "production":
        raise SystemExit("Refusing to seed demo credentials in production.")

    # Tables are normally created on uvicorn boot. Create them here so this
    # script can run before the security process is started.
    await create_owned_tables()

    async with session_scope() as session:
        created = 0
        for user_id, email in DEMO_USERS:
            normalised = normalise_email(email)
            existing = (
                await session.execute(
                    select(AuthCredential).where(AuthCredential.user_id == user_id)
                )
            ).scalar_one_or_none()
            if existing:
                continue
            session.add(
                AuthCredential(
                    user_id=user_id,
                    email=normalised,
                    password_hash=hash_password(DEMO_PASSWORD),
                    email_verified=True,
                )
            )
            created += 1
        await session.commit()

    print(f"seed_demo: inserted {created} credential(s).")
    print(f"password (development only): {DEMO_PASSWORD}")
    print("log in as alex@peapod.local")


if __name__ == "__main__":
    asyncio.run(main())
