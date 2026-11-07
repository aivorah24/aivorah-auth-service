// Face login (passkeys): signed challenges, origins, and the /user/passkeys
// routes. The WebAuthn cryptography itself is @simplewebauthn/server's job and
// is stubbed here; what is tested is who may do what, and with which data.
process.env.PASSKEY_SECRET = 'test-secret';

jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(async (o) => ({ challenge: 'reg-challenge', rp: { id: o.rpID }, user: { name: o.userName }, excludeCredentials: o.excludeCredentials, authenticatorSelection: o.authenticatorSelection })),
  verifyRegistrationResponse: jest.fn(),
  generateAuthenticationOptions: jest.fn(async (o) => ({ challenge: `login-challenge-${Math.random()}`, rpId: o.rpID, userVerification: o.userVerification })),
  verifyAuthenticationResponse: jest.fn(),
}));

const mockAuth = {
  verifyIdToken: jest.fn(async (token) => {
    if (token === 'bad') throw new Error('invalid');
    const [email, age] = token.split('|');
    return { email, auth_time: Math.floor(Date.now() / 1000) - Number(age || 0) };
  }),
  getUserByEmail: jest.fn(async (email) => ({ uid: `uid-${email}`, disabled: false })),
  createCustomToken: jest.fn(async (uid) => `custom-token-for-${uid}`),
};
jest.mock('../services/firebaseAdmin', () => ({ auth: () => mockAuth }));

jest.mock('../services/supabase', () => {
  const state = { responses: {}, calls: [] };
  const from = jest.fn((table) => {
    const chain = { table, ops: [] };
    const step = (op) => (...args) => { chain.ops.push([op, ...args]); return chain; };
    ['select', 'eq', 'order', 'insert', 'update', 'delete'].forEach((op) => { chain[op] = step(op); });
    const next = () => {
      const q = state.responses[table];
      return Array.isArray(q) ? (q.length > 1 ? q.shift() : q[0]) : (q || { data: null, error: null });
    };
    chain.single = () => Promise.resolve(next());
    chain.maybeSingle = () => Promise.resolve(next());
    chain.then = (res, rej) => Promise.resolve(next()).then(res, rej);
    state.calls.push(chain);
    return chain;
  });
  return { from, _state: state };
});

const request = require('supertest');
const supabase = require('../services/supabase');
const webauthn = require('@simplewebauthn/server');
const passkeys = require('../services/passkeys');
const app = require('../index');

const ORIGIN = 'https://aivorah-frontend.vercel.app';
const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'asha@x.com', name: 'Asha', role: 'student' };
const as = (email, ageSeconds = 0) => ({ Authorization: `Bearer ${email}|${ageSeconds}`, Origin: ORIGIN });
const respond = (table, value) => { supabase._state.responses[table] = value; };
const opsOn = (table) => supabase._state.calls.filter((c) => c.table === table).flatMap((c) => c.ops);

beforeEach(() => {
  jest.clearAllMocks();
  supabase._state.responses = {};
  supabase._state.calls = [];
  passkeys._usedChallenges.clear();
});

describe('signed challenges', () => {
  test('come back intact for the same purpose and site', () => {
    const t = passkeys.signChallenge({ challenge: 'abc', purpose: 'login', rpID: 'aivorah.ai' });
    expect(passkeys.openChallenge(t, 'login', 'aivorah.ai').challenge).toBe('abc');
  });
  test('are refused when tampered with, reused, for another purpose or site, or expired', () => {
    const t = passkeys.signChallenge({ challenge: 'abc', purpose: 'login', rpID: 'aivorah.ai' });
    expect(() => passkeys.openChallenge(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'login', 'aivorah.ai')).toThrow(/expired/);
    expect(() => passkeys.openChallenge(t, 'register', 'aivorah.ai')).toThrow();
    expect(() => passkeys.openChallenge(t, 'login', 'evil.com')).toThrow();
    passkeys.openChallenge(t, 'login', 'aivorah.ai');
    expect(() => passkeys.openChallenge(t, 'login', 'aivorah.ai')).toThrow(); // used once
    const now = Date.now;
    const old = passkeys.signChallenge({ challenge: 'x', purpose: 'login', rpID: 'aivorah.ai' });
    Date.now = () => now() + 6 * 60 * 1000;
    try { expect(() => passkeys.openChallenge(old, 'login', 'aivorah.ai')).toThrow(); } finally { Date.now = now; }
  });
  test('only the app\'s own websites may use face login', () => {
    expect(passkeys.relyingParty(ORIGIN)).toEqual({ origin: ORIGIN, rpID: 'aivorah-frontend.vercel.app' });
    expect(() => passkeys.relyingParty('https://evil.example')).toThrow(/not available on this website/);
  });
});

