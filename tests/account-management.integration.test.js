// Integration tests for the account-identity mutation routes (routes/account.js)
// — ported from the monolith (ai-mentor/server/routes/user.js) 2026-08-27.
// Supabase + Firebase Admin + mailer + otpStore all mocked, so no real
// network/DB/email calls happen here.

const mockUsersMaybeSingle = jest.fn();
const mockUsersSingle = jest.fn();
const mockListUsers = jest.fn();
const mockUpdateUserById = jest.fn();

jest.mock('../services/supabase', () => ({
  auth: {
    admin: {
      listUsers: (...args) => mockListUsers(...args),
      updateUserById: (...args) => mockUpdateUserById(...args),
    },
  },
  from: jest.fn((table) => {
    if (table === 'users') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: mockUsersMaybeSingle }) }),
        update: () => ({ eq: () => ({ select: () => ({ single: mockUsersSingle }) }) }),
        delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    }
    // Every other email-keyed table in the propagation loop / delete-account
    // cascade — `.update({...}).eq(...)` (awaited directly, no .then chain
    // needed since the code does `.then(({error}) => ...)` on the promise
    // supabase-js's real query builder returns) or `.delete().eq(...)`.
    return {
      select: () => ({ eq: () => ({ maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
  }),
}));

const mockGetUserByEmail = jest.fn();
const mockFbUpdateUser = jest.fn();
const mockFbDeleteUser = jest.fn();
const mockVerifyIdToken = jest.fn();
jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({
    getUserByEmail: (...args) => mockGetUserByEmail(...args),
    updateUser: (...args) => mockFbUpdateUser(...args),
    deleteUser: (...args) => mockFbDeleteUser(...args),
    verifyIdToken: (...args) => mockVerifyIdToken(...args),
  }),
}));

const mockSetOtp = jest.fn();
const mockGetOtp = jest.fn();
const mockDeleteOtp = jest.fn();
jest.mock('../services/otpStore', () => ({
  setOtp: (...args) => mockSetOtp(...args),
  getOtp: (...args) => mockGetOtp(...args),
  deleteOtp: (...args) => mockDeleteOtp(...args),
}));

const mockSendEmailOtpCode = jest.fn();
jest.mock('../services/mailer', () => ({
  sendEmailOtpCode: (...args) => mockSendEmailOtpCode(...args),
}));

const request = require('supertest');
const app = require('../index');

beforeEach(() => {
  jest.clearAllMocks();
  mockSendEmailOtpCode.mockResolvedValue(undefined);
  mockSetOtp.mockResolvedValue(undefined);
  mockDeleteOtp.mockResolvedValue(undefined);
  mockUsersMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockUsersSingle.mockResolvedValue({ data: { id: 'u1', name: 'A', email: 'new@a.com', role: 'teacher' }, error: null });
  mockListUsers.mockResolvedValue({ data: { users: [] } });
  mockGetUserByEmail.mockRejectedValue({ code: 'auth/user-not-found' });
});


describe('POST /user/email-otp/send', () => {
  test('an invalid email -> 400, never sends', async () => {
    const res = await request(app).post('/user/email-otp/send').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(mockSendEmailOtpCode).not.toHaveBeenCalled();
  });

  test('a real valid email sends a real 6-digit code and stores it', async () => {
    const res = await request(app).post('/user/email-otp/send').send({ email: 'new@a.com', name: 'Teacher' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSetOtp).toHaveBeenCalledWith('new@a.com', 'email_verify', { otp: expect.stringMatching(/^\d{6}$/) });
    expect(mockSendEmailOtpCode).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@a.com', name: 'Teacher' }));
  });
});

describe('POST /user/email-otp/verify', () => {
  test('no code requested -> 400', async () => {
    mockGetOtp.mockResolvedValue(null);
    const res = await request(app).post('/user/email-otp/verify').send({ email: 'new@a.com', otp: '123456' });
    expect(res.status).toBe(400);
  });

  test('an expired code -> 400 and deletes it', async () => {
    mockGetOtp.mockResolvedValue({ otp: '123456', expiresAt: Date.now() - 1000 });
    const res = await request(app).post('/user/email-otp/verify').send({ email: 'new@a.com', otp: '123456' });
    expect(res.status).toBe(400);
    expect(mockDeleteOtp).toHaveBeenCalledWith('new@a.com', 'email_verify');
  });

  test('a real correct code verifies successfully', async () => {
    mockGetOtp.mockResolvedValue({ otp: '123456', expiresAt: Date.now() + 60000 });
    const res = await request(app).post('/user/email-otp/verify').send({ email: 'new@a.com', otp: '123456' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true });
  });
});

describe('POST /user/change-email', () => {
  test('a real Google-SSO account is refused with the special error code', async () => {
    mockGetUserByEmail.mockResolvedValue({ providerData: [{ providerId: 'google.com' }] });
    const res = await request(app).post('/user/change-email')
      .send({ currentEmail: 'old@a.com', newEmail: 'new@a.com', otp: '123456' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GOOGLE_SSO_EMAIL_IMMUTABLE');
  });

  test('a real destination email already taken -> 409', async () => {
    mockUsersMaybeSingle.mockResolvedValue({ data: { id: 'taken' }, error: null });
    const res = await request(app).post('/user/change-email')
      .send({ currentEmail: 'old@a.com', newEmail: 'new@a.com', otp: '123456' });
    expect(res.status).toBe(409);
  });

  test('a real successful password-account rename updates Firebase Auth too', async () => {
    mockGetOtp.mockResolvedValue({ otp: '123456', expiresAt: Date.now() + 60000 });
    mockGetUserByEmail.mockResolvedValue({ uid: 'fb-uid-1', providerData: [{ providerId: 'password' }] });
    const res = await request(app).post('/user/change-email')
      .send({ currentEmail: 'old@a.com', newEmail: 'new@a.com', otp: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('new@a.com');
    expect(mockFbUpdateUser).toHaveBeenCalledWith('fb-uid-1', { email: 'new@a.com', emailVerified: true });
  });
});

describe('DELETE /user/delete-account', () => {
  test('missing email -> 400', async () => {
    const res = await request(app).delete('/user/delete-account').send({});
    expect(res.status).toBe(400);
  });

  test('a real account deletion also removes the Firebase Auth user', async () => {
    mockGetUserByEmail.mockResolvedValue({ uid: 'fb-uid-2' });
    const res = await request(app).delete('/user/delete-account').send({ email: 'gone@a.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockFbDeleteUser).toHaveBeenCalledWith('fb-uid-2');
  });

  test('no matching Firebase user -> still succeeds (best-effort)', async () => {
    mockGetUserByEmail.mockRejectedValue({ code: 'auth/user-not-found' });
    const res = await request(app).delete('/user/delete-account').send({ email: 'gone@a.com' });
    expect(res.status).toBe(200);
    expect(mockFbDeleteUser).not.toHaveBeenCalled();
  });
});
