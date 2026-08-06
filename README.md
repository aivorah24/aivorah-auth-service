# aivorah-auth-service

The login + signup endpoints, extracted from `ai-mentor/server/routes/user.js`
into their own standalone service — proves auth can build and run independently
of the rest of the app (see `codebase-restructure-plan.md`, Phase 2).

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
1. **Login checks** — `/health`, `/user/sync`, `/user/role` against the real
   student/teacher/parent/school_admin demo accounts (all 4 personas).
   Read-only, safe to repeat.
2. **Signup flow** — for each of student, teacher, and parent (the 3 roles
   that can actually self-signup - `school_admin` accounts are provisioned
   separately, not self-registered), creates a disposable throwaway account
   (`/user/sync` with a name), sends it a real verification email
   (`/user/send-verification`), then confirms a deliberately wrong token gets
   rejected (`/user/verify/:token`). A fresh unique email is used each run
   (same trick the Playwright signup specs in `aivorah-e2e-tests` use), so
   it never touches or breaks the real demo accounts' verified state.

## What's here

- `index.js` — the whole server: mounts `routes/auth.js`, nothing else
- `routes/auth.js` — thin routes, forward to the service functions
- `services/auth-service.js` — login (`syncUserProfile`) and signup
  (`getUserRole`, `sendVerification`, `verifyEmailToken`) logic, unchanged
  from `ai-mentor`
- `services/preferences.js` — small shared helper `syncUserProfile` depends on
- `services/mailer.js` — sends the branded verification email (Resend, with
  Gmail SMTP fallback)
- `services/supabase.js` — Supabase client
- `utils/encryption.js` — used to decrypt the `phone` field in the `/sync` response

## Endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/user/sync` | Called on every login and signup — upserts/reads the user's Supabase profile |
| GET | `/user/role?email=` | Looks up an existing account's role (signup's "already registered" check) |
| POST | `/user/send-verification` | Sends the branded "verify your email" link |
| GET | `/user/verify/:token` | Verification link landing page — marks the account active |
