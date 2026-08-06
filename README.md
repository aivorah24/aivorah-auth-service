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

Runs `tests/smoke.js` — hits `/health`, `/user/sync`, and `/user/role` for
student, teacher, and parent demo accounts, checks the responses. Requires the
service to already be running (`npm start` in another terminal) and reachable
Supabase credentials in `.env`.

`/user/send-verification` and `/user/verify/:token` are NOT smoke-tested here
on purpose — they write to the account (flip `accountStatus`, send a real
email) rather than just read, so running them against the real demo accounts
on every test run would break their "already verified" state. Those two are
covered by the Playwright signup specs in `aivorah-e2e-tests`, which use
disposable throwaway emails instead.

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
