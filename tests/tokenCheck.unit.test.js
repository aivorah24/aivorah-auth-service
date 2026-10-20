const mockVerifyIdToken = jest.fn();
jest.mock('../services/firebaseAdmin', () => ({ auth: () => ({ verifyIdToken: (...a) => mockVerifyIdToken(...a) }) }));

const { requireSelf } = require('../middleware/tokenCheck');

function run(headers, body) {
  const req = { headers, body, method: 'POST', originalUrl: '/user/sync' };
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  return requireSelf((r) => r.body.email)(req, res, next).then(() => ({ req, res, next }));
}

beforeEach(() => {
  mockVerifyIdToken.mockReset();
  mockVerifyIdToken.mockImplementation(async (t) => ({ email: t }));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { delete process.env.AUTH_ENFORCE; });

test('monitor mode: no token still passes', async () => {
  const { next, res } = await run({}, { email: 'a@x.com' });
  expect(next).toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});

test('monitor mode: email mismatch still passes', async () => {
  const { next } = await run({ authorization: 'Bearer me@x.com' }, { email: 'other@x.com' });
  expect(next).toHaveBeenCalled();
});

test('enforce mode: no token -> 401', async () => {
  process.env.AUTH_ENFORCE = 'enforce';
  const { next, res } = await run({}, { email: 'a@x.com' });
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
});

test('enforce mode: email mismatch -> 403', async () => {
  process.env.AUTH_ENFORCE = 'enforce';
  const { next, res } = await run({ authorization: 'Bearer me@x.com' }, { email: 'other@x.com' });
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
});

test('enforce mode: own email (any case) passes', async () => {
  process.env.AUTH_ENFORCE = 'enforce';
  const { next, req } = await run({ authorization: 'Bearer me@x.com' }, { email: 'Me@X.com ' });
  expect(next).toHaveBeenCalled();
  expect(req.authEmail).toBe('me@x.com');
});

test('enforce mode: invalid token -> 401', async () => {
  process.env.AUTH_ENFORCE = 'enforce';
  mockVerifyIdToken.mockRejectedValueOnce(new Error('bad'));
  const { res } = await run({ authorization: 'Bearer junk' }, { email: 'a@x.com' });
  expect(res.status).toHaveBeenCalledWith(401);
});
