# Peapod mobile

Expo SDK 57 / React Native 0.86 app. Scan the QR code with **Expo Go** for
foreground development. Background location is enabled in EAS native builds
and intentionally falls back to foreground-only in Expo Go.

## Run

From the repository root:

```bash
npm install
npm run dev:mobile
```

Or from this directory:

```bash
npx expo start
```

Then open Expo Go on your phone and scan the QR code.

## Point the app at your laptop

`EXPO_PUBLIC_API_URL` is required; there is no hardcoded network fallback.
`http://10.0.2.2:8080` is the Android emulator's alias for the host machine,
but it will **not** reach a server from a physical phone or iOS simulator.

Set the value in the repository-root `.env` before `expo start`
(`app.config.ts` loads that file for both root and workspace commands):

| Device | `EXPO_PUBLIC_API_URL` |
| --- | --- |
| Android emulator | `http://10.0.2.2:8080` |
| iOS simulator | `http://localhost:8080` |
| Physical phone (Expo Go) | `http://<your-lan-ip>:8080` |

Find your LAN IP:

- Windows: `ipconfig` → IPv4 Address on the active adapter
- macOS/Linux: `ipconfig getifaddr en0` or `hostname -I`

The phone and the laptop must be on the same Wi-Fi. HTTP (not HTTPS) is
fine on a LAN; Expo Go will warn about cleartext and that is expected.

The app sends every request, including `/auth/*`, to the API. Fastify
proxies authentication to the security service; never configure a
direct mobile-to-security URL. Realtime uses `EXPO_PUBLIC_WEBSOCKET_URL`
when set, otherwise it derives `ws://` or `wss://` from the API origin.

## Cloud API

Preview EAS builds (`apps/mobile/eas.json` `build.preview.env`) talk to
the hosted Node API:

| | |
| --- | --- |
| HTTP | `https://peapod-api.onrender.com` |
| WebSocket | `wss://peapod-api.onrender.com` |

`.env` is not uploaded to EAS (`.easignore`). Changing the cloud origin
requires editing `eas.json` (or EAS secrets) and rebuilding. Local Expo
Go still uses the LAN `EXPO_PUBLIC_API_URL` in the repository-root `.env`.

The production EAS profile compiles `https://api.peapod.app`. That custom
domain is not the current Render hostname.

## First login

Either:

1. Register a new account in the app, verify the emailed OTP (in
   development the security service logs the code; in production look
   for `email provider status=` in the security Render logs), then
   create or join a pod, or
2. Use a demo profile the API + security seeds created, e.g.
   `alex@peapod.local` / `peapod-demo-12` — only after both seed scripts
   have run so the profile row and credential row exist. Demo users are
   not on the hosted Render database unless you seeded it there.

Unverified login returns HTTP 403 and re-sends the OTP. The login screen
then asks for that 6-digit code. Forgot-password shows a network/5xx error
if the API is down; a 2xx still always looks successful so emails cannot
be mined. Whether Resend accepted the mail is only in the security logs.

The login screen helper text is: **Create an account, then create or join a pod.**

## Home map

The map fills the Home tab. A floating pod pill (top left) opens a dropdown
of memberships; **Create new pod** and **Join with a code** are center
modals, not a bottom sheet. Notification and profile are separate circular
buttons at the top right.

On load (and when the set of located members changes) the camera fits every
pea in the pod, including you, with padding so pins are not under the chrome
or the member sheet. Distances on cards are haversine metres from
`@peapod/shared`, formatted as m/km (`Together` under 100 m). There is no
geolib dependency.

The current-user pill floats on the left just above **Your peas**, separate
from the top chrome. Drag that sheet up for locate/nudge actions or down for
more map. Cards are sized so two full cards and half of a third are visible,
with Battery / Net / Apart / Speed in one horizontal row. Tap another pea’s
card to open a centered Direct Message modal. Full usage and native
background-location build instructions are in the repository `README.md`.
Postman copies for auth and pods: repository `API_DOCS.md`.

## Quality

```bash
npm run typecheck
npm run lint
```