describe('adding face login', () => {
  test('needs a sign-in, and a recent one', async () => {
    expect((await request(app).post('/user/passkeys/register/options').set('Origin', ORIGIN)).status).toBe(401);
    respond('users', { data: USER, error: null });
    const stale = await request(app).post('/user/passkeys/register/options').set(as(USER.email, 2 * 3600));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('RECENT_SIGN_IN_REQUIRED');
  });

  test('options ask for this device\'s face / fingerprint unlock and skip passkeys already added', async () => {
    respond('users', { data: USER, error: null });
    respond('user_passkeys', { data: [{ id: 'p1', credential_id: 'cred-1', transports: ['internal'] }], error: null });
    const res = await request(app).post('/user/passkeys/register/options').set(as(USER.email));
    expect(res.status).toBe(200);
    expect(res.body.options.authenticatorSelection).toEqual({ authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' });
    expect(res.body.options.excludeCredentials).toEqual([{ id: 'cred-1', transports: ['internal'] }]);
    expect(res.body.options.rp.id).toBe('aivorah-frontend.vercel.app');
    expect(res.body.challengeToken).toMatch(/\./);
  });

  test('a verified device key is stored for the signed-in user (public key only)', async () => {
    respond('users', { data: USER, error: null });
    respond('user_passkeys', [{ data: [], error: null }, { data: { id: 'p9', device_label: 'Asha\'s laptop', created_at: 'now' }, error: null }]);
    const opts = await request(app).post('/user/passkeys/register/options').set(as(USER.email));
    webauthn.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credentialID: 'new-cred', credentialPublicKey: new Uint8Array([1, 2, 3]), counter: 0 },
    });
    const res = await request(app).post('/user/passkeys/register').set(as(USER.email))
      .send({ challengeToken: opts.body.challengeToken, deviceLabel: 'Asha\'s laptop', response: { id: 'new-cred', response: { transports: ['internal'] } } });
    expect(res.status).toBe(201);
    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: 'reg-challenge', expectedOrigin: ORIGIN, expectedRPID: 'aivorah-frontend.vercel.app', requireUserVerification: true,
    }));
    const insert = opsOn('user_passkeys').find(([op]) => op === 'insert')[1];
    expect(insert).toEqual({ user_id: USER.id, credential_id: 'new-cred', public_key: 'AQID', counter: 0, transports: ['internal'], device_label: 'Asha\'s laptop' });
  });

  test('a challenge issued to another account cannot be used', async () => {
    respond('users', { data: USER, error: null });
    const token = passkeys.signChallenge({ challenge: 'c', purpose: 'register', userId: 'someone-else', rpID: 'aivorah-frontend.vercel.app' });
    const res = await request(app).post('/user/passkeys/register').set(as(USER.email)).send({ challengeToken: token, response: {} });
    expect(res.status).toBe(400);
    expect(webauthn.verifyRegistrationResponse).not.toHaveBeenCalled();
  });
});

describe('signing in with face login', () => {
  async function loginToken() {
    const res = await request(app).post('/user/passkeys/login/options').set('Origin', ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.options.userVerification).toBe('required');
    return res.body.challengeToken;
  }

  test('a verified face login returns a Firebase sign-in token for that account', async () => {
    const challengeToken = await loginToken();
    respond('user_passkeys', { data: { id: 'p1', user_id: USER.id, credential_id: 'cred-1', public_key: 'AQID', counter: 4, transports: ['internal'] }, error: null });
    respond('users', { data: { id: USER.id, email: USER.email, role: 'student' }, error: null });
    webauthn.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: true, authenticationInfo: { newCounter: 5 } });

    const res = await request(app).post('/user/passkeys/login').set('Origin', ORIGIN).send({ challengeToken, response: { id: 'cred-1' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: 'custom-token-for-uid-asha@x.com' });
    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      requireUserVerification: true, expectedOrigin: ORIGIN,
      credential: expect.objectContaining({ id: 'cred-1', counter: 4 }),
    }));
    expect(opsOn('user_passkeys').find(([op]) => op === 'update')[1]).toMatchObject({ counter: 5 });
  });

  test('an unknown device key, or a failed check, signs nobody in', async () => {
    let challengeToken = await loginToken();
    respond('user_passkeys', { data: null, error: null });
    expect((await request(app).post('/user/passkeys/login').set('Origin', ORIGIN).send({ challengeToken, response: { id: 'nope' } })).status).toBe(401);

    challengeToken = await loginToken();
    respond('user_passkeys', { data: { id: 'p1', user_id: USER.id, credential_id: 'cred-1', public_key: 'AQID', counter: 0 }, error: null });
    webauthn.verifyAuthenticationResponse.mockRejectedValueOnce(new Error('signature mismatch'));
    expect((await request(app).post('/user/passkeys/login').set('Origin', ORIGIN).send({ challengeToken, response: { id: 'cred-1' } })).status).toBe(401);
    expect(mockAuth.createCustomToken).not.toHaveBeenCalled();
  });

  test('another website cannot use Aivorah face login', async () => {
    expect((await request(app).post('/user/passkeys/login/options').set('Origin', 'https://evil.example')).status).toBe(400);
  });
});

describe('managing face logins', () => {
  test('lists and removes only the signed-in user\'s own', async () => {
    respond('users', { data: USER, error: null });
    respond('user_passkeys', { data: [{ id: 'p1', credential_id: 'c', device_label: 'Laptop', created_at: 't1', last_used_at: null }], error: null });
    const list = await request(app).get('/user/passkeys').set(as(USER.email, 5 * 86400)); // no recent sign-in needed to view
    expect(list.body).toEqual({ passkeys: [{ id: 'p1', deviceLabel: 'Laptop', createdAt: 't1', lastUsedAt: null }] });

    respond('user_passkeys', { data: [{ id: 'p1' }], error: null });
    const del = await request(app).delete('/user/passkeys/22222222-2222-2222-2222-222222222222').set(as(USER.email));
    expect(del.body).toEqual({ ok: true });
    expect(opsOn('user_passkeys')).toContainEqual(['eq', 'user_id', USER.id]);
  });
});
