# aivorah-auth-service

The full auth domain - login, signup, email verification, and password reset -
extracted from `ai-mentor/server/routes/user.js` into its own standalone
service. Proves auth can build and run independently of the rest of the app
(see `codebase-restructure-plan.md`, Phase 2).

**Status:** standalone proof only. The live `ai-mentor` app still runs its own
copy of this code and has NOT been rewired to call this service — that's a
separate, later step (routing/proxy work), not done yet.

## Run it

```
npm install
cp .env.example .env   # fill in real Supabase + encryption + email values
npm start               # listens on PORT (default 4001)
```

## Test it

```
npm test
```

Runs `tests/smoke.js`. Requires the service to already be running (`npm start`
in another terminal) and reachable Supabase + email credentials in `.env`.

Two parts:
1. **Login checks** — for all 4 personas (student/teacher/parent/school_admin
   demo accounts): `/health`, `/user/sync`, `/user/role`, `/user/check-verified`,
   `/user/send-password-reset`. All either read-only or non-destructive for an
   existing account, safe to repeat.
2. **Signup + verification flow** — for each of student, teacher, and parent
   (the 3 roles that can actually self-signup - `school_admin` accounts are
   provisioned separately, not self-registered): creates a disposable
   throwaway account (`/user/sync` with a name), sends it a real verification
   email (`/user/send-verification`), confirms a wrong token gets rejected
   (`/user/verify/:token`), confirms `/user/check-verified` correctly reports
   `false`, then flips `accountStatus` directly in Supabase (simulating a real
   link click, since a script can't read a real inbox) and confirms
   `/user/check-verified` now reports `true`. A fresh unique email is used
   each run, so it never touches or breaks the real demo accounts' state.

## What's here

- `index.js` — the whole server: mounts `routes/auth.js`, nothing else
- `routes/auth.js` — thin routes, forward to the service functions
- `services/auth-service.js` — login (`syncUserProfile`), signup
  (`getUserRole`, `sendVerification`, `verifyEmailToken`), verification
  polling (`checkVerified`), and password reset (`sendPasswordReset`) logic,
  unchanged from `ai-mentor`
- `services/preferences.js` — small shared helper `syncUserProfile` depends on
- `services/firebaseAdmin.js` — Firebase Admin SDK init, used by
  `sendPasswordReset` to generate reset links
- `services/mailer.js` — sends the branded verification/reset emails (Resend,
  with Gmail SMTP fallback)
- `services/supabase.js` — Supabase client
- `utils/encryption.js` — used to decrypt the `phone` field in the `/sync` response

## Endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/user/sync` | Called on every login and signup — upserts/reads the user's Supabase profile |
| GET | `/user/role?email=` | Looks up an existing account's role (signup's "already registered" check) |
| POST | `/user/send-verification` | Sends the branded "verify your email" link |
| GET | `/user/verify/:token` | Verification link landing page — marks the account active |
| GET | `/user/check-verified?email=` | Polled by the app every 2s while waiting for verification |
| POST | `/user/send-password-reset` | Sends a Firebase password-reset link, delivered via the parent's email for `@aivorah.student` synthetic accounts |
