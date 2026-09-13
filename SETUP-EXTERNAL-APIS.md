# Setup: external APIs

Peapod runs locally with **zero** third-party keys. Every item below is a stub, a public demo server, or a development fallback. This file is the map from that fallback to a real provider: what it is, why you need it, which files consume it, how to provision it, the env vars, the code change that flips the stub, cost notes, and how to verify.

Priority:

- **Required for launch** — the stores or a real user cannot complete a core flow without it.
- **Required for a feature** — that feature is dead or labelled simulated until wired.
- **Optional** — nice to have; the app is honest without it.

Items that **block store review** are marked.

---

## 1. Google Maps Platform — REQUIRED FOR LAUNCH (review-sensitive)

**What.** Maps SDK for Android, Maps SDK for iOS, Places Autocomplete, Geocoding, Directions. Replaces the old web app's CARTO raster tiles and OSM Nominatim reverse geocoding. Forward geocoding (the address search UI) never shipped; Places Autocomplete is how it should.

**Why.** Home is a live map of the pod. Without a key, iOS uses Apple Maps (fine) and Android uses a watermarked or empty Google surface inside Expo Go. Address search stays disabled. Production Android Play builds with `react-native-maps` typically need a Maps SDK key or the map is a blank grid.

**Files.**

- `apps/mobile/app.config.ts` — `GOOGLE_MAPS_IOS_API_KEY` / `GOOGLE_MAPS_ANDROID_API_KEY`
- `apps/mobile/src/components/home/PodMap.tsx` — `MapView`, dark style, markers, camera controls
- `services/api` — server geocoding would use `GOOGLE_MAPS_SERVER_API_KEY` (currently unused; reverse geocoding is client-side)

**Provision.**

1. Google Cloud Console → new project → billing enabled (Maps is not free-tier forever).
2. Enable: Maps SDK for Android, Maps SDK for iOS, Places API (New or legacy), Geocoding API, Directions API.
3. Credentials → API key. Create **three** keys:
   - Android: restrict by package `app.peapod.mobile` + SHA-1 of the Play/upload keystore.
   - iOS: restrict by bundle id `app.peapod.mobile`.
   - Server: restrict by IP of the API host. Never ship this one in the app.
4. Those restrictions **are** the security boundary. Native Maps keys are in the binary even though they do not use the `EXPO_PUBLIC_*` prefix.

**Env.**

```
GOOGLE_MAPS_IOS_API_KEY=
GOOGLE_MAPS_ANDROID_API_KEY=
GOOGLE_MAPS_SERVER_API_KEY=
```

**Code change.** None if the env vars are set: `app.config.ts` already omits the `config.googleMaps` block when a key is absent, and includes it when present. To add Places Autocomplete, introduce a search field on the place sheet that calls Places and writes `latitude`/`longitude` — there is no client for it yet.

**Cost.** Maps SDK hits are billed per load; Places Autocomplete per session. Set a budget alarm.

**Verify.** Production build on a device: map tiles render, no "For development purposes only" watermark, long-press still drops a pin.

**Store review.** A map that tracks users needs a prominent in-app disclosure and a Play Data safety "Location" declaration.

---

## 2. Background location — REQUIRED FOR A FEATURE (blocks store review)

**What.** `expo-location` background task, Android foreground service, iOS `UIBackgroundModes: location`.

**Why.** Expo Go can only run Peapod's foreground watcher. Native EAS builds use the registered background task so a pea whose phone is in a pocket does not go stale.

**Files.**

- `apps/mobile/src/hooks/useLocationPings.ts`
- `apps/mobile/src/location/backgroundLocation.ts`
- `apps/mobile/app.config.ts`
- `apps/mobile/eas.json` — a background location task needs a **custom dev client**; it will **not** run in Expo Go.

**Provision.**

1. Build with `eas build --profile development`; the `expo-location` config plugin emits iOS background mode and Android service permissions.
2. Install the resulting development build, sign in, and grant foreground then background location.
3. Keep Expo Go for foreground UI testing; it is detected and never attempts to register the native task.

**Store justifications (write these before submitting).**

