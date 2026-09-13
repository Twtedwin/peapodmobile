# =============================================================================
# services/security/Dockerfile
#
# PURPOSE
#   Production image for the Peapod security service -- the only process that
#   holds password hashes, OTP codes, and refresh tokens.
#
# BUILD
#   From the REPOSITORY ROOT (not from this directory):
#
#       docker build -f services/security/Dockerfile -t peapod-security .
#
#   The context is the repo root because docker-compose.yml builds every
#   service that way (they share `packages/shared/` for the contract). This
#   image only copies `services/security/`, but matching the context keeps
#   compose and a hand-typed `docker build` equivalent.
#
# RUN
#   Listens on 8081. Non-root. `uvicorn app.main:app` -- WORKDIR is `/app`
#   and the package is copied to `/app/app`, so `import app` resolves.
# =============================================================================

FROM python:3.12-slim

# Don't write .pyc files; flush stdout so the DEV EMAIL FALLBACK banner
# (and everything else) shows up in `docker logs` immediately rather than
# sitting in a block buffer until the process exits.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# A dedicated uid, not 1000, so a bind-mount from a developer laptop (uid
# 1000) cannot accidentally write into the image's files as the service user.
RUN groupadd --gid 10001 peapod \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin peapod

WORKDIR /app

# Requirements first so a code-only change does not bust the pip layer.
COPY services/security/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# The `app` package. Copied as `/app/app` so `uvicorn app.main:app` works
# with WORKDIR `/app` and no extra PYTHONPATH.
COPY services/security/app /app/app

RUN chown -R peapod:peapod /app

USER peapod

EXPOSE 8081

# Port is hard-coded to match EXPOSE and docker-compose. Do not read $PORT
# here: a compose file that sets PORT=8081 while the process binds 8000
# (uvicorn's default) is a silent health-check lie.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8081"]
