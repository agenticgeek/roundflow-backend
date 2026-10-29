# Team Invites — Accept Invite Screen — Frontend Handoff

**Date:** 2026-10-30
**Audience:** frontend developer building the new Accept Invite screen (and the "Invite team member" action that feeds it).

**Short version:** all backend endpoints already exist on dev. No backend
changes are needed for the happy flow. The frontend needs one new page,
`/accept-invite?token=…`, that (1) waits for the Supabase session the invite
email signs the user into, (2) asks for name + password, and (3) calls
`POST /invites/:token/accept`. Until that last call succeeds, the invitee is
**not** part of the business — clicking the email link alone does not make
them live.

---

## The flow at a glance

```
Admin/Manager                Backend                     Supabase                 Invitee
     │  POST /invites            │                            │                       │
     │──────────────────────────▶│  create TenantInvite row   │                       │
     │                           │  POST /auth/v1/invite ────▶│  creates auth user,   │
     │◀────────── 201 invite ────│                            │  sends invite email ─▶│
     │                           │                            │                       │ clicks link
     │                           │                            │◀──────────────────────│
     │                           │                            │  signs them in,       │
     │                           │                            │  redirects to         │
     │                           │                            │  /accept-invite?token │
     │                           │   GET /invites/:token  ◀───────────────────────────│ (page load)
     │                           │   ─────── email, role ─────────────────────────────▶│
     │                           │                            │◀── updateUser(pwd) ───│ (submit)
     │                           │   POST /invites/:token/accept (Bearer) ◀────────────│
     │                           │   creates Profile, marks accepted, links Technician │
     │                           │   ─────── 201 { profile } ─────────────────────────▶│ → app home
```

---

## 1. Sending the invite (existing admin screen)

```
POST /invites
Authorization: Bearer <admin/manager access token>
Content-Type: application/json

{
  "email": "jess@example.com",
  "role": "TECHNICIAN",          // optional: ADMIN | MANAGER | TECHNICIAN (default TECHNICIAN)
  "technicianId": "clx…"         // optional: link to an existing Technician record
}
```

**201** → the `TenantInvite` row (`id`, `email`, `role`, `token`, `expiresAt`,
`acceptedAt: null`, `technicianId`, …). Show "Invite sent to jess@example.com".

Pass `technicianId` when inviting from a technician's row (e.g. the setup
wizard's technician list), so the new login is automatically linked to that
technician's rounds and visits. Leave it out for office staff.

The invite is valid for **7 days**.

## 2. The Accept Invite page — `/accept-invite?token=<token>`

The invite email's link goes through Supabase, which signs the user in and
then redirects here. The Supabase session arrives in the URL; supabase-js
picks it up automatically (`detectSessionInUrl`, on by default).

### 2a. On load

1. Wait for the Supabase session to be ready — `await supabase.auth.getSession()`
   (or listen for the `SIGNED_IN` event) before calling anything that needs auth.
2. Read `token` from the query string and fetch the invite details (public,
   no auth header needed):

   ```
   GET /invites/:token
   ```

   **200**
   ```json
   {
     "email": "jess@example.com",
     "role": "TECHNICIAN",
     "tenantId": "clx…",
     "expiresAt": "2026-11-06T10:00:00.000Z"
   }
   ```

3. Render: "You've been invited to join RoundFlow as a **Technician**", with
   the email shown read-only.

### 2b. Form

| Field | Rule |
|---|---|
| Email | Read-only, from `GET /invites/:token` |
| Full name | Required, not blank — sent to the backend |
| Password + confirm | Required — set in Supabase, never sent to the backend |

The password matters: an invited Supabase user has **no password yet**.
Without this step they could only ever sign back in via magic links.

### 2c. On submit — in this order

1. Set the password on the Supabase account:

   ```ts
   const { error } = await supabase.auth.updateUser({ password });
   ```

2. Accept the invite with the current Supabase access token:

   ```
   POST /invites/:token/accept
   Authorization: Bearer <supabase session access_token>
   Content-Type: application/json

   { "name": "Jess Smith" }
   ```

   **201** (first accept) or **200** (already accepted — treat as success).
   Profile shown abbreviated; the fields you'll use are `role` and `tenantId`:
   ```json
   {
     "profile": {
       "id": "clx…",
       "supabaseUserId": "…",
       "tenantId": "clx…",
       "role": "TECHNICIAN",
       "name": "Jess Smith"
     }
   }
   ```

3. Redirect into the app. Suggested: `TECHNICIAN` → Today's Work;
   `ADMIN`/`MANAGER` → Dashboard.

From this point the user is fully live: next time they sign in normally
with email + the password they just set.

## 3. Things to know

- **Don't route invitees through the normal Sign Up page.** Supabase already
  created their account when the invite was sent, so sign-up with that email
  fails with "already registered". The invite link is the entry point.
- **Calling accept twice is safe.** It returns 200 with the existing profile,
  so a double-click or retry won't break anything.
- **If they close the tab before submitting**, they're signed in to Supabase
  but not yet in the business. Re-clicking the invite email link (within the
  7 days) brings them back to this page to finish.

## 4. Error handling (minimal, for completeness)

The happy flow is above; these are the responses worth handling with a
friendly message rather than a generic error:

| Call | Status | Meaning | Suggested UI |
|---|---|---|---|
| `GET /invites/:token` | 404 | Bad token | "This invite link isn't valid." |
| `GET` / `POST accept` | 410 | Expired or already accepted (see `error` text) | Expired → "Ask your manager to resend." Accepted → link to Sign in |
| `POST accept` | 403 | Signed in as a different email, or account belongs to another business | Show message + Sign out button |
| `POST accept` | 400 | Name missing/blank | Inline field error |
| `POST accept` | 500 "technician link failed" | Account created, link step failed | "Almost done — please try again" (retry is safe) |

**Expired Supabase link:** Supabase's sign-in link expires much sooner than
our 7-day invite. If the user lands here with no session (URL hash contains
`error_code=otp_expired`), call `GET /invites/:token` to get the email and
offer a "Send me a new sign-in link" button:

```ts
await supabase.auth.signInWithOtp({
  email,
  options: { emailRedirectTo: window.location.href },
});
```

They click the new email, land back on this page with a session, and
continue from §2a.

## 5. Config that must be in place (backend / Supabase — not frontend code)

- **Supabase → Authentication → URL Configuration → Redirect URLs** must
  include the accept-invite URL for each environment, e.g.
  `https://www.roundflow.ai/accept-invite**` (or `https://www.roundflow.ai/**`). Otherwise Supabase ignores the
  redirect and sends users to the Site URL, losing the token.
- **`INVITE_BASE_URL`** on the backend must be the frontend origin
  (e.g. `https://www.roundflow.ai`, no trailing slash). The backend builds
  the link as `${INVITE_BASE_URL}/accept-invite?token=…`.
- Optional: rebrand the Supabase **"Invite user"** email template.

## 6. Related change: setup wizard step 10 is now optional

Separately, setup wizard step 10 (Assign Technicians to Rounds) no longer
blocks **Go live**. In `GET /setup/status`, step 10 now has
`deferred: true`; its `complete` flag still reflects reality.
`allRequiredComplete` can be `true` while step 10 is incomplete — show
step 10 as optional/skippable instead of disabling Go live on it.
