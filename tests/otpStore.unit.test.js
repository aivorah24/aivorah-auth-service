// Unit tests for services/otpStore.js — ported verbatim from
// ai-mentor/server/services/otpStore.js (2026-08-27). Exercises the real
// module against a mocked Supabase client, including the in-memory fallback
// path for when the `otp_codes` table doesn't exist.
const mockUpsert = jest.fn();
const mockMaybeSingle = jest.fn();
const mockDeleteEq2 = jest.fn();

jest.mock('../services/supabase', () => ({
  from: jest.fn(() => ({
    upsert: (...args) => mockUpsert(...args),
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
    delete: () => ({ eq: () => ({ eq: (...args) => mockDeleteEq2(...args) }) }),
  })),
}));

const otpStore = require('../services/otpStore');

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue({ error: null });
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockDeleteEq2.mockResolvedValue({ error: null });
});

describe('otpStore — table-backed path', () => {
  test('setOtp upserts a real row keyed by email+purpose', async () => {
    await otpStore.setOtp('a@a.com', 'email_verify', { otp: '123456' });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@a.com', purpose: 'email_verify', otp: '123456' }),
      { onConflict: 'email,purpose' },
    );
  });

  test('getOtp with no real stored row returns null', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await otpStore.getOtp('a@a.com', 'email_verify')).toBeNull();
  });

  test('getOtp with a real stored row returns the parsed otp/expiresAt', async () => {
    const expires = new Date(Date.now() + 60000).toISOString();
    mockMaybeSingle.mockResolvedValue({ data: { otp: '654321', recovery_email: null, expires_at: expires }, error: null });
    const result = await otpStore.getOtp('a@a.com', 'email_verify');
    expect(result.otp).toBe('654321');
    expect(result.expiresAt).toBe(new Date(expires).getTime());
  });

  test('deleteOtp issues a real delete scoped to email+purpose', async () => {
    await otpStore.deleteOtp('a@a.com', 'email_verify');
    expect(mockDeleteEq2).toHaveBeenCalledWith('purpose', 'email_verify');
  });
});

describe('otpStore — in-memory fallback when the table is missing', () => {
  test('setOtp then getOtp round-trips through memory when the table 42P01s', async () => {
    mockUpsert.mockResolvedValue({ error: { code: '42P01', message: 'relation "otp_codes" does not exist' } });
    await otpStore.setOtp('fallback@a.com', 'email_verify', { otp: '111111' });

    const result = await otpStore.getOtp('fallback@a.com', 'email_verify');
    expect(result.otp).toBe('111111');
  });
});
