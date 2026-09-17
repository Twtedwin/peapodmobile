# Peapod API — Postman notes

Copy these into Postman against the Node API origin (`EXPO_PUBLIC_API_URL`).
There is **no** `/api/v1` prefix. The mobile app never talks to the Python
security service directly: Fastify proxies `/auth/*` to it.

**Base URL (local):** `http://<lan-ip>:8080`  
**Base URL (preview):** `https://peapod-api.onrender.com`

**Collection variables**

| Variable | Example | Used as |
| --- | --- | --- |
| `baseUrl` | `https://peapod-api.onrender.com` | request URL prefix |
| `accessToken` | *(from login / verify-otp)* | `Authorization` |
| `refreshToken` | *(from login / verify-otp)* | refresh / logout body |
| `podId` | UUID | pod routes |
| `userId` | UUID | members / DMs |

Save `access_token` from a login or OTP verify into `accessToken`.

---

## Shared headers

### Anonymous (register, login, OTP, forgot/reset, refresh)

```
Content-Type: application/json
Accept: application/json
```

### Authenticated (everything under Pods, plus `/auth/me`, logout, delete)

```
Content-Type: application/json
Accept: application/json
Authorization: Bearer {{accessToken}}
```

A missing or expired access token returns **401**. The app then `POST /auth/refresh`.

---

## Auth (`/auth/*`)

All of these hit the API origin. Fastify forwards `request.url` to the
security service. Public auth routes do **not** send `X-Internal-Token`.

### `POST /auth/register`

Create a profile. Tokens are **not** issued until OTP verify.

**Headers:** anonymous JSON headers.

**Body**

```json
{
  "email": "you@example.com",
  "password": "at-least-10-characters",
  "display_name": "Alex"
}
```

**201**

```json
{
  "user_id": "uuid",
  "email_sent": true
}
```

**409** `{ "detail": "An account with this email already exists" }`  
**422** validation (password shorter than 10, bad email).

---

### `POST /auth/verify-otp`

**Headers:** anonymous JSON headers.

**Body** (`purpose` is `"register"` after signup/login-403, or the matching OTP purpose)

```json
{
  "email": "you@example.com",
  "code": "123456",
  "purpose": "register"
}
```

**200** — save these tokens

```json
{
  "access_token": "…",
  "refresh_token": "…",
  "token_type": "bearer",
  "expires_in": 900,
  "user": {
    "id": "uuid",
    "email": "you@example.com",
    "display_name": "Alex",
    "avatar_url": null,
    "permissions_granted": false,
    "role": "user",
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z",
    "created_by_id": "uuid"
  }
}
```

`expires_in` is **seconds** until the access token dies.

---

### `POST /auth/resend-otp`

**Headers:** anonymous JSON headers.

**Body**

```json
{
  "email": "you@example.com",
  "purpose": "register"
}
```

**200** always `{ "email_sent": true }` (does not reveal whether the account exists).

---

### `POST /auth/login`

**Headers:** anonymous JSON headers.

**Body**

```json
{
  "email": "alex@peapod.local",
  "password": "peapod-demo-12"
}
```

**200** same `TokenResponse` shape as verify-otp.

**403** password is correct but email is unverified (OTP is re-sent):

```json
{
  "detail": "email not verified",
  "email_sent": true
}
```

Then call `POST /auth/verify-otp` with `purpose: "register"`.

**401** wrong password / unknown email.

---

### `POST /auth/refresh`

**Headers:** anonymous JSON headers. Do not send the expired access token.

**Body**

```json
{
  "refresh_token": "{{refreshToken}}"
}
```

**200** new `TokenResponse` (same shape as login).

---

### `POST /auth/logout`

**Headers:** authenticated.

**Body**

```json
{
  "refresh_token": "{{refreshToken}}"
}
```

**204** empty.

---

### `POST /auth/forgot-password`

**Headers:** anonymous JSON headers.

**Body**

```json
{
  "email": "you@example.com"
}
```

**200** `{ "email_sent": true }` for every well-formed email (anti-enumeration).

---

### `POST /auth/reset-password`

**Headers:** anonymous JSON headers.

**Body** (`token` is the query value from the reset email / `peapod://reset-password?token=`)

```json
{
  "token": "paste-reset-token",
  "password": "new-password-10+"
}
```

**204** empty. **400/422** invalid or expired token, or password too short.

---

### `GET /auth/me`

**Headers:** `Authorization: Bearer {{accessToken}}` (no body).

**200** `UserPublic` (same `user` object as in `TokenResponse`).

---

### `PATCH /auth/me`

**Headers:** authenticated.

**Body** (all fields optional)

```json
{
  "display_name": "Alex",
  "avatar_url": null,
  "permissions_granted": true
}
```

**200** `UserPublic`.

---

### `POST /auth/delete-account`

**Headers:** authenticated.

**Body**

```json
{
  "password": "current-password"
}
```

**204** empty.

---

## Pods

Every route below requires `Authorization: Bearer {{accessToken}}`.

### `GET /pods`

List pods the caller belongs to.

**Headers:** authenticated. No body.

