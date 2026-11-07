/**
 * Face login with passkeys (WebAuthn). The face (or fingerprint) check runs on
 * the user's own device - Face ID, Windows Hello, Android face unlock - and
 * never reaches Aivorah. We keep only each device's public key
 * (table user_passkeys, aivorah-db 0022). A successful passkey sign-in returns
 * a Firebase custom token, so the app signs in exactly as with a password.
 *
 * Challenges are stateless: a random challenge signed with HMAC, with purpose,
 * user and expiry (5 min), handed to the browser and checked when it comes
 * back; each challenge is accepted once per server instance.
 *
 * Env: PASSKEY_ORIGINS (comma list of app origins, optional - defaults below),
 * PASSKEY_SECRET (optional - otherwise derived from the Firebase service account).
 */
const crypto = require('crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const supabase = require('./supabase');

const RP_NAME = 'Aivorah';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ORIGINS = [
  'https://aivorah-frontend.vercel.app',
  'https://aivorah.ai',
  'https://www.aivorah.ai',
  'http://localhost:8081',
  'http://localhost:19006',
];

function allowedOrigins() {
  const fromEnv = String(process.env.PASSKEY_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ORIGINS;
}

// The app origin of this request (from the browser's Origin header) and its
// passkey scope (rpID = the host name). Unknown origins are refused.
function relyingParty(origin) {
  const o = String(origin || '').replace(/\/$/, '');
  if (!allowedOrigins().includes(o)) {
    const e = new Error('Face login is not available on this website');
    e.status = 400;
    throw e;
  }
  return { origin: o, rpID: new URL(o).hostname };
}

function secret() {
  const s = process.env.PASSKEY_SECRET
    || (process.env.FIREBASE_SERVICE_ACCOUNT_B64 && `fb:${process.env.FIREBASE_SERVICE_ACCOUNT_B64}`)
    || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!s) {
    const e = new Error('Face login is not configured on this server');
    e.status = 500;
    throw e;
  }
  return crypto.createHash('sha256').update(`aivorah-passkeys:${s}`).digest();
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// { challenge, purpose, userId?, rpID, exp } -> "payload.signature"
function signChallenge(data) {
  const payload = b64u(JSON.stringify({ ...data, exp: Date.now() + CHALLENGE_TTL_MS }));
  const sig = b64u(crypto.createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

const usedChallenges = new Map(); // challenge -> expiry (one use per instance)
function openChallenge(token, purpose, rpID) {
  const [payload, sig] = String(token || '').split('.');
  const bad = () => Object.assign(new Error('This face login request has expired. Please try again.'), { status: 400 });
  if (!payload || !sig) throw bad();
  const expected = b64u(crypto.createHmac('sha256', secret()).update(payload).digest());
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw bad();
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (data.purpose !== purpose || data.rpID !== rpID || !(data.exp > Date.now())) throw bad();
  for (const [c, exp] of usedChallenges) if (exp < Date.now()) usedChallenges.delete(c);
  if (usedChallenges.has(data.challenge)) throw bad();
  usedChallenges.set(data.challenge, data.exp);
  return data;
}

async function credentialsOf(userId) {
  const { data, error } = await supabase
    .from('user_passkeys')
    .select('id, credential_id, transports, device_label, created_at, last_used_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// ── Add face login on this device (signed-in user) ─────────────────────────
async function registrationOptions(user, origin) {
  const { rpID } = relyingParty(origin);
  const existing = await credentialsOf(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    // A passkey on this device, unlocked by its face / fingerprint check.
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports || [] })),
  });
  return { options, challengeToken: signChallenge({ challenge: options.challenge, purpose: 'register', userId: user.id, rpID }) };
}

async function registerPasskey(user, origin, { response, challengeToken, deviceLabel }) {
  const { rpID, origin: expectedOrigin } = relyingParty(origin);
  const ch = openChallenge(challengeToken, 'register', rpID);
  if (ch.userId !== user.id) throw Object.assign(new Error('This face login request is for another account'), { status: 400 });

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: true,
    });
  } catch (err) {
    throw Object.assign(new Error(`Face login could not be added: ${err.message}`), { status: 400 });
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw Object.assign(new Error('Face login could not be added'), { status: 400 });
  }
  const info = verification.registrationInfo;
  const { data, error } = await supabase.from('user_passkeys').insert({
    user_id: user.id,
    credential_id: typeof info.credentialID === 'string' ? info.credentialID : b64u(info.credentialID),
    public_key: b64u(info.credentialPublicKey),
    counter: info.counter || 0,
    transports: Array.isArray(response?.response?.transports) ? response.response.transports : [],
    device_label: String(deviceLabel || '').trim().slice(0, 80) || null,
  }).select('id, device_label, created_at').single();
  if (error) {
    if (/duplicate|unique/i.test(error.message)) throw Object.assign(new Error('Face login is already set up on this device'), { status: 409 });
    throw error;
  }
  return data;
}

// ── Sign in with face login (no account yet known) ─────────────────────────
async function loginOptions(origin) {
  const { rpID } = relyingParty(origin);
  // No allowCredentials: the device offers the passkeys it holds for Aivorah.
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  return { options, challengeToken: signChallenge({ challenge: options.challenge, purpose: 'login', rpID }) };
}

// -> the users row of whoever's passkey this is (checked), counter updated.
async function verifyLogin(origin, { response, challengeToken }) {
  const { rpID, origin: expectedOrigin } = relyingParty(origin);
  const ch = openChallenge(challengeToken, 'login', rpID);
  const fail = () => Object.assign(new Error('Face login did not match an Aivorah account on this device. Sign in with your email and password, then add face login in Settings.'), { status: 401 });

  const { data: cred } = await supabase
    .from('user_passkeys')
    .select('id, user_id, credential_id, public_key, counter, transports')
    .eq('credential_id', String(response?.id || ''))
    .maybeSingle();
  if (!cred) throw fail();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')),
        counter: Number(cred.counter) || 0,
        transports: cred.transports || [],
      },
    });
  } catch {
    throw fail();
  }
  if (!verification.verified) throw fail();

  await supabase.from('user_passkeys')
    .update({ counter: verification.authenticationInfo?.newCounter ?? cred.counter, last_used_at: new Date().toISOString() })
    .eq('id', cred.id);

  const { data: user } = await supabase.from('users').select('id, email, role, status').eq('id', cred.user_id).maybeSingle();
  if (!user?.email) throw fail();
  return user;
}

async function listPasskeys(userId) {
  return (await credentialsOf(userId)).map((c) => ({
    id: c.id, deviceLabel: c.device_label, createdAt: c.created_at, lastUsedAt: c.last_used_at,
  }));
}

async function removePasskey(userId, id) {
  const { data, error } = await supabase.from('user_passkeys').delete().eq('id', id).eq('user_id', userId).select('id');
  if (error) throw error;
  return (data || []).length > 0;
}

module.exports = {
  relyingParty, signChallenge, openChallenge,
  registrationOptions, registerPasskey, loginOptions, verifyLogin, listPasskeys, removePasskey,
  _usedChallenges: usedChallenges,
};
