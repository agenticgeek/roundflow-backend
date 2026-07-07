# RoundFlow — Auth: Complete Frontend Handoff

> **Purpose of this document:** everything needed to build the 5 auth screens
> and wire up Supabase Auth end-to-end — screens, flows, exact Supabase JS
> calls, signup metadata, the `handle_new_user` trigger behaviour, session
> handling, and gotchas — in one place. No other doc should be needed.

**Backend base URL (dev):** `http://localhost:3000` (only for `GET /auth/me` and `/setup/*` — the backend has **no** login/signup endpoints).
**Supabase project URL:** `https://cixtfdnuwbmxvilkvihv.supabase.co`
**Supabase anon key:** injected as `VITE_SUPABASE_ANON_KEY` (env). **Public/safe to ship in frontend code** — it is not a secret.
**Auth SDK:** `@supabase/supabase-js` — create one client (`createClient(SUPABASE_URL, SUPABASE_ANON_KEY)`) and reuse it.

---

## 1. Overview — the auth architecture

- **Supabase Auth owns all credential management.** There are **no** login /
  signup / reset endpoints on the RoundFlow backend — the frontend talks to
  Supabase directly via the JS client.
- **The backend only verifies** Supabase-issued **JWTs** (ES256, via JWKS) on
  each API request. It issues no tokens. Missing/invalid → `401`.
- **The `Profile` row is auto-created by a Postgres trigger** (`handle_new_user`)
  when a new user is inserted into `auth.users` — **no backend endpoint needed**.
- **`Full name` and `Company name` are passed as Supabase user metadata** on
  signup and picked up by the trigger (see §4, §5).

---

## 2. Auth flows — canonical (Phase 1)

Each flow below lists the exact Supabase JS call at each step.

**Flow A — Email/password signup**
1. User fills **Full name**, **Company name**, **email**, **password** on the Sign Up screen.
2. Frontend calls
   `supabase.auth.signUp({ email, password, options: { data: { full_name, company_name } } })`.
3. Supabase sends a **magic link** to the email.
4. Frontend shows **"Check your email for a confirmation link"**.
5. User clicks the magic link → redirected to the app (Supabase establishes the session automatically).
6. `handle_new_user` trigger fires → creates `Profile` (role `ADMIN`, `name` from `full_name` or email prefix) + seeds `BusinessSettings.businessName` from `company_name` **only if not already set**.

**Flow B — Email/password login**
1. User fills **email** + **password** on the Login screen.
2. Frontend calls `supabase.auth.signInWithPassword({ email, password })`.
3. On success → navigate to `/dashboard` (or `/setup` if `setupCompleted = false` — see §6).
4. On error → show an **inline** error message (e.g. "Invalid login credentials").

**Flow C — Google OAuth**
1. User clicks **"Continue with Google"** on the Login or Sign Up screen.
2. Frontend calls
   `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + '/auth/callback' } })`.
3. User completes Google login → redirected to `/auth/callback`.
4. The `/auth/callback` route calls `supabase.auth.exchangeCodeForSession()`.
5. On success → navigate to `/dashboard` (or `/setup`).
6. `handle_new_user` fires for **new** Google users; existing users are skipped by the trigger's `on conflict do nothing` on `Profile`.

> Google OAuth signups pass `full_name` automatically from the Google profile.
> **Company name is not collected** via OAuth — `BusinessSettings.businessName`
> stays `null` until Setup Wizard step 1.

**Flow D — Forgot password**
1. User enters **email** on the Forgot Password screen.
2. Frontend calls
   `supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/reset-password' })`.
3. Frontend shows a **"Check your email"** confirmation.
4. User clicks the magic link in the email → redirected to `/reset-password`.
5. Frontend detects the **recovery session** (Supabase sets it automatically from the link).
6. User enters a new password → frontend calls `supabase.auth.updateUser({ password: newPassword })`.
7. On success → navigate to `/login`.

**Flow E — OTP Verification screen (DEFERRED)**
The OTP screen (Screen 4) is **not part of any Phase 1 flow** — a **magic link**
is used for both signup confirmation (Flow A) and password reset (Flow D). The
screen is kept in the design for a potential future OTP flow. **Do not build it
in Phase 1**, and do **not** call `supabase.auth.verifyOtp()` anywhere.

---

## 3. Screen-by-screen reference

