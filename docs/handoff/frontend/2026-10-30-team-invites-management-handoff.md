# Team Invites — Pending List, Cancel, Resend, Error Codes — Frontend Handoff

**Date:** 2026-10-30
**Audience:** frontend developer who built `/accept-invite` and the Settings →
Technicians invite modal.
**Follows:** [2026-10-30-team-invite-accept-handoff.md](2026-10-30-team-invite-accept-handoff.md)

**Short version:** the backend items from your handoff are done in code, apart
from the environment/Supabase config, which is an ops step (§6). You can now
build the pending-invites list with Cancel and Resend, and replace the
410 message-text matching with `code`.

---

## 1. New: list pending invites

```
GET /invites
Authorization: Bearer <admin/manager token>
```

**200**, newest first. Includes **expired** invites so they can be resent.
Accepted invites are not included. The token is not returned.

```json
[
  {
    "id": "clx…",
    "email": "jess@example.com",
    "role": "TECHNICIAN",
    "technicianId": "clx…",
    "expiresAt": "2026-11-06T10:00:00.000Z",
    "createdAt": "2026-10-30T10:00:00.000Z",
    "expired": false
  }
]
```

Suggested UI: a "Pending invites" list under Settings → Technicians. Show
"Expires 6 Nov" or an **Expired** badge from `expired`, with **Resend** and
**Cancel** on each row.

## 2. New: cancel an invite

```
DELETE /invites/:id        (id from GET /invites, not the token)
```

| Status | Meaning |
|---|---|
| 204 | Cancelled. The link in their email now gets 404 → your "invalid invite" screen. |
| 404 | Not found (or it belongs to another business). Refresh the list. |
| 409 `code: "INVITE_ACCEPTED"` | They accepted it in the meantime. Refresh the list. |

## 3. New: resend an invite

```
POST /invites/:id/resend
```

Sends the email again and resets the expiry to 7 days from now. This works
for expired invites too. The **token stays the same**, so a link in an earlier
email also keeps working.

| Status | Meaning |
|---|---|
| 200 | Updated `TenantInvite` (new `expiresAt`). Show "Invite re-sent". |
| 404 / 409 `INVITE_ACCEPTED` | Same as Cancel. |
| 503 | Email didn't send. The invite is unchanged, so it's safe to retry. |

Supabase rate-limits emails to the same address (about one a minute by
default). A quick double resend can come back as 503. Disable the button
briefly after a click.

## 4. Changed: 410 now carries a `code`

`GET /invites/:token` and `POST /invites/:token/accept`:

```json
{ "error": "Invite has expired",               "code": "INVITE_EXPIRED" }
{ "error": "Invite has already been accepted", "code": "INVITE_ACCEPTED" }
```

**Action:** switch from matching the `error` text to `code`. The text hasn't
changed, so the current code keeps working until you switch.

`code` is an optional field on the general error shape `{ error, code? }`.
Only the invite errors above set it for now.

## 5. Behaviour changes you don't need to code for

- **Re-inviting after expiry works.** `POST /invites` used to return 409 for an
  email whose invite had expired, so that person could never be invited again.
  Now only an **unexpired** pending invite returns 409. An expired one is replaced
  by the new invite, so it won't show twice in the list. If the
  modal gets 409, suggest using **Resend** from the pending list.
- **Inviting someone who already has a Supabase account.** Supabase won't
  send an invite to an email that already has an account. This happens, for example,
  when someone clicked an earlier invite link and closed the tab before finishing.
  The backend now detects this and sends a **magic sign-in link** to the same
  `/accept-invite?token=…` URL. They land on your page signed in, the same
  as with an invite, so no frontend change is needed. One small point: your
  password step will **replace** any password that account already had. That is
  fine for this case, but the copy could say "Set a password" rather than "Create".
- **Redirect fix.** The backend was sending `redirect_to` in the JSON body of
  the Supabase invite call. Supabase reads it from the query string, which is
  how supabase-js sends it, so the body value was probably ignored and users
  were sent to the Site URL without the token. It's now sent on the query
  string. This is a likely cause if your first real test lands on the
  wrong page.

## 6. Still needed before a real end-to-end test (ops, not code)

1. `INVITE_BASE_URL` = frontend origin, no trailing slash, in each
   environment's backend env.
2. Supabase → Authentication → URL Configuration → Redirect URLs: add
   `{INVITE_BASE_URL}/accept-invite**`, and on the dev project also
   `http://localhost:5173/**`.

## 7. Not verified yet

Everything is unit-tested with Supabase mocked. Nothing has been checked against a real Supabase project
yet, in particular:

- that Supabase returns 422 with `email_exists` / "already been registered"
  for an existing account, which is what triggers the magic-link fallback;
- that the magic link and the invite both land on `/accept-invite?token=…`
  once the redirect URLs above are configured.

Your planned end-to-end test covers both. Run it once with a fresh email,
and once with an email that already clicked an invite link.