- Play: prominent disclosure, "Location — Background", video of the disclosure screen. Use: "Share live location with a closed group the user joined, and notify them when a member arrives at a saved place."
- App Store: purpose string already in `NSLocationAlwaysAndWhenInUseUsageDescription`. Explain in review notes that tracking is opt-in, pod-scoped, and not used for advertising.

**Env.** None.

**Code.** Implemented. Foreground and background updates share POST `/location/pings`; the headless task hydrates its encrypted token and active pod before uploading.

**Verify.** Lock the phone, walk 200 m, another device in the pod sees the marker move.

**Expo Go note.** Foreground tracking works in Expo Go. Background does not. That is why this is a feature flag, not a launch blocker for internal testers on Expo Go.

---

## 3. Push notifications (Expo Push, FCM, APNs) — REQUIRED FOR LAUNCH

**What.** Device push so a message, nudge, or place alert arrives when the app is closed. Today: in-app `notifications` rows + a permission prompt. No delivery pipeline.

**Why.** Chat and "Sarah arrived at Home" are useless if they only appear while the app is open.

**Files.**

- `apps/mobile/app/permissions.tsx` — `Notifications.requestPermissionsAsync`
- `services/api/src/jobs/index.ts` — creates in-app rows, does not push
- `services/api/src/routes/domain.ts` — notification CRUD

**Provision.**

1. `eas init` so `extra.eas.projectId` is real.
2. Expo dashboard → Push Notifications.
3. Android: Firebase project, download `google-services.json` (gitignored), FCM.
4. iOS: Apple Developer → Keys → APNs `.p8`. Put `APNS_KEY_ID`, `APNS_TEAM_ID`, key file in EAS secrets.
5. On login, call `Notifications.getExpoPushTokenAsync({ projectId })` and POST the token to a new `push_tokens` table (not created yet).
6. When the API inserts a `notifications` row, also `POST https://exp.host/--/api/v2/push/send`.

**Env.**

```
EXPO_PUBLIC_EXPO_PROJECT_ID=
EXPO_ACCESS_TOKEN=
FCM_SERVICE_ACCOUNT_JSON=
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_PRIVATE_KEY=
```

**Code change.** Add `push_tokens (user_id, token, platform)` to `services/api/src/db/schema.ts`. After insert on `notifications`, fan-out. Client: register the token in `_layout.tsx` after login.

**Cost.** Expo's push service is free at this scale; FCM/APNs are free.

**Verify.** Kill the app, send a pod message from a second device, the banner appears.

**Store review.** Android 13+ `POST_NOTIFICATIONS` is already listed. Do not require push to complete signup.

---

## 4. Transactional email — REQUIRED FOR LAUNCH (blocks registration in production)

**What.** OTP for signup, password-reset links. The security service currently prints codes to stdout (`DEV EMAIL FALLBACK`) when `EMAIL_PROVIDER_API_KEY` is unset.

**Why.** A production security service **refuses to boot** without a provider (`app/config.py`). Locally the console fallback is correct; in production it would leak codes into logs.

**Files.**

- `services/security/app/email.py`
- `services/security/app/config.py`
- `services/security/app/routes/auth.py`

**Provision (Resend, example).**

1. resend.com → API key.
2. Verify `peapod.app` (or your domain) as a sender.
3. Set:

```
EMAIL_PROVIDER_API_KEY=re_...
EMAIL_PROVIDER_API_URL=https://api.resend.com/emails
EMAIL_FROM=Peapod <no-reply@peapod.app>
PASSWORD_RESET_URL=https://app.peapod.app/reset-password
```

Any provider whose send endpoint accepts JSON + `Authorization: Bearer` works without a code change (`EMAIL_PROVIDER_API_URL`).

**Code change.** None if the env is set. `app/email.py` already POSTs to the configured URL.

**Cost.** Resend's free tier is enough for OTP volume. Do not use a personal Gmail SMTP — deliverability and TOS.

**Verify.** Register a real inbox, receive a 6-digit code, no `DEV EMAIL FALLBACK` in logs.

---

## 5. Google OAuth — REQUIRED FOR THE "SIGN IN WITH GOOGLE" BUTTON

**What.** Authorization-code flow with PKCE. Email/password works without this; the Google button returns 503 when unset.

**Files.**

