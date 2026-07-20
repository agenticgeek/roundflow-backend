# RoundFlow — Auth: Complete Frontend Handoff

> **Purpose of this document:** everything needed to build the 5 auth screens
> and wire up Supabase Auth end-to-end — screens, flows, exact Supabase JS
> calls, signup metadata, session handling, and gotchas — in one place.

**Backend base URL (dev):** `http://localhost:3000`
**Supabase project URL:** `https://cixtfdnuwbmxvilkvihv.supabase.co`
**Supabase anon key:** injected as `VITE_SUPABASE_ANON_KEY` (env). **Public/safe to ship in frontend code.**
**Auth SDK:** `@supabase/supabase-js` — create one client (`createClient(SUPABASE_URL, SUPABASE_ANON_KEY)`) and reuse it.

---

## 1. Overview — the auth architecture

- **Supabase Auth owns all credential management.** There are no login / signup
  / reset endpoints for credentials on the RoundFlow backend — the frontend
  talks to Supabase directly via the JS client.
- **The backend verifies** Supabase-issued **JWTs** (ES256, via JWKS) on each
  API request. It issues no tokens. Missing/invalid → `401`.
- **After Supabase confirms a new session, the frontend must call
  `POST /auth/signup`** to provision the Tenant and Profile. This replaced the
  old `handle_new_user` Postgres trigger, which cannot create per-tenant
  Postgres schemas. See §5.
- **`GET /auth/me`** returns `404` when no Profile exists yet — the frontend
  uses this to detect new users who need provisioning.

---

## 2. Auth flows — canonical

### Flow A — Email/password signup

1. User fills **Full name**, **Company name**, **email**, **password**.
2. Frontend calls:
   ```js
   supabase.auth.signUp({
     email,
     password,
     options: { data: { full_name, company_name } },
   })
   ```
3. Supabase sends a confirmation email (magic link).
4. Frontend shows **"Check your email for a confirmation link"** — do not
   navigate into the app yet.
5. User clicks the link → Supabase establishes the session (`SIGNED_IN` event).
6. Frontend calls `GET /auth/me`:
   - `404` → new user, call `POST /auth/signup` (§5) → navigate to `/setup`.
   - `200` → returning user (e.g. re-confirmed), navigate to `/setup` or
     `/dashboard` based on `setupCompleted` (§6).

### Flow B — Email/password login

1. User fills **email** + **password**.
2. Frontend calls `supabase.auth.signInWithPassword({ email, password })`.
3. On success → call `GET /auth/me` → navigate per §6.
4. On error → inline error ("Invalid login credentials", "Email not confirmed").

### Flow C — Google OAuth

1. User clicks **"Continue with Google"**.
2. Frontend calls:
   ```js
   supabase.auth.signInWithOAuth({
     provider: 'google',
     options: { redirectTo: window.location.origin + '/auth/callback' },
   })
   ```
3. User completes Google login → redirected to `/auth/callback`.
4. The `/auth/callback` route calls `supabase.auth.exchangeCodeForSession()`.
5. On success → call `GET /auth/me`:
   - `404` → new Google user, call `POST /auth/signup` with `name` only
     (no `companyName` — not collected via OAuth; Setup Wizard step 1 collects
     it). Navigate to `/setup`.
   - `200` → returning user, navigate per §6.

> Google OAuth passes `full_name` automatically from the Google profile
> (available via `supabase.auth.getUser()` after the session is established).

### Flow D — Forgot password

1. User enters **email**.
2. Frontend calls:
   ```js
   supabase.auth.resetPasswordForEmail(email, {
     redirectTo: window.location.origin + '/reset-password',
   })
   ```
3. Frontend shows **"Check your email"** confirmation.
4. User clicks the link → redirected to `/reset-password` with a recovery session.
5. User enters new password → frontend calls `supabase.auth.updateUser({ password: newPassword })`.
6. On success → navigate to `/login`.

### Flow E — OTP Verification (DEFERRED)

The OTP screen (Screen 4) is **not part of any Phase 1 flow** — magic links are
used for both signup confirmation and password reset. Do **not** call
`supabase.auth.verifyOtp()` anywhere in Phase 1.

---

## 3. Screen-by-screen reference

Node IDs from Figma `RoundFlow-Admin`, section `Login/signup` `936:61787`.
All five screens share the split layout: dark left brand panel + white right
form panel. Show Supabase errors **inline** — never `alert()`.

### Login — `936:61788` (Flow B)
- **Fields:** Work email · Password · Remember me (checkbox)
- **Buttons:** Sign in → `signInWithPassword` · Forgot password? · Continue with Google · Sign up tab
- **Errors (inline):** "Invalid login credentials" · "Email not confirmed"

### Sign Up — `936:61853` (Flow A)
- **Fields:** Full name (`full_name`) · Work email · Company name (`company_name`) · Password · Confirm Password
- **Buttons:** Create account → `signUp` with metadata · Continue with Google · Log in tab
- **Errors (inline):** "User already registered" · password mismatch (client-side) · weak password
- **On success:** show "Check your email for a confirmation link" — do not navigate.

### Forgot Password — `936:61929` (Flow D)
- **Fields:** Work email
- **Buttons:** Send reset link · ← Back to log in · resend
- **Errors:** Show generic success even if email not found (avoid enumeration).

### OTP Verification — `936:61974` — **DEFERRED** (see Flow E)

### Reset Password — `936:62030` (Flow D)
- **Fields:** New password (eye toggle + strength indicator) · Confirm password (eye toggle)
- **Rule:** at least 8 characters including a number
- **Buttons:** Reset password → `supabase.auth.updateUser({ password })` · ← Back
- **On success:** "You'll be redirected to log in after reset" → navigate to `/login`.

