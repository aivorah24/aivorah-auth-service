// Tests for sendPasswordReset's REST-API fallback path — used when
// firebaseAdmin is NOT configured (no service account). Real outbound
// network calls (global fetch) are mocked so no real Firebase project
// is contacted.

jest.mock('../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

jest.mock('../services/mailer', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

// Firebase Admin is NOT available in this file's scenarios — forces the
// REST-API fallback branch in sendPasswordReset.
jest.mock('../services/firebaseAdmin', () => null);

const { sendPasswordResetEmail } = require('../services/mailer');
const { sendPasswordReset } = require('../services/auth-service');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

test('REST API returns an oobLink -> themed link emailed', async () => {
  global.fetch.mockResolvedValueOnce({
    json: async () => ({ oobLink: 'https://firebaseapp.com/action?oobCode=rest123' }),
  });

  const req = { body: { email: 'a@a.com' } };
  const res = mockRes();
  await sendPasswordReset(req, res);

  expect(sendPasswordResetEmail).toHaveBeenCalledWith(
    expect.objectContaining({ to: 'a@a.com', resetLink: expect.stringContaining('oobCode=rest123') })
  );
  expect(res.json).toHaveBeenCalledWith({ ok: true });
});

test('REST API says EMAIL_NOT_FOUND -> ok:true, no email sent (no user enumeration)', async () => {
  global.fetch.mockResolvedValueOnce({
    json: async () => ({ error: { message: 'EMAIL_NOT_FOUND' } }),
  });

  const req = { body: { email: 'nobody@a.com' } };
  const res = mockRes();
  await sendPasswordReset(req, res);

  expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ ok: true });
});

test('REST API has no oobLink and no error -> falls back to Firebase default sender', async () => {
  global.fetch
    .mockResolvedValueOnce({ json: async () => ({}) })   // first call: returnOobLink attempt, nothing usable
    .mockResolvedValueOnce({ json: async () => ({}) });  // second call: plain sendOobCode fallback

  const req = { body: { email: 'a@a.com' } };
  const res = mockRes();
  await sendPasswordReset(req, res);

  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ ok: true, note: 'firebase_fallback' });
});
