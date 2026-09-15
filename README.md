# Peapod

A shared-life app for **pods** — small groups (couples, families, close friends) whose members are called **peas**. Live location, collaborative trip planning, swipe-to-decide ideas, a gamified 3D world that grows from real shared activity, and a simulated shared wallet.

This repository is a polyglot, mobile-first monorepo. The Expo app talks only to the Node API.

> Migrated from a Base44 Vite web prototype. That platform is gone: every former hosted capability is reimplemented in the services below. A repo-wide search for `base44` should hit only this note.

## Layout

```
apps/mobile          Expo SDK 57 + React Native 0.86 + TypeScript (Expo Go)
services/api         Node + TypeScript (Fastify) — REST, WebSocket, Postgres, cron
services/security    Python 3.12 (FastAPI) — auth, JWT, OTP, OAuth, RBAC, audit
services/compute     Rust (axum) — geo, trip reconstruction, decisions, XP, splits, itineraries
packages/shared      TypeScript types, JSON Schemas, rule JSON, TypeScript algorithm fallbacks
```

Language split, by fit:

| Concern | Language | Why |
|---------|----------|-----|
| UI | TypeScript / React Native | Expo Go, typed screens |
| HTTP + realtime + persistence | Node / TypeScript | Fastify, Drizzle, one surface for the app |
| Credentials and authorization | Python | Argon2id, PyJWT, audited crypto |
| Maths | Rust | GPS pipelines, integer money, itineraries |
| Contract | JSON Schema + JSON catalogs | One copy of every threshold, four languages consume it |

Rust is a **server-side** service, not a native module. Expo Go cannot link custom native code. If compute is down, `services/api` falls back to the TypeScript twins in `packages/shared/src/algorithms/`.

## Prerequisites

- Node 20+
- Python 3.12
- Docker (Postgres + the Rust service; no local Rust toolchain required)
- Expo Go on a phone, or an Android emulator / iOS simulator
- Optional: a Rust toolchain if you want to iterate on `services/compute` outside Docker

## First run

```bash
cp .env.example .env
npm install
npm run build:shared
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run seed:security
```

The Rust compute service is optional. Leave `COMPUTE_ENABLED=false` (the default) so the API uses the TypeScript maths fallback. Start compute later with `npm run infra:compute` and set `COMPUTE_ENABLED=true` if you want the Rust path.

Then start the security service, API, and Metro in three terminals:

```bash
npm run dev:api
npm run dev:security
npm run dev:mobile
```

Scan the QR code with **Expo Go**.

On a **physical phone**, `localhost` is the phone. `EXPO_PUBLIC_API_URL` is
required and is the app's single network origin. HTTP, authentication, location,
pod sync, private messages, and the derived WebSocket URL all use it.

```bash
# Windows
ipconfig
# macOS / Linux
ip addr
```

Choose the IPv4 address for the adapter on the same Wi-Fi as the phone, not a
VPN, Ethernet, Docker, or disconnected adapter. Put it in the repository-root
`.env`, which `app.config.ts` explicitly loads for Expo and EAS:

```dotenv
EXPO_PUBLIC_API_URL=http://192.168.1.42:8080
```

Then restart Metro with `npx expo start --clear`. Verify
`http://192.168.1.42:8080/health` from the phone browser. If it fails, confirm
`npm run dev:api` is listening on `0.0.0.0:8080` and allow TCP 8080 through the
host firewall.

Android Emulator users must explicitly set
`EXPO_PUBLIC_API_URL=http://10.0.2.2:8080`; there is no hardcoded fallback.

### Demo login

1. Open the app, tap Register, and create an account (password ≥ 10 characters).
2. Read the six-digit code from the **security** terminal (`DEV EMAIL FALLBACK`) and verify.
3. Grant location + notification permission.
4. Create a pod, or join with an invite code from Profile.

`npm run db:seed` loads a demo pod onto four fixed profile UUIDs. Then seed credentials:

```bash
npm run seed:security
```

Log in as `alex@peapod.local` / `peapod-demo-12` (development only). One-time codes for new registrations are printed to the **security** terminal (`DEV EMAIL FALLBACK`) until an email provider is configured. See [SETUP-EXTERNAL-APIS.md](SETUP-EXTERNAL-APIS.md).

## Authentication

The Expo app talks **only** to `services/api`. Fastify reverse-proxies `/auth/*` onto the Python security service (`SECURITY_URL`). There is no `/api/v1` prefix. Credentials never land in Node: the body is forwarded and the security response is echoed.

