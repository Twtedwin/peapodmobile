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

Tap the pod name to switch, create, or join a six-character invite. Drag
**Your peas** up for detailed live cards and down for more map. Crosshairs
center on this device, one member, or the full group. Full usage and native
background-location build instructions are in the repository `README.md`.

## Quality

```bash
npm run typecheck
npm run lint
```
