/**
 * /user/passkeys - face login (services/passkeys.js).
 *
 *   POST   /user/passkeys/register/options  signed in, recent sign-in -> { options, challengeToken }
 *   POST   /user/passkeys/register          signed in, recent sign-in { response, challengeToken, deviceLabel? }
 *   GET    /user/passkeys                   signed in -> { passkeys: [{ id, deviceLabel, createdAt, lastUsedAt }] }
 *   DELETE /user/passkeys/:id               signed in
 *   POST   /user/passkeys/login/options     public -> { options, challengeToken }
 *   POST   /user/passkeys/login             public { response, challengeToken } -> { token } (Firebase custom token)
 *
 * The signed-in user always comes from their Firebase token. These checks are
 * always enforced (never the monitor-only mode of middleware/tokenCheck).
 */
const express = require('express');
const firebaseAdmin = require('../services/firebaseAdmin');
const supabase = require('../services/supabase');
const { decodeBearer } = require('../middleware/tokenCheck');
const passkeys = require('../services/passkeys');

const router = express.Router();
// Adding a way to sign in needs a fresh sign-in (as deleting the account does).
const RECENT_SIGN_IN_SECONDS = 30 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signedIn({ recent = false } = {}) {
  return async (req, res, next) => {
    const { status, decoded } = await decodeBearer(req);
    if (status === 'unconfigured') return res.status(500).json({ error: 'Sign-in is not configured on this server' });
    if (status !== 'ok') return res.status(401).json({ error: 'Sign in required' });
    if (recent && (!decoded.auth_time || Date.now() / 1000 - decoded.auth_time > RECENT_SIGN_IN_SECONDS)) {
      return res.status(401).json({ error: 'For your security, sign out and sign in again, then add face login.', code: 'RECENT_SIGN_IN_REQUIRED' });
    }
    const email = String(decoded.email || '').toLowerCase().trim();
    if (!email) return res.status(401).json({ error: 'Sign-in has no email' });
    const { data: user } = await supabase.from('users').select('id, email, name, role').eq('email', email).maybeSingle();
    if (!user) return res.status(403).json({ error: 'No Aivorah account for this sign-in' });
    req.user = user;
    next();
  };
}

const fail = (res, err, fallback) => {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error('[passkeys]', fallback, err?.message);
  return res.status(500).json({ error: fallback });
};

router.post('/register/options', signedIn({ recent: true }), async (req, res) => {
  try { res.json(await passkeys.registrationOptions(req.user, req.headers.origin)); }
  catch (err) { fail(res, err, 'Could not start adding face login'); }
});

router.post('/register', signedIn({ recent: true }), async (req, res) => {
  try {
    const passkey = await passkeys.registerPasskey(req.user, req.headers.origin, req.body || {});
    res.status(201).json({ ok: true, passkey });
  } catch (err) { fail(res, err, 'Could not add face login'); }
});

router.get('/', signedIn(), async (req, res) => {
  try { res.json({ passkeys: await passkeys.listPasskeys(req.user.id) }); }
  catch (err) { fail(res, err, 'Could not load your face logins'); }
});

router.delete('/:id', signedIn(), async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    const removed = await passkeys.removePasskey(req.user.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Could not remove face login'); }
});

router.post('/login/options', async (req, res) => {
  try { res.json(await passkeys.loginOptions(req.headers.origin)); }
  catch (err) { fail(res, err, 'Could not start face login'); }
});

router.post('/login', async (req, res) => {
  try {
    if (!firebaseAdmin) return res.status(500).json({ error: 'Sign-in is not configured on this server' });
    const user = await passkeys.verifyLogin(req.headers.origin, req.body || {});
    const fbUser = await firebaseAdmin.auth().getUserByEmail(user.email);
    if (fbUser.disabled) return res.status(403).json({ error: 'This account is disabled' });
    const token = await firebaseAdmin.auth().createCustomToken(fbUser.uid, { via: 'passkey' });
    res.json({ token });
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return res.status(401).json({ error: 'No Aivorah account for this face login' });
    fail(res, err, 'Face login failed. Please try again.');
  }
});

module.exports = router;
