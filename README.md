# aivorah-auth-service

The `/user/sync` login endpoint, extracted from `ai-mentor/server/routes/user.js`
into its own standalone service — proves login can build and run independently
of the rest of the app (see `codebase-restructure-plan.md`, Phase 2).

**Status:** standalone proof only. The live `ai-mentor` app still runs its own
copy of this code and has NOT been rewired to call this service — that's a
separate, later step (routing/proxy work), not done yet.

## Run it

```
npm install
cp .env.example .env   # fill in real Supabase + encryption values
npm start               # listens on PORT (default 4001)
```

## Test it

```
npm test
```

Runs `tests/smoke.js` — hits `/health` and `/user/sync` for student, teacher,
and parent demo accounts, checks the responses. Requires the service to
already be running (`npm start` in another terminal) and reachable Supabase
credentials in `.env`.

## What's here

- `index.js` — the whole server: mounts `routes/auth.js`, nothing else
- `routes/auth.js` — thin route, forwards to the service function
- `services/auth-service.js` — the actual `/user/sync` logic (unchanged from `ai-mentor`)
- `services/preferences.js` — small shared helper `/user/sync` depends on
- `services/supabase.js` — Supabase client
- `utils/encryption.js` — used to decrypt the `phone` field in the response