**200** array (may be `[]`)

```json
[
  {
    "id": "uuid",
    "name": "Weekend crew",
    "emoji": "❤️",
    "group_type": "friends",
    "my_role": "admin"
  }
]
```

---

### `POST /pods`

**Headers:** authenticated.

**Body**

```json
{
  "name": "Weekend crew",
  "emoji": "🫛",
  "group_type": "friends"
}
```

`group_type` is `"couple" | "family" | "friends"` (optional; default `"couple"`).  
`emoji` optional (default `"❤️"`).

**201** the created pod row (`id`, `name`, `emoji`, `group_type`, …). Caller is admin.

---

### `GET /pods/{{podId}}`

**Headers:** authenticated. No body.

**200** one pod. **403** not a member. **404** missing.

---

### `PATCH /pods/{{podId}}`

Admin / privileged only.

**Body** (all optional)

```json
{
  "name": "New name",
  "emoji": "🌱",
  "group_type": "family",
  "trip_history_enabled": true
}
```

**200** updated pod.

---

### `DELETE /pods/{{podId}}`

Admin / privileged. **204**.

---

### `POST /pods/{{podId}}/invites`

Admin / privileged. No body required.

**201**

```json
{
  "id": "uuid",
  "pod_id": "uuid",
  "code": "ABC123",
  "expires_at": "2026-01-01T00:10:00.000Z"
}
```

Codes are 6 alphanumeric characters, TTL **10 minutes**.

---

### `POST /pods/join`

**Headers:** authenticated.

**Body**

```json
{
  "code": "ABC123"
}
```

**200**

```json
{
  "pod": { "id": "uuid", "name": "Weekend crew" },
  "membership": { "pod_id": "uuid", "user_id": "uuid", "role": "member" }
}
```

**404** unknown code. **400** expired. **409** already a member.

---

### `GET /pods/{{podId}}/members`

**200** array of memberships joined to user profile:

```json
[
  {
    "id": "membership-uuid",
    "pod_id": "uuid",
    "user_id": "uuid",
    "role": "admin",
    "user": {
      "id": "uuid",
      "email": "alex@peapod.local",
      "display_name": "Alex",
      "avatar_url": null,
      "role": "user"
    }
  }
]
```

---

### `POST /pods/{{podId}}/members/{{userId}}/role`

Privileged.

**Body**

```json
{
  "role": "admin"
}
```

`role` is `"admin"` or `"member"`. **200** updated membership.

---

### `DELETE /pods/{{podId}}/members/{{userId}}`

Kick (privileged) or self-leave. **204**. Last admin cannot leave.

---

### `GET /pods/{{podId}}/presence`

Derived live status (not a stored table). Online if the latest ping is younger
than 10 minutes.

**200**

```json
[
  {
    "user_id": "uuid",
    "display_name": "Alex",
    "avatar_url": null,
    "role": "member",
    "online": true,
    "last_seen_at": "2026-01-01T00:00:00.000Z",
    "ping": {
      "latitude": 1.3521,
      "longitude": 103.8198,
      "speed": 0,
      "accuracy": 12,
      "heading": 0,
      "created_at": "2026-01-01T00:00:00.000Z"
    },
    "phone_status": {
      "battery_level": 84,
      "is_charging": false,
      "connection_type": "wifi"
    }
  }
]
```

`speed` is **metres per second**. The app converts to km/h for the Home cards.
Distance between peas is **not** an API field; the client computes haversine
in `@peapod/shared`.

---

### `POST /pods/{{podId}}/nudges`

**Body**

```json
{
  "recipient_id": "{{userId}}"
}
```

Creates a notification for that member.

---

## Direct messages (Home DM modal)

Same Bearer header. `pod_id` on these rows is always `null`.

### `GET /direct-messages/{{userId}}`

**200** array of messages (oldest first):

```json
[
  {
    "id": "uuid",
    "text": "Hey",
    "created_by_id": "uuid",
    "recipient_id": "uuid",
    "pod_id": null,
    "created_at": "2026-01-01T00:00:00.000Z"
  }
]
```

**400** if `userId` is yourself.

---

### `POST /direct-messages/{{userId}}`

**Body**

```json
{
  "text": "Say hi"
}
```

`text` 1–2000 characters. **201** the created message row.

---

## Postman checklist

1. `POST {{baseUrl}}/auth/register` → note `user_id`, read OTP from security logs or email.
2. `POST {{baseUrl}}/auth/verify-otp` → copy `access_token` / `refresh_token` into collection vars.
3. `GET {{baseUrl}}/auth/me` with Bearer.
4. `POST {{baseUrl}}/pods` → copy `id` into `podId`.
5. `POST {{baseUrl}}/pods/{{podId}}/invites` → copy `code`.
6. (Second user) `POST {{baseUrl}}/pods/join` with that code.
7. `GET {{baseUrl}}/pods/{{podId}}/members` and `/presence`.
8. `GET/POST {{baseUrl}}/direct-messages/{{userId}}` for the Home modal.

Demo seed (only after both API and security seeds):  
`alex@peapod.local` / `peapod-demo-12`.
