# AGENTS.md

## Project

Peapod is a polyglot, mobile-first monorepo. The Expo app talks only to `services/api`. There is no hosted-backend SDK in this tree.

Start with `README.md` for local setup and the Expo Go → Play Store / TestFlight path. External keys: `SETUP-EXTERNAL-APIS.md`.

## Layout

- `apps/mobile` — Expo SDK 57, TypeScript, Expo Go compatible for foreground development; EAS builds add background location through Expo modules.
- `services/api` — Fastify, Drizzle, WebSocket, cron. The only public HTTP surface.
- `services/security` — FastAPI. The only process that may touch password hashes, OTP codes, or refresh tokens.
- `services/compute` — axum. Stateless maths. Optional at runtime; API has TypeScript fallbacks.
- `packages/shared` — JSON Schemas, rule/catalog JSON, TypeScript types and algorithm twins.

## Commands

```bash
npm install
npm run build:shared
docker compose up -d postgres compute
npm run db:migrate && npm run db:seed
npm run dev:api
npm run dev:security
npm run dev:mobile
npm run check
```

## Conventions

- Comment as if the reader has never seen this codebase: module headers (purpose, inputs, outputs, caller), units on numbers (metres, seconds, minor currency units), and a `why` on every threshold.
- Money is integer minor units. Never floats.
- Decide Together votes stay hidden until every member has voted. Do not serialise tallies while `all_voted` is false.
- Wallet responses stay `{ simulated: true }` until a payment provider is actually wired.
- Any algorithm change must be made in **both** `services/compute` (Rust) and `packages/shared/src/algorithms` (TypeScript). API parity tests exist to catch one-sided edits.
- Relative imports in `services/api` are ESM: use `.js` extensions in `.ts` files.
- Do not add a custom native module if you want Expo Go to keep working.

## Quality

Run the relevant checks from the root `package.json` (`npm run check`, `npm test`) before finishing code changes.
