// Integration tests — hit the real Express routes (routes/auth.js) through
// Supertest, going through the full request/response cycle, with Supabase
// mocked so no real DB is needed.

jest.mock('../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
    ilike: jest.fn().mockReturnThis(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

jest.mock('../services/preferences', () => ({
  getPreferences: jest.fn(),
}));

jest.mock('../services/mailer', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/firebaseAdmin', () => null);

jest.mock('../utils/encryption', () => ({
  decrypt: jest.fn((v) => v),
}));

const request = require('supertest');
const supabase = require('../services/supabase');
const { getPreferences } = require('../services/preferences');
const app = require('../index');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /user/sync', () => {
  test('no email -> 400', async () => {
    const res = await request(app).post('/user/sync').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('email required');
  });

  test('new signup with name+email -> 200, row created', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // existingRow lookup
      .mockResolvedValueOnce({ data: null, error: null }); // stale-prefs lookup
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '10', email: 'new@a.com', role: 'student', onboarding_complete: null },
      error: null,
    });
    getPreferences.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/user/sync')
      .send({ name: 'New Kid', email: 'new@a.com', role: 'student' });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('new@a.com');
    expect(res.body.onboardingComplete).toBe(false);
  });

  test('login (email only) -> 200, read-only, no upsert', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: '11', email: 'existing@a.com', role: 'teacher', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['teacher'], isPro: true });

    const res = await request(app).post('/user/sync').send({ email: 'existing@a.com' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('teacher');
    expect(res.body.onboardingComplete).toBe(true);
    expect(supabase._chain.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /user/role', () => {
  test('no email -> 400', async () => {
    const res = await request(app).get('/user/role');
    expect(res.status).toBe(400);
  });

  test('unknown email -> 404', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await request(app).get('/user/role').query({ email: 'nobody@a.com' });
    expect(res.status).toBe(404);
  });

  test('known email -> 200 with role', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { role: 'parent' }, error: null });
    const res = await request(app).get('/user/role').query({ email: 'p@a.com' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('parent');
  });
});

describe('POST /user/send-verification', () => {
  test('missing email/name -> 400', async () => {
    const res = await request(app).post('/user/send-verification').send({ email: 'a@a.com' });
    expect(res.status).toBe(400);
  });

  test('already-active account -> 200, alreadyVerified:true, no email resent', async () => {
    const { sendVerificationEmail } = require('../services/mailer');
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { data: { accountStatus: 'active' } },
      error: null,
    });

    const res = await request(app)
      .post('/user/send-verification')
      .send({ email: 'a@a.com', name: 'A' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyVerified: true });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('GET /user/check-verified', () => {
  test('missing email -> 400', async () => {
    const res = await request(app).get('/user/check-verified');
    expect(res.status).toBe(400);
  });

  test('active account -> verified:true', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { data: { accountStatus: 'active' } }, error: null });
    const res = await request(app).get('/user/check-verified').query({ email: 'a@a.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true, accountStatus: 'active' });
  });
});

describe('GET /user/verify/:token', () => {
  test('valid token redirects with verified=1', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { data: { verifyToken: 'tok', verifyTokenExpiry: Date.now() + 100000, accountStatus: 'pending_verification' } },
      error: null,
    });
    const res = await request(app).get('/user/verify/tok').query({ email: 'a@a.com' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('verified=1');
  });

  test('wrong token redirects with error=1', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { data: { verifyToken: 'real-token', accountStatus: 'pending_verification' } },
      error: null,
    });
    const res = await request(app).get('/user/verify/wrong-token').query({ email: 'a@a.com' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=1');
  });
});

describe('POST /user/send-password-reset', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  test('missing email -> 400', async () => {
    const res = await request(app).post('/user/send-password-reset').send({});
    expect(res.status).toBe(400);
  });

  test('known email -> 200, ok:true (via REST fallback, no Firebase Admin configured in this suite)', async () => {
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ oobLink: 'https://firebaseapp.com/action?oobCode=int123' }),
    });

    const res = await request(app).post('/user/send-password-reset').send({ email: 'a@a.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('EMAIL_NOT_FOUND -> still 200, ok:true (no user enumeration)', async () => {
    global.fetch.mockResolvedValueOnce({
      json: async () => ({ error: { message: 'EMAIL_NOT_FOUND' } }),
    });

    const res = await request(app).post('/user/send-password-reset').send({ email: 'nobody@a.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /health', () => {
  test('returns ok:true', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