Node IDs are from the current **Page 1** Figma file (`RoundFlow-Admin`, section
`Login/signup` `936:61787`). All five share the split layout: dark left brand
panel + white right form panel. Show Supabase errors **inline** (under the field
or below the submit button) — **never `alert()`**.

### Login — `936:61788` (Flow B)
- **Purpose:** authentication entry point for returning users.
- **Fields:** **Work email** (required, email) · **Password** (required, password) · **Remember me** (checkbox, optional).
- **Buttons/links:**
  - **Sign in** → `supabase.auth.signInWithPassword({ email, password })` → on success navigate (§6).
  - **Forgot password?** → navigate to Forgot Password screen.
  - **Continue with Google** → Flow C.
  - Tab toggle **Sign up** / "Don't have an account? **Sign up**" → navigate to Sign Up.
- **Errors (inline, below submit):** "Invalid login credentials"; "Email not confirmed" (user hasn't clicked the magic link yet).
- **Success:** session set → navigate to `/dashboard` or `/setup`.

### Sign Up — `936:61853` (Flow A)
- **Purpose:** new account registration.
- **Fields:** **Full name** (→ `full_name` metadata) · **Work email** (required) · **Company name** (→ `company_name` metadata) · **Password** (required) · **Confirm Password** (required — validate match client-side).
- **Buttons/links:**
  - **Create account** → `supabase.auth.signUp({ email, password, options: { data: { full_name, company_name } } })`.
  - **Terms** & **Privacy Policy** → external links.
  - **Continue with Google** → Flow C.
  - Tab toggle **Log in** / "Already have an account? **Log in**" → navigate to Login.
- **Errors (inline):** "User already registered"; password-mismatch (client-side); weak-password.
- **Success:** show **"Check your email for a confirmation link"** (Flow A step 4) — do **not** navigate into the app until the link is clicked.

### Forgot Password — `936:61929` (Flow D)
- **Purpose:** request a password-reset magic link.
- **Fields:** **Work email** (required).
- **Buttons/links:**
  - **Send reset link** → `supabase.auth.resetPasswordForEmail(email, { redirectTo: <origin>/reset-password })`.
  - **← Back to log in** → navigate to Login.
  - **resend** → re-call `resetPasswordForEmail`.
- **Errors (inline):** show a generic success message even if the email doesn't exist (avoid account enumeration).
- **Success:** "Check your inbox — didn't receive an email? Check your spam folder or resend."

### OTP Verification — `936:61974` (DEFERRED)
- **Status:** **not built in Phase 1** (magic link is used instead). Kept for a future OTP flow. See Flow E. No Supabase call.

### Reset Password — `936:62030` (Flow D)
- **Purpose:** set a new password after clicking the reset magic link (user lands here on `/reset-password` with a recovery session).
- **Fields:** **New password** (required, with **show/hide eye toggle** + **strength indicator** Weak/Fair/Good/Strong) · **Confirm password** (required, eye toggle — validate match).
- **Password rule (display + validate):** at least **8 characters and include a number**.
- **Buttons/links:**
  - **Reset password** → `supabase.auth.updateUser({ password: newPassword })`.
  - **← Back** → navigate to Login.
- **Errors (inline):** "New password should be different from the old password"; weak-password; mismatch (client-side).
- **Success:** show "You'll be redirected to log in after reset" → navigate to `/login`.

---

## 4. Metadata fields — what to pass on signup

`supabase.auth.signUp` accepts an `options.data` object that Supabase stores as
`raw_user_meta_data` on the `auth.users` row. Pass:

```js
supabase.auth.signUp({
  email,
  password,
  options: { data: { full_name: fullName, company_name: companyName } },
})
```

- **`full_name`** → picked up by `handle_new_user` → written to **`Profile.name`**.
- **`company_name`** → picked up by the trigger → written to
  **`BusinessSettings.businessName`** (only if not already set — see §5).
- **If `full_name` is missing**, the trigger falls back to the **email
  local-part** (e.g. `admin@roundflow.test` → `admin`).

---

## 5. The `handle_new_user` trigger — what it does

*(Plain-language behaviour — the SQL lives in `docs/sql/handle_new_user_v2.sql`.)*

- **Fires automatically** after every new user is created in `auth.users`
  (email/password signup, Google OAuth, admin-created).
- **Creates a `Profile` row:** `supabaseUserId` = the new user's ID,
  `role = ADMIN`, `name` = `full_name` metadata (or the email prefix as fallback).
- **Seeds the business name:** if `company_name` metadata is present **and**
  `BusinessSettings.businessName` is not yet set, it writes the company name.
- **Idempotent / safe to retry:** `on conflict do nothing` for `Profile`,
  `on conflict do update … where businessName is null` for `BusinessSettings`.
- **v2 change:** it now **also seeds `BusinessSettings.businessName` from
  `company_name`** — v1 only created the Profile.

> Because the guard is `where businessName is null`, the company name from
> signup **will not overwrite** a business name already set in Setup Wizard
> step 1 (or the dev seed). See §7.

---

## 6. Session handling and route guards

- **Get the current session:** `const { data: { session } } = await supabase.auth.getSession()`.
- **Listen for changes:** `supabase.auth.onAuthStateChange((event, session) => { … })`
  (fires on `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED`, `PASSWORD_RECOVERY`).
- **Protected-route pattern:** if there is no session, redirect to `/login`.
- **Auth-screen guard:** if there **is** a session, redirect away from `/login`,
  `/signup`, etc. to `/dashboard`.
- **Token refresh:** the Supabase JS client refreshes the access token
  **automatically** — do **not** implement manual refresh.
- **Setup gate:** after `POST /setup/complete`, `setupCompleted = true` on
  `BusinessSettings`. On app load (once authenticated), call
  **`GET /setup/status`** — if `setupCompleted` is `false`, route to the Setup
  Wizard (`/setup`); otherwise route to `/dashboard`.
- **API calls:** attach the token from `supabase.auth.getSession()` as
  `Authorization: Bearer <access_token>` on every backend request (`/setup/*`,
  `/auth/me`, …).

---

## 7. ⚠️ Critical rules

> - **The OTP screen is NOT built in Phase 1** — a magic link handles both
>   signup confirmation and password reset. Never call `supabase.auth.verifyOtp()`.
>
> - **Never store the Supabase access token manually.** Retrieve it on demand
>   via `supabase.auth.getSession()` when you need it for a backend call.
>
> - **The anon key is public/safe** to expose in frontend code — it is not a
>   secret. (The **service-role** key is the secret one — never ship it.)
>
> - **The `/auth/callback` route must exist** in the React router, or Google
>   OAuth cannot complete (`exchangeCodeForSession()` runs there).
>
> - **Company name only seeds `BusinessSettings` if `businessName` is currently
>   null** — it will **not** overwrite a name set in Setup Wizard step 1.
>
> - **Password reset uses a magic link, not OTP** — land the user on
>   `/reset-password` and call `supabase.auth.updateUser({ password })`.
>
> - **Display Supabase errors inline, not as `alert()` popups.** Common
>   messages: `"Invalid login credentials"`, `"Email not confirmed"`,
>   `"User already registered"`.

---

## 8. Supabase project config checklist

Must be configured in the Supabase Dashboard **before** auth works:

- [ ] **Email provider enabled** — Authentication → Providers → Email.
- [ ] **Google OAuth configured** — Authentication → Providers → Google (Client ID + Secret).
- [ ] **Redirect URLs allowlisted** — Authentication → URL Configuration → Redirect URLs:
      `http://localhost:5173/auth/callback` (dev) + the production URL. Also add
      `.../reset-password` if you scope redirect URLs tightly.
- [ ] **Site URL set** — Authentication → URL Configuration → Site URL.
- [ ] **`handle_new_user` trigger v2 deployed** — run `docs/sql/handle_new_user_v2.sql`
      in the SQL Editor. *(Already applied + verified live 2026-07-08.)*

---

## 9. Quick-reference table

| Screen | Node ID | Flow | Key Supabase call | Deferred? |
|--------|---------|------|-------------------|-----------|
| Login | `936:61788` | B | `signInWithPassword` | No |
| Sign Up | `936:61853` | A | `signUp` with metadata | No |
| Forgot Password | `936:61929` | D | `resetPasswordForEmail` | No |
| OTP Verification | `936:61974` | — | — | **Yes — Phase 1 uses magic link** |
| Reset Password | `936:62030` | D | `updateUser` | No |

---

*Cross-reference: `docs/designFindings.md` Screens 1–5 (visual/field detail),
`docs/sql/handle_new_user_v2.sql` (trigger source), and the Setup Wizard handoff
(`docs/SETUP_WIZARD_HANDOFF_v2.md`) for what happens once a user is authenticated.*
