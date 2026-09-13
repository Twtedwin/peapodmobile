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

The app sends every request, including `/auth/*`, to the API on port 8080.
Fastify proxies authentication to the security service on port 8081; never
configure a direct mobile-to-security URL. Realtime derives `ws://` or
`wss://` from the same API origin automatically.

## First login

Either:

1. Register a new account in the app, verify the emailed OTP (in
   development the security service logs the code), then create or join
   a pod, or
2. Use a demo profile the API + security seeds created, e.g.
   `alex@peapod.local` / `peapod-demo-12` — only after both seed scripts
   have run so the profile row and credential row exist.

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