```text
app  →  POST https://<api>/auth/register        →  security POST /auth/register
     →  POST https://<api>/auth/verify-otp      →  security POST /auth/verify-otp
     →  POST https://<api>/auth/resend-otp      →  security POST /auth/resend-otp
     →  POST https://<api>/auth/login           →  security POST /auth/login
     →  POST https://<api>/auth/forgot-password →  security POST /auth/forgot-password
     →  POST https://<api>/auth/reset-password  →  security POST /auth/reset-password
     →  POST https://<api>/auth/refresh         →  security POST /auth/refresh
     →  GET  https://<api>/auth/me              →  security GET  /auth/me
```

Behaviour that matters when debugging:

- **Register** returns `201 { user_id, email_sent }`. Tokens are issued only after `verify-otp`. If Resend rejects the mail, `email_sent` is `false` and the security logs print `email provider status=` plus the raw body.
- **Login** with a correct password on an unverified account is `403` (not `401`) and re-sends the OTP.
- **Forgot-password** and **resend-otp** always return `{ email_sent: true }` so they cannot enumerate accounts. Whether Resend accepted the message is in the security logs, not the JSON.
- **503** on `/auth/*` means the API could not reach `SECURITY_URL` (timeout 15s, or the loopback default on a host like Render). A 4xx from security is forwarded as-is.

`INTERNAL_SERVICE_TOKEN` is **not** sent on the public `/auth/*` proxy. The API uses it only for `/internal/verify-token` and `/internal/authorize`.

## Cloud (Render)

Current hosted API (preview EAS builds and LAN-independent testing):

| Surface | URL |
|---------|-----|
| HTTP API | `https://peapod-api.onrender.com` |
| WebSocket | `wss://peapod-api.onrender.com` (`/realtime`) |
| Security | a **separate** Render Web Service; put its HTTPS origin in the API's `SECURITY_URL` |

The production EAS profile still compiles `https://api.peapod.app` (custom domain). Until that hostname is live, use the Render origin above.

### Node API service

- Root Directory: **repository root** (`@peapod/api` depends on `@peapod/shared`; do not set Root Directory to `services/api` unless the build already copies the workspace).
- Build: `npm ci --workspace=@peapod/shared --workspace=@peapod/api --include-workspace-root && npm run build --workspace=@peapod/shared && npm run build --workspace=@peapod/api`
- Start: `npm run start --workspace=@peapod/api` (`node dist/index.js`). Render injects `PORT`. The process reads **`PORT`**, not `API_PORT`.
- Required env: `DATABASE_URL` (Render Postgres), `SECURITY_URL` (HTTPS origin of the Python service, **no trailing slash, not localhost**), `INTERNAL_SERVICE_TOKEN` (same value as security), `NODE_ENV=production`.
- Production refuses to boot if `SECURITY_URL` is missing or still `127.0.0.1` / `localhost`.

### Python security service

- Root Directory: `services/security`
- Build: `pip install -r requirements.txt`
- Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT` (Render's `$PORT`, not hardcoded `8081`)
- Required env: `DATABASE_URL` (same Postgres; `postgresql+asyncpg` is rewritten automatically), `ENVIRONMENT=production`, `INTERNAL_SERVICE_TOKEN`, RS256 `JWT_PRIVATE_KEY` + `JWT_PUBLIC_KEY` (not the HS256 `JWT_SECRET` fallback), `EMAIL_PROVIDER_API_KEY`, `EMAIL_PROVIDER_API_URL=https://api.resend.com/emails`, `EMAIL_FROM` (verified Resend domain or `Peapod <beth.t@example.com>` while testing), `PASSWORD_RESET_URL=peapod://reset-password`.
- `*.pem` files are gitignored. Paste the PEM contents into Render env vars; do not upload key files.

After a send, Render logs for the security service must show a line like `email provider status=200 body={"id":"..."}`. A 403 body naming an unverified domain is why inboxes stay empty even when the app got `201`.

## How to use the live Pod map

The Home tab is always scoped to one pod. Tap the pod name in the upper-left
header to switch among groups you created or joined. The API returns only your
memberships; knowing another pod's UUID does not grant access. The same menu can
create a pod or join one with an uppercase, six-character letter/number invite
code.

Each pea with a current location appears as an avatar marker. The controls are:

- **Your name + crosshair** — center the camera on this device's latest GPS fix.
- **Peas sharing** — the number of pod members represented on the map.
- **Group crosshair** — fit every sharing member into the camera bounds.
- **Member crosshair** — center on one pea from their expanded status card.
- **Notification bell / profile avatar** — open updates or the You tab.

