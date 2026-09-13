# syntax=docker/dockerfile:1
#
# PURPOSE
#   Build the peapod-compute HTTP server (and its tiny healthcheck binary)
#   into a non-root runtime image.
#
# BUILD CONTEXT
#   The REPO ROOT, not this directory. `src/rules.rs` pulls the shared rule
#   JSON in with `include_str!("../../../packages/shared/data/rules/...")`,
#   which is resolved at compile time relative to that source file. The
#   copies below recreate the same tree the compiler sees in a checkout:
#
#     /src/services/compute/src/rules.rs
#     /src/packages/shared/data/rules/*.json
#
#   docker-compose.yml already sets `context: .` and
#   `dockerfile: services/compute/Dockerfile`.
#
# RUNTIME
#   Non-root user, PORT 8082, catalog loaded from TRAVEL_DATASET_PATH (the
#   compose file bind-mounts the catalog over /app/data). A missing catalog
#   is non-fatal -- the itinerary generator falls back to a synthetic plan.

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM rust:1-slim AS builder

WORKDIR /src

# Rule JSON must exist BEFORE `cargo build` so `include_str!` in
# services/compute/src/rules.rs can read:
#   ../../../packages/shared/data/rules/{geo,progression,decisions,garden}.json
COPY packages/shared/data/rules packages/shared/data/rules
# The catalog is not embedded, but copying it into the builder tree keeps a
# single COPY pattern and lets local `cargo test` inside the image find it
# via CARGO_MANIFEST_DIR/../../packages/shared/data/catalog/.
COPY packages/shared/data/catalog packages/shared/data/catalog
COPY services/compute services/compute

WORKDIR /src/services/compute

# --bins builds peapod-compute (src/main.rs) and healthcheck (src/bin/).
RUN cargo build --release --bins

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# ca-certificates is not required for the TCP healthcheck, but a future
# outbound call (and the debian slim convention) is cheaper than a surprise.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 peapod \
    && useradd --system --uid 10001 --gid peapod --home-dir /app --create-home peapod

WORKDIR /app

COPY --from=builder /src/services/compute/target/release/peapod-compute /app/peapod-compute
COPY --from=builder /src/services/compute/target/release/healthcheck /app/healthcheck
COPY packages/shared/data/catalog/travel-dataset.json /app/data/travel-dataset.json

RUN chown -R peapod:peapod /app \
    && chmod 0755 /app/peapod-compute /app/healthcheck

USER peapod

ENV PORT=8082
ENV TRAVEL_DATASET_PATH=/app/data/travel-dataset.json
ENV RUST_LOG=info

EXPOSE 8082

# Compose also declares this; keeping it on the image means `docker run` is
# healthy without compose. The binary TCP-connects to 127.0.0.1:$PORT.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD ["/app/healthcheck"]

CMD ["/app/peapod-compute"]
