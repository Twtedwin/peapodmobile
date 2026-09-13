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
| `DATABASE_URL` | api, security | Postgres (Python wants `postgresql+asyncpg://` — rewritten automatically) |
| `SECURITY_URL` | api | Where Fastify proxies `/auth/*` and verifies tokens |
| `COMPUTE_URL` / `COMPUTE_ENABLED` | api | Rust maths; `false` always uses the TypeScript fallback |
| `INTERNAL_SERVICE_TOKEN` | api, security | Shared secret for `/internal/*` |
| `JWT_SECRET` | security | HS256 dev signing; production requires RS256 key pair |
| `EXPO_PUBLIC_API_URL` | mobile | Inlined into the app bundle. Never put a secret in `EXPO_PUBLIC_*` |
| `GOOGLE_MAPS_IOS_API_KEY` | mobile build | Google Maps SDK for iOS key |
| `GOOGLE_MAPS_ANDROID_API_KEY` | mobile build | Google Maps SDK for Android key |

### Google Maps key

Home always renders `react-native-maps` with `provider={PROVIDER_GOOGLE}` and a
dark JSON style. Native EAS builds therefore require Google Maps SDK keys.
Google requires a billing-enabled Cloud project; usage may fall within its
current no-charge allowance, but the key is not inherently a secret or an
unconditionally free service.

1. In Google Cloud, enable **Maps SDK for Android** and **Maps SDK for iOS**.
2. Create platform-restricted keys: Android package `app.peapod.mobile` plus
   signing SHA-1, and iOS bundle identifier `app.peapod.mobile`.
3. Put the keys in the root `.env` for local native builds, or set the same
   names as EAS environment secrets:

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
- [apps/mobile/README.md](apps/mobile/README.md) — Expo Go LAN notes.
- [apps/mobile/eas.json](apps/mobile/eas.json) — build/submit profiles, with a `_documentation` key explaining each flag.
