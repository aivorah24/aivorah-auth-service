// Tests for sendPasswordReset — the "Firebase Admin SDK available" path,
// plus the synthetic @aivorah.student account routing (reset email goes to
// the linked parent, since student accounts have no real inbox).

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

// Firebase Admin IS available in this file's scenarios.
const mockGeneratePasswordResetLink = jest.fn();
jest.mock('../services/firebaseAdmin', () => ({
  auth: () => ({ generatePasswordResetLink: (...args) => mockGeneratePasswordResetLink(...args) }),
}));

const supabase = require('../services/supabase');
const { sendPasswordResetEmail } = require('../services/mailer');
const { sendPasswordReset } = require('../services/auth-service');

function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('missing email -> 400', async () => {
  const req = { body: {} };
  const res = mockRes();
  await sendPasswordReset(req, res);
  expect(res.status).toHaveBeenCalledWith(400);
});

test('regular account: Firebase Admin succeeds -> themed link emailed to that address', async () => {
  mockGeneratePasswordResetLink.mockResolvedValueOnce('https://firebaseapp.com/action?oobCode=abc123');

  const req = { body: { email: 'a@a.com' } };
  const res = mockRes();
  await sendPasswordReset(req, res);

  expect(mockGeneratePasswordResetLink).toHaveBeenCalledWith('a@a.com', expect.any(Object));
  expect(sendPasswordResetEmail).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'a@a.com',
      resetLink: expect.stringContaining('oobCode=abc123'),
      childName: null,
    })
  );
  expect(res.json).toHaveBeenCalledWith({ ok: true });
});

test('Firebase Admin says user-not-found -> ok:true, no email sent (no user enumeration)', async () => {
  mockGeneratePasswordResetLink.mockRejectedValueOnce({ code: 'auth/user-not-found', message: 'no user' });

  const req = { body: { email: 'nobody@a.com' } };
  const res = mockRes();
  await sendPasswordReset(req, res);

  expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ ok: true });
});

test('synthetic student account with a linked parent -> reset email goes to the parent', async () => {
  supabase._chain.maybeSingle
    .mockResolvedValueOnce({ data: { id: 'child-1', name: 'Kid' }, error: null })          // users lookup
    .mockResolvedValueOnce({ data: { parent_email: 'parent@a.com' }, error: null });        // parent_children lookup
  mockGeneratePasswordResetLink.mockResolvedValueOnce('https://firebaseapp.com/action?oobCode=xyz');

  const req = { body: { email: 'kid@aivorah.student' } };
  const res = mockRes();
  await sendPasswordReset(req, res);

  expect(mockGeneratePasswordResetLink).toHaveBeenCalledWith('kid@aivorah.student', expect.any(Object));
  expect(sendPasswordResetEmail).toHaveBeenCalledWith(
    expect.objectContaining({ to: 'parent@a.com', childName: 'Kid' })
  );
  expect(res.json).toHaveBeenCalledWith({ ok: true });
});

test('synthetic student account with NO linked parent -> no email sent, ok:true with note', async () => {
  supabase._chain.maybeSingle
    .mockResolvedValueOnce({ data: { id: 'child-2', name: 'Kid2' }, error: null }) // users lookup
    .mockResolvedValueOnce({ data: null, error: null });                           // no parent link found

  const req = { body: { email: 'kid2@aivorah.student' } };
  const res = mockRes();
  await sendPasswordReset(req, res);

  expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  expect(mockGeneratePasswordResetLink).not.toHaveBeenCalled();
  expect(res.json).toHaveBeenCalledWith({ ok: true, note: 'no_recipient' });
});
