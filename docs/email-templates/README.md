# RoundFlow auth email templates

Supabase sends all sign-in emails (technician invites, "email me a new link", magic links, password resets). Paste each file into **Supabase Dashboard > Authentication > Email Templates** for the project, and set the subject shown below.

| File | Supabase template | Subject |
|---|---|---|
| 1-invite-user.html | Invite user | You're invited to RoundFlow |
| 2-confirm-signup.html | Confirm sign up | Confirm your email for RoundFlow |
| 3-magic-link.html | Magic link | Your RoundFlow sign-in link |
| 4-reset-password.html | Reset password | Reset your RoundFlow password |
| 5-change-email.html | Change email address | Confirm your new RoundFlow email |
| 6-reauthentication.html | Reauthentication | Your RoundFlow security code |

Notes:
- The templates use Supabase's variables: `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}`, `{{ .Token }}`. Keep them exactly as written.
- The wordmark is styled text so it renders everywhere. To use the logo image instead, host a PNG (email clients do not reliably show SVG) and replace the wordmark cell.
- Brand tokens come from roundflow-frontend/src/styles/globals.css (primary #029BB6, accent surface #E8F6F9).
- The invite wording is generic because the backend sends `data: {}` with the invite. To name the business ("Acme Windows has invited you"), pass `{ businessName }` in `sendInviteEmail` and use `{{ .Data.businessName }}` in the template.
- The hosted project's sender address and SMTP are separate settings (Authentication > SMTP). The default Supabase sender is rate-limited and often lands in spam; use your own domain for production.
- Local test stack: the e2e journey stack uses GoTrue's default templates, so these do not show there unless you mount them.