---

## 4. Metadata fields — what to pass on signup

```js
supabase.auth.signUp({
  email,
  password,
  options: { data: { full_name: fullName, company_name: companyName } },
})
```

- **`full_name`** → passed to `POST /auth/signup` as `name`.
- **`company_name`** → passed to `POST /auth/signup` as `companyName`. Currently
  accepted but not yet persisted by the backend (tenant schema provisioning is
  pending). Setup Wizard step 1 collects the business name directly until then.
- **If `full_name` is missing** (Google OAuth), read it from
  `(await supabase.auth.getUser()).data.user.user_metadata.full_name` before
  calling `POST /auth/signup`.

---

## 5. POST /auth/signup — tenant and profile provisioning

This endpoint replaces the old `handle_new_user` Postgres trigger. It must be
called by the frontend after Supabase confirms a new session and `GET /auth/me`
returns `404`.

```
URL:     POST /auth/signup
Auth:    Bearer <supabase_access_token>
Content-Type: application/json

Body:
{
  "name": "John Smith",          // required — from Full name field or Google profile
  "companyName": "ABC Cleaning"  // optional — omit for Google OAuth signups
}

201 Created — new tenant + profile provisioned:
{
  "profile": {
    "id": "...",
    "supabaseUserId": "...",
    "tenantId": "...",
    "role": "ADMIN",
    "name": "John Smith",
    "createdAt": "..."
  },
  "tenantId": "..."
}

200 OK — already provisioned (idempotent, safe to call twice):
  same shape as 201

401 — missing or invalid Bearer token
400 — name missing or blank
```

**Idempotent:** if `POST /auth/signup` is called a second time for the same
user (e.g. page refresh mid-flow), it returns the existing profile without
creating a duplicate tenant.

### When to call it

```
On SIGNED_IN (from onAuthStateChange or after exchangeCodeForSession):
  GET /auth/me
    → 200: skip, navigate normally
    → 404: POST /auth/signup → then navigate to /setup
```

---

## 6. GET /auth/me

Returns the Profile for the authenticated user. Used on every app load to
check whether the user is provisioned and where to route them.

```
GET /auth/me
Auth: Bearer <supabase_access_token>

200 OK:
{
  "id": "...",
  "supabaseUserId": "...",
  "tenantId": "...",
  "role": "ADMIN" | "MANAGER" | "TECHNICIAN",
  "name": "...",
  "createdAt": "...",
  "updatedAt": "..."
}

404 → no Profile yet → call POST /auth/signup
401 → invalid/missing token
```

**Routing on 200:**
- Check `setupCompleted` via `GET /setup/status` — if `false`, route to `/setup`; if `true`, route to `/dashboard`.

---

## 7. Session handling and route guards

- **Get current session:** `const { data: { session } } = await supabase.auth.getSession()`
- **Listen for changes:** `supabase.auth.onAuthStateChange((event, session) => { … })`
  — fires on `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED`, `PASSWORD_RECOVERY`.
- **Protected-route guard:** if no session → redirect to `/login`.
- **Auth-screen guard:** if session exists → redirect away from `/login`, `/signup`, etc.
- **Token refresh:** the Supabase JS client refreshes automatically — do not implement manual refresh.
- **API calls:** attach token as `Authorization: Bearer <access_token>` on every backend request.

---

## 8. ⚠️ Critical rules
>
> - **Always call `GET /auth/me` after `SIGNED_IN`** — do not assume the user
>   is provisioned. The 404 response is the signal to call `POST /auth/signup`.
>
> - **`POST /auth/signup` is idempotent** — safe to call on every new session
>   if you don't want to track the provisioning state separately.
>
> - **The OTP screen is NOT built in Phase 1** — magic link handles both signup
>   confirmation and password reset.
>
> - **Never store the Supabase access token manually.** Retrieve on demand via
>   `supabase.auth.getSession()`.
>
> - **The anon key is public/safe** to expose in frontend code. The service-role
>   key is the secret — never ship it.
>
> - **The `/auth/callback` route must exist** in the React router for Google
>   OAuth to complete.
>
> - **Show Supabase errors inline, not as `alert()` popups.**

---

## 9. Supabase project config checklist

- [ ] **`drop_handle_new_user.sql` executed** — run in Supabase SQL Editor
      (`docs/sql/drop_handle_new_user.sql`). **Required before first signup.**
- [ ] **Email provider enabled** — Authentication → Providers → Email.
- [ ] **Google OAuth configured** — Authentication → Providers → Google (Client ID + Secret).
- [ ] **Redirect URLs allowlisted** — Authentication → URL Configuration:
      `http://localhost:5173/auth/callback` (dev) + production URL + `/reset-password`.
- [ ] **Site URL set** — Authentication → URL Configuration → Site URL.

---

## 10. Quick-reference table

| Screen | Node ID | Flow | Key Supabase call | Deferred? |
|--------|---------|------|-------------------|-----------|
| Login | `936:61788` | B | `signInWithPassword` | No |
| Sign Up | `936:61853` | A | `signUp` + `POST /auth/signup` | No |
| Forgot Password | `936:61929` | D | `resetPasswordForEmail` | No |
| OTP Verification | `936:61974` | — | — | **Yes** |
| Reset Password | `936:62030` | D | `updateUser` | No |

---

*Cross-reference: `docs/designFindings.md` Screens 1–5 (visual/field detail),
`docs/sql/drop_handle_new_user.sql` (trigger removal), Setup Wizard handoff
(`docs/SETUP_WIZARD_HANDOFF_v2.md`) for what happens after provisioning.*
