# =============================================================================
# Peapod API -- Node 20 slim
# =============================================================================
#
# BUILD CONTEXT IS THE REPO ROOT (see docker-compose.yml). This service needs
# `packages/shared` for the contract and the rule JSON, so we cannot build
# from `services/api/` alone.
#
# Two stages:
#   build       -- install everything, compile @peapod/shared then this service
#   production  -- copy the compiled output and production node_modules
#
# Local iteration does not use this file: `npm run dev --workspace=@peapod/api`
# runs `tsx watch` against TypeScript source. This Dockerfile is the compiled
# production image (`node dist/index.js`).
#
# WHY COPY bootstrap.sql EXPLICITLY
#   tsc only emits `.js` from `.ts`. The hand-written schema script is read
#   at runtime by `ensureSchema()`, so it has to land next to `dist/db/ensure.js`.

FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api/package.json ./services/api/

RUN npm ci --workspace=@peapod/shared --workspace=@peapod/api --include-workspace-root

COPY packages/shared ./packages/shared
COPY services/api ./services/api

RUN npm run build --workspace=@peapod/shared \
 && npm run build --workspace=@peapod/api \
 && mkdir -p services/api/dist/db \
 && cp services/api/src/db/bootstrap.sql services/api/dist/db/bootstrap.sql


FROM node:20-slim AS production
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/api/package.json ./services/api/

# Production install. tsx is not needed: we run the compiled ESM.
RUN npm ci --omit=dev --workspace=@peapod/shared --workspace=@peapod/api --include-workspace-root

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/data ./packages/shared/data
COPY --from=build /app/packages/shared/src ./packages/shared/src
COPY --from=build /app/services/api/dist ./services/api/dist
COPY --from=build /app/services/api/src/db/bootstrap.sql ./services/api/src/db/bootstrap.sql

WORKDIR /app/services/api
EXPOSE 8080
CMD ["node", "dist/index.js"]