Drag the **Your peas** handle upward for full member cards or downward for a
larger map. Expanded cards show last known place/time, battery, network,
distance apart, and speed. Tap **Chat** for the pod conversation. A saved place
name is shown when the latest coordinate is inside the shared geofence radius.
Use 🎉 on another pea's expanded card to send a pod-scoped nudge notification;
the target is validated as a current member by the API.

Location sharing follows the active pod. Expo Go sends foreground updates while
the Home tab is open. EAS development, preview, and production builds keep
sharing in the background after the user grants the OS “always allow”
permission. Denying background access leaves foreground sharing functional.

## Environment

All variables, with development defaults, live in [`.env.example`](.env.example). Copy to `.env`. Never commit `.env`.

The mobile app requires `EXPO_PUBLIC_API_URL`; external provider keys remain
optional for Expo Go development.

| Variable | Service | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | api, security | Postgres. Python rewrites `postgres://` onto `postgresql+asyncpg://`. There is no `SECURITY_DATABASE_URL`. |
| `PORT` | api, security (Render) | Listen port. Render injects this. The API does **not** read `API_PORT`. |
| `SECURITY_URL` | api | HTTPS origin of `services/security` (no trailing slash). Required in production; loopback default is local-only. |
| `COMPUTE_URL` / `COMPUTE_ENABLED` | api | Rust maths; `false` always uses the TypeScript fallback |
| `INTERNAL_SERVICE_TOKEN` | api, security | Shared secret for `/internal/*` only |
| `JWT_SECRET` | security | HS256 **dev** signing. Production refuses this and requires the RS256 pair. |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | security | RS256 signing in staging/production |
| `EMAIL_PROVIDER_API_KEY` | security | Resend (or compatible) API key. Required in production. |
| `EMAIL_PROVIDER_API_URL` | security | Default `https://api.resend.com/emails` |
| `EMAIL_FROM` | security | Must match a verified Resend domain (or Resend's onboarding sender while testing) |
| `PASSWORD_RESET_URL` | security | Expo deep link; default `peapod://reset-password` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | security | Optional Google sign-in |
| `GOOGLE_REDIRECT_URI` | security | API origin + `/auth/oauth/google/callback` (not `:8081`) |
| `OAUTH_SUCCESS_REDIRECT_URL` | security | Default `peapod://auth/callback` |
| `ENVIRONMENT` | security | `development` locally; `production` on Render |
| `EXPO_PUBLIC_API_URL` | mobile | Inlined into the app bundle. LAN IP for Expo Go; `https://peapod-api.onrender.com` for preview EAS. Never put a secret in `EXPO_PUBLIC_*`. |
| `EXPO_PUBLIC_WEBSOCKET_URL` | mobile | Optional. Derived from the API URL (`http`→`ws`) when unset. Preview EAS sets `wss://peapod-api.onrender.com`. |
| `GOOGLE_MAPS_IOS_API_KEY` | mobile build | Google Maps SDK for iOS key |
| `GOOGLE_MAPS_ANDROID_API_KEY` | mobile build | Google Maps SDK for Android key |

Preview EAS builds **do not** upload `.env` (it is listed in `.easignore`). Put `EXPO_PUBLIC_*` values in [`apps/mobile/eas.json`](apps/mobile/eas.json) `build.preview.env` or EAS secrets.

### Google Maps key

Home always renders `react-native-maps` with `provider={PROVIDER_GOOGLE}` and a
dark JSON style. Native EAS builds therefore require Google Maps SDK keys.
Google requires a billing-enabled Cloud project; usage may fall within its
current no-charge allowance, but the key is not inherently a secret or an
unconditionally free service.

1. In Google Cloud, enable **Maps SDK for Android** and **Maps SDK for iOS**.
2. Create platform-restricted keys: Android package `app.peapod.mobile` plus
   signing SHA-1, and iOS bundle identifier `app.peapod.mobile`.
3. Put the Android key in **`android/local.properties`** on this machine only
   (that file is gitignored). After `npx expo prebuild --platform android`,
   open `android/local.properties` and add this line — do not replace
   `sdk.dir` if it is already there:

```
MAPS_API_KEY=your_android_key
```

   See [`android-local.properties.example`](android-local.properties.example).
   Gradle reads `MAPS_API_KEY` and writes it into the manifest as
   `${MAPS_API_KEY}`. A blank `MAPS_API_KEY=` is ignored (Groovy `?:` would
   otherwise keep the empty string and hide env). For EAS cloud builds (no
   local.properties), set `GOOGLE_MAPS_ANDROID_API_KEY` as an EAS secret for
   the `preview` environment — not only a Render/backend Maps key.

```dotenv
GOOGLE_MAPS_ANDROID_API_KEY=your_android_key
GOOGLE_MAPS_IOS_API_KEY=your_ios_key
```

`apps/mobile/app.config.ts` injects the Android value into the generated native
manifest at `android.config.googleMaps.apiKey`:

```ts
android: {
  config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY } },
}
```

This is the dynamic-config equivalent of setting the Android API key in
`app.json`; do not add a second static `app.json` entry. Rebuild the APK/AAB
after changing a native key. Restarting Metro alone cannot change a native map
manifest.

After changing an `EXPO_PUBLIC_*` value, restart Metro with
`npx expo start --clear`; those values are compiled into the bundle.

## Technical breakdown

```text
Home
  ├─ React Query: pods, members, presence, places, chat, notifications
  ├─ WebSocket /realtime: invalidates the affected pod cache
  ├─ expo-location: foreground watcher or native background task
  └─ services/api: the only public HTTP/WebSocket boundary
       ├─ Postgres/Drizzle domain data
       └─ /auth proxy → services/security
```

Primary modules:

- `apps/mobile/src/services/apiClient.ts` is the only public transport/data
  boundary. It derives HTTP and WebSocket origins from `EXPO_PUBLIC_API_URL`
  and owns endpoint paths for pods, locations, pod chat, and private messages.
- `apps/mobile/src/models/api.ts` defines transport-safe User, Pod, Message,
  Presence, PhoneStatus, Place, and LocationData interfaces. Screens never
  import Drizzle/database row types.
- `apps/mobile/app/(tabs)/index.tsx` composes the map, sheets, chat, and realtime updates.
- `apps/mobile/src/components/home/PodHeader.tsx` owns safe-area-aware header controls.
- `PodSelector.tsx` lists authorized memberships and implements create/join.
- `PodMap.tsx` owns native markers and imperative camera controls.
- `PodMemberSheet.tsx` and `PodMemberCard.tsx` implement compact/expanded status UI.
- `app/direct-message/[userId].tsx` is a pod-independent private conversation
  whose messages use `pod_id = null`; presence remains an optional pod-derived
  enhancement to its pinned status card.
- `apps/mobile/src/hooks/usePodData.ts` normalizes payloads and defines pod cache keys.
- `apps/mobile/src/hooks/useLocationPings.ts` uploads GPS and battery/network telemetry.
- `apps/mobile/src/location/backgroundLocation.ts` registers the headless native task.
- `services/api/src/routes/pods.ts` enforces membership and derives presence.
- `services/api/src/db/schema.ts` is the domain schema; auth tables remain in
  `services/security/app/models.py`.
- `packages/shared/src/algorithms/geo.ts` owns distance and saved-place calculations.

## Product rules this codebase preserves

- Five tabs: Home (live map), Plans, World, Wallet, You.
- Decide Together: hidden want / maybe / no votes. Unanimous want becomes a plan. Majority no archives. Mixed goes to Work It Out. Harmony = `((want + maybe*0.5)/total)*100 - (no/total)*15`, +4 if the creator wanted it, −4 if Peapod suggested it.
- Trip lifecycle: `suggestion → draft → planned → booked → completed`.
- XP levels 1–6. Garden plot capacity `min(12, 2 + level*2)`. Earned seeds cannot be bought.
- Wallet UI is labelled **simulated** until a payment provider is wired.
- Pod mutations are admin-gated. Domain rows are pod-scoped. Notifications are recipient-scoped.

## Release path: Expo Go → Play Store `.aab` → TestFlight

Day-to-day development uses **Expo Go**. Pod switching, maps, chat, foreground
location, and telemetry work there. Background location runs only in EAS native
builds because Expo Go cannot execute an app-owned background task; the app
detects this and stays foreground-only without error.

Store builds use **EAS Build**. Config:

- [`apps/mobile/eas.json`](apps/mobile/eas.json) — `development`, `preview`, `production` profiles.
- [`apps/mobile/app.config.ts`](apps/mobile/app.config.ts) — bundle ids `app.peapod.mobile`, permission strings, version. iOS `buildNumber` and Android `versionCode` are **not** hardcoded; EAS `autoIncrement` owns them.

```bash
npm install -g eas-cli
eas login
cd apps/mobile
eas init          # writes the real project id into app.config.ts extra.eas.projectId
```

### EAS Local Build Prerequisites

`npm run build:apk` executes
`eas build -p android --profile preview --local`. The `--local` flag compiles
and signs the APK on your hardware instead of using Expo's cloud build
workers. The preview profile sets `android.buildType` to `apk`, so the result
can be sideloaded directly; production continues to produce a Play Store
`.aab`.

Install and configure:

1. Expo Application Services CLI:

   ```bash
   npm install -g eas-cli
   eas login
   ```

2. Android Studio and an Android SDK matching the Expo/React Native toolchain.
   Install the SDK Platform, SDK Build-Tools, Platform-Tools, and command-line
   tools through Android Studio's SDK Manager.
3. Java JDK 17. Confirm `java -version` reports 17.
4. Map the environment variables to real installations:

   ```powershell
   # Typical Windows examples; use your actual paths.
   setx JAVA_HOME "C:\Program Files\Java\jdk-17"
   setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
   ```

   Add `%JAVA_HOME%\bin`, `%ANDROID_HOME%\platform-tools`, and
   `%ANDROID_HOME%\cmdline-tools\latest\bin` to `PATH`, open a new terminal,
   then verify `java -version` and `adb version`.

EAS Local Build officially runs on Linux and macOS. On this Windows project,
run the local build inside **WSL2** and ensure JDK 17 and the Android SDK are
installed or visible inside that Linux environment. If you do not want WSL2,
use `eas build -p android --profile preview` without `--local` for an Expo cloud
build.

To build a Wi-Fi test APK:

1. Run `ipconfig` and copy the IPv4 address of the active Wi-Fi adapter.
2. Set that address in the repository-root `.env`:

   ```dotenv
   EXPO_PUBLIC_API_URL=http://192.168.1.42:8080
   ```

3. Keep PostgreSQL, Security, and the API running on the host. Compute can stay
   disabled with `COMPUTE_ENABLED=false`.
4. Ensure the phone and host are on the same non-guest Wi-Fi and TCP 8080 is
   allowed through the firewall.
5. From the repository root run:

   ```bash
   npm run build:apk
   ```

EAS prints the generated `.apk` path when the build finishes. Install that APK
on a phone connected to the same Wi-Fi. The LAN address is compiled into this
preview build; rebuild when the host IPv4 changes. For production, replace the
variable with an HTTPS API origin—no screen or hook changes are required.

### Android — Google Play (`.aab`)

```bash
cd apps/mobile
eas build --profile production --platform android
eas submit --profile production --platform android
```

`production.android.buildType` is `app-bundle`. Play has required App Bundles for new apps since 2021 and will refuse an `.apk` upload. The first upload lands on the **internal** track as a **draft** (`eas.json` `submit.production.android`) so a human presses release. Promote internal → closed → open → production in Play Console.

You need: a Play Console app, a service account JSON with Release Manager access (path in `eas.json`, file gitignored), and the Play Store data-safety / location-disclosure forms. Background location **blocks review** until the justifications in SETUP-EXTERNAL-APIS.md are written.

### iOS — TestFlight via App Store Connect

```bash
cd apps/mobile
eas build --profile production --platform ios
eas submit --profile production --platform ios
```

Fill `submit.production.ios` (`appleId`, `ascAppId`, `appleTeamId`) or, better, create an App Store Connect API key through `eas credentials` so CI is not prompted for 2FA. The build appears in TestFlight for internal testers. Then submit for Beta App Review, then App Review.

You need: Apple Developer Program ($99/year), an App Store Connect app record, and the location / tracking privacy nutrition labels. `ITSAppUsesNonExemptEncryption` is already `false` (HTTPS only).

### Versioning

| Field | Owner |
|-------|-------|
| `version` (`1.0.0`) | `app.config.ts` — user-facing marketing version |
| iOS `buildNumber` | EAS remote counter (`autoIncrement`) |
| Android `versionCode` | EAS remote counter (`autoIncrement`) |

Never hand-edit build numbers. Two builds sharing a number are rejected by both stores.

## Quality gates

```bash
npm run check          # build shared, typecheck workspaces, lint
npm test               # API parity tests (TypeScript algorithms)
cd services/compute && cargo test
cd services/security && pytest
```

## Docs

- [SETUP-EXTERNAL-APIS.md](SETUP-EXTERNAL-APIS.md) — every missing third-party capability, how to provision it, and how to swap the stub.
- [apps/mobile/README.md](apps/mobile/README.md) — Expo Go LAN notes and the cloud API origin.
- [apps/mobile/eas.json](apps/mobile/eas.json) — `development`, `preview`, and `production` build/submit profiles. Preview already points at `https://peapod-api.onrender.com`.