- `services/security/app/security/oauth_google.py`
- `services/security/app/routes/oauth.py`
- `apps/mobile/app/login.tsx` / `register.tsx` (hide the button when start returns 503)

**Provision.**

1. Google Cloud → APIs & Services → OAuth consent screen (External, testing).
2. Credentials → OAuth client ID, type **Web application**.
3. Authorized redirect URI must match **byte for byte**:
   `https://<api-host>/auth/oauth/google/callback`
   (the API proxies `/auth/*`, so the host is the API, not `:8081`).
4. For Expo Go, also add the Expo auth redirect if you switch to `expo-auth-session` later.

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8080/auth/oauth/google/callback
OAUTH_SUCCESS_REDIRECT_URL=peapod://auth/callback
```

**Code change.** None for the server. Mobile should `WebBrowser.openAuthSessionAsync(`${apiUrl}/auth/oauth/google/start`)` and read tokens from the redirect.

**Cost.** Free.

**Verify.** Tap Continue with Google, land back in the app signed in, a row in `oauth_identities`.

---

## 6. S3-compatible object storage — REQUIRED FOR AVATARS AND MEMORY PHOTOS

**What.** Presigned PUT URLs for avatars and memory check-in photos. Replaces hardcoded Unsplash placeholders. `POST /uploads/presign` returns 503 when unset.

**Files.**

- `services/api/src/services/storage.ts`
- `services/api/src/routes/uploads.ts`
- `apps/mobile` profile / memory screens (`expo-image-picker` already requested)

**Provision (Cloudflare R2 recommended — no egress fee).**

1. R2 → bucket `peapod-media`.
2. API token with Object Read & Write.
3. Public development URL or a custom domain.

```
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=peapod-media
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PUBLIC_BASE_URL=https://media.peapod.app
```

**Code change.** None if env is set. Client: pick image → `POST /uploads/presign` → HTTP PUT to the returned URL → `PATCH /auth/me { avatar_url }` or attach `photo_urls` on a memory.

**Cost.** R2: cheap storage, zero egress. AWS S3: watch GET egress when the gallery is popular.

**Verify.** Upload an avatar, reload Profile, the image loads from `S3_PUBLIC_BASE_URL`.

---

## 7. LLM provider — REQUIRED FOR AI FEATURES

**What.** Work It Out compromise chat, and upgrading the rule-based trip planner to genuine AI. Without a key, `POST /ai/compromise` uses `compromiseSuggestions()` from `@peapod/shared` and says so. Trip generation always has a deterministic engine in Rust/TypeScript.

**Files.**

- `services/api/src/routes/ai.ts`
- `packages/shared/src/algorithms/decisions.ts` (`compromiseSuggestions`)
- `services/compute/src/itinerary.rs` (rule-based; keep it as the fallback)

**Provision.**

```
LLM_PROVIDER=openai          # or anthropic
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4.1-mini
```

**Code change.** `routes/ai.ts` should already branch on `LLM_API_KEY`. Point the trip wizard at `/ai/itinerary` only when you want prose-level planning; keep `/compute/itinerary` as the default so a provider outage still produces a trip.

**Cost.** A compromise call is a few hundred tokens. Budget per pod per day to stop a runaway loop.

**Verify.** Open a divided idea, tap Work it out: the suggestions mention the actual destination, and the response includes `source: "llm"` vs `source: "fallback"`.

---

## 8. Stripe / shared wallet — OPTIONAL (regulated)

**What.** Real money for the shared wallet, bills, travel funds, trip booking, reward store. Every wallet screen is labelled **Simulated money**. Stripe packages are not even in the mobile app.

**Why optional.** Collecting money is a payments product: KYC, ledger, disputes, tax. Do not treat this as a config change.

**Files.**

- `apps/mobile/app/(tabs)/wallet.tsx`
- `apps/mobile/src/components/SimulatedBanner.tsx`
- `services/api` wallet routes (`simulated: true` on every payload)
- `packages/shared/src/algorithms/wallet.ts` — integer minor-unit splits, already correct

**Provision (when you actually mean it).**

1. Stripe account, Connect if members have their own balances.
2. `STRIPE_SECRET_KEY` on the API, `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` on the app.
3. Keep amounts in integer minor units. Never floats.

**Code change.** Replace the simulated `POST /wallet/deposit` with a PaymentIntent; do not remove the banner until a charge succeeds in production. Reward store vouchers need a real merchant relationship.

**Cost / legal.** Stripe fees + whatever your jurisdiction requires for stored value. Some regions treat a shared balance as e-money.

**Verify.** A test-mode card deposit increases `wallets.balance_minor` by the same integer cents Stripe captured.

**Store review.** In-app purchases for digital goods must use Play Billing / StoreKit; real-world split bills generally do not. Read both stores' payment policies before shipping a pay button.

---

## 9. Camera and photo library — REQUIRED FOR A FEATURE

**What.** Profile pictures and memory check-ins. `expo-image-picker` is already a dependency and permission strings are in `app.config.ts`. The UI still needs to call it and upload (see §6).

**Files.** `apps/mobile/app.config.ts`, Profile / World memory sheets.

**Env.** None.

**Code change.** `ImagePicker.launchImageLibraryAsync` / `launchCameraAsync` → presign → PUT.

**Store review.** Permission strings must stay specific. They already are.

**Verify.** Take a photo in-app, it appears on the memory.

---

## 10. Calendar sync — OPTIONAL

**What.** Write booked trips and plans to the device calendar. Local date pickers already work.

**Files.** None yet. Would be `expo-calendar` (ships in Expo Go).

**Provision.** Add the plugin and iOS `NSCalendarsUsageDescription`. Android `READ_CALENDAR` / `WRITE_CALENDAR`.

**Code change.** After a trip becomes `booked`, create an event. Never sync in the other direction without a conflict UI.

**Store review.** Calendar access is a permission people decline; make it optional.

---

## 11. Routing (OSRM or Directions API) — OPTIONAL

**What.** Snap a driving trip polyline to roads. Today the line is the smoothed GPS trace, which is honest.

**Files.** Compute/API have no OSRM call yet. `OSRM_URL` is reserved in `.env.example`.

**Provision.** Self-host OSRM, or use Google Directions with the server Maps key.

```
OSRM_URL=https://router.project-osrm.org
```

The public OSRM demo is **not** for production (rate limits, no SLA).

**Code change.** After `reconstruct_last_trip`, if `is_driving` and `OSRM_URL` is set, replace `points` with the routed geometry. Keep the raw trace as a fallback.

**Verify.** A car trip follows streets, not the hypotenuse across a block.

---

## 12. Future: on-device Rust (custom dev client) — OPTIONAL

Rust maths currently live in `services/compute` because **Expo Go cannot load custom native modules**. If you later want trip reconstruction on-device (offline, no server hop):

1. Drop Expo Go for daily work.
2. `npx expo prebuild` and a development build (`eas.json` `development` profile already sets `developmentClient: true`).
3. Wrap `services/compute` as a UniFFI / `uniffi-bindgen-react-native` module, or compile to WASM and run in a JS runtime (slower on RN).
4. Keep the TypeScript fallback and the server for anything the phone should not do (itinerary generation over the full catalog).

Until then: `docker compose up compute` or `COMPUTE_ENABLED=false`.

---

## Launch checklist vs store blockers

| Item | Local | Launch | Blocks review |
|------|-------|--------|---------------|
| Email OTP | Console fallback | Required | Indirect (users cannot register) |
| Maps keys | Platform default | Required on Android prod | Data-safety location |
| Push | In-app only | Required | No, but the feature is missing |
| OAuth Google | Hidden | Feature | No |
| S3 uploads | 503 + placeholders | Feature | No |
| LLM | Local suggestions | Feature | No |
| Background location | Foreground in Expo Go; background in EAS builds | Feature | **Yes**, without disclosure |
| Stripe | Simulated banner | Optional | Payments policy if you enable it |
| Calendar | Off | Optional | If you add the permission |
| OSRM | Raw GPS | Optional | No |

---

## How to confirm the stubs are still stubs

Search the repo for `simulated`, `DEV EMAIL FALLBACK`, `COMPUTE_ENABLED`, and `503`. Those strings should remain until the matching section above is completed. Do not delete the simulated-money banner as a "cleanup".
