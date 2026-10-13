// Unit tests for services/auth-service.js — the core login/signup logic
// (syncUserProfile, getUserRole, verifyEmailToken, checkVerified).
// Supabase is mocked so these run with no real DB / network.

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
  sendPasswordResetEmail: jest.fn(),
}));

jest.mock('../utils/encryption', () => ({
  decrypt: jest.fn((v) => v),
}));

const supabase = require('../services/supabase');
const { getPreferences } = require('../services/preferences');
const { sendVerificationEmail } = require('../services/mailer');
const {
  syncUserProfile,
  getUserRole,
  sendVerification,
  verifyEmailToken,
  checkVerified,
} = require('../services/auth-service');

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('syncUserProfile', () => {
  test('missing email returns 400', async () => {
    const req = { body: {} };
    const res = mockRes();
    await syncUserProfile(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'email required' });
  });

  test('login (no name) reads the profile, never upserts the users row', async () => {
    // role is deliberately non-student here so the student_stats side-effect
    // upsert (a real, separate behavior) doesn't interfere with this assertion.
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: '1', email: 'a@a.com', role: 'teacher', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['teacher'], isPro: false });

    const req = { body: { email: 'a@a.com' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(supabase._chain.upsert).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@a.com', onboardingComplete: true })
    );
  });

  // Regression test for the "Gender/DOB/State missing on re-login" bug
  // (2026-08-26): dob/gender/state/country are now real `users` columns
  // (selected above alongside grade/curriculum/school) and must round-trip
  // through this response the same way those fields already do — no
  // separate/fallible call needed to get them.
  test('login returns the real dob/gender/state/country columns from users', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: {
        id: '1', email: 'a@a.com', role: 'teacher', onboarding_complete: true,
        dob: '15/06/1990', gender: 'Female', state: 'Karnataka', country: 'India',
      },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['teacher'], isPro: false });

    const req = { body: { email: 'a@a.com' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ dob: '15/06/1990', gender: 'Female', state: 'Karnataka', country: 'India' })
    );
  });

  test('login for a user with no dob/gender/state/country yet returns null, not undefined/crash', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: '1', email: 'a@a.com', role: 'teacher', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['teacher'], isPro: false });

    const req = { body: { email: 'a@a.com' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ dob: null, gender: null, state: null, country: null })
    );
  });

  test('login for a student also upserts student_stats (auto-create side effect)', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: '1', email: 'a@a.com', role: 'student', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['student'], isPro: false });

    const req = { body: { email: 'a@a.com' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      { student_id: '1' },
      { onConflict: 'student_id', ignoreDuplicates: true }
    );
  });

  test('login with a school name and no school_id yet -> resolves and saves school_id', async () => {
    // Call order inside syncUserProfile when patch.school is set:
    // 1. users.select('school_id') -> no school_id yet
    // 2. schools.select('id').ilike(name) -> match found
    // 3. existingRow lookup (role logic)
    // 4. stale-prefs lookup after upsert
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { school_id: null }, error: null })      // 1. no school_id yet
      .mockResolvedValueOnce({ data: { id: 'school-42' }, error: null })      // 2. school matched
      .mockResolvedValueOnce({ data: { id: '5', role: 'student' }, error: null }); // 3. existingRow lookup (truthy, so no stale-prefs call)
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '5', email: 'a@a.com', role: 'student', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['student'] });

    const req = { body: { name: 'A', email: 'a@a.com', school: 'Hyderabad International School' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ school_id: 'school-42' }),
      { onConflict: 'email' }
    );
  });

  test('login with a school name that matches no real school -> school_id left unset', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { school_id: null }, error: null }) // 1. no school_id yet
      .mockResolvedValueOnce({ data: null, error: null })                 // 2. no matching school
      .mockResolvedValueOnce({ data: { id: '5', role: 'student' }, error: null }); // 3. existingRow lookup (truthy, so no stale-prefs call)
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '5', email: 'a@a.com', role: 'student', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['student'] });

    const req = { body: { name: 'A', email: 'a@a.com', school: 'Some Made Up School' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    const upsertPatch = supabase._chain.upsert.mock.calls[0][0];
    expect(upsertPatch.school_id).toBeUndefined();
  });

  test('login when the user already has a school_id -> resolution is skipped (never reassigned)', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { school_id: 'existing-school-1' }, error: null }) // 1. already has one
      .mockResolvedValueOnce({ data: { id: '5', role: 'student' }, error: null });      // 2. existingRow lookup (schools lookup skipped, existingRow truthy so no stale-prefs call either)
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '5', email: 'a@a.com', role: 'student', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['student'] });

    const req = { body: { name: 'A', email: 'a@a.com', school: 'Hyderabad International School' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    // Only 2 maybeSingle calls used by the school block + existingRow (not 3) —
    // proves the schools table lookup (step 2 in the other tests) never ran.
    const upsertPatch = supabase._chain.upsert.mock.calls[0][0];
    expect(upsertPatch.school_id).toBeUndefined();
  });

  test('fresh signup reusing a previously-deleted email resets stale "active" verification state', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // 1. existingRow lookup -> none (fresh signup)
      .mockResolvedValueOnce({ // 2. stale-prefs check -> leftover row says active from the deleted account
        data: { data: { accountStatus: 'active', verifyToken: null, verifyTokenExpiry: null } },
        error: null,
      });
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '9', email: 're-signup@a.com', role: 'student', onboarding_complete: null },
      error: null,
    });
    getPreferences.mockResolvedValueOnce(null);

    const req = { body: { name: 'Re Signup', email: 're-signup@a.com', role: 'student' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(supabase._chain.update).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountStatus: 'pending_verification', verifyToken: null, verifyTokenExpiry: null }),
    });
  });

  test('fresh signup with NO stale prefs row -> no reset attempted', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // existingRow lookup -> none
      .mockResolvedValueOnce({ data: null, error: null }); // stale-prefs check -> nothing there either
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '10', email: 'new2@a.com', role: 'student', onboarding_complete: null },
      error: null,
    });
    getPreferences.mockResolvedValueOnce(null);

    const req = { body: { name: 'New', email: 'new2@a.com', role: 'student' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(supabase._chain.update).not.toHaveBeenCalled();
  });

  test('login with no existing row returns onboardingComplete:false, no error', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const req = { body: { email: 'new@a.com' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(res.json).toHaveBeenCalledWith({ email: 'new@a.com', onboardingComplete: false });
  });

  test('fresh signup (name provided, no existing row) sets role from request', async () => {
    // 1st maybeSingle: existingRow lookup (school skipped, no school field) -> none
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // existingRow lookup
      .mockResolvedValueOnce({ data: null, error: null }); // stale-prefs lookup after insert
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '2', email: 'new@a.com', role: 'student', onboarding_complete: null },
      error: null,
    });
    getPreferences.mockResolvedValueOnce(null);

    const req = { body: { name: 'New Kid', email: 'new@a.com', role: 'student' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'student', name: 'New Kid' }),
      { onConflict: 'email' }
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingComplete: false })
    );
  });

  test('signup with curriculum "NCERT" stores CBSE', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '3', email: 'c@a.com', role: 'student', curriculum: 'CBSE' }, error: null,
    });
    getPreferences.mockResolvedValueOnce(null);

    const res = mockRes();
    await syncUserProfile({ body: { name: 'C', email: 'c@a.com', role: 'student', curriculum: ' ncert ' } }, res);

    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ curriculum: 'CBSE' }), { onConflict: 'email' }
    );
  });

  test('login for a legacy "NCERT" user returns CBSE', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: '1', email: 'a@a.com', role: 'teacher', curriculum: 'NCERT', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce(null);

    const res = mockRes();
    await syncUserProfile({ body: { email: 'a@a.com' } }, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ curriculum: 'CBSE' }));
  });

  test('existing user with a different role is NOT switched to the incoming role', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: '3', role: 'teacher' }, error: null }); // existingRow lookup
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '3', email: 'x@a.com', role: 'teacher', onboarding_complete: true },
      error: null,
    });
    getPreferences.mockResolvedValueOnce({ roles: ['teacher'] });

    const req = { body: { name: 'X', email: 'x@a.com', role: 'parent' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    const upsertPatch = supabase._chain.upsert.mock.calls[0][0];
    expect(upsertPatch.role).toBeUndefined();
  });

  test('Supabase error on upsert returns 500', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null }); // existingRow lookup
    supabase._chain.single.mockResolvedValueOnce({ data: null, error: { message: 'db down' } });

    const req = { body: { name: 'X', email: 'x@a.com' } };
    const res = mockRes();
    await syncUserProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'db down' });
  });
});

describe('getUserRole', () => {
  test('missing email returns 400', async () => {
    const req = { query: {} };
    const res = mockRes();
    await getUserRole(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('unknown email returns 404', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const req = { query: { email: 'nobody@a.com' } };
    const res = mockRes();
    await getUserRole(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('known email returns its role', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { role: 'parent' }, error: null });
    const req = { query: { email: 'p@a.com' } };
    const res = mockRes();
    await getUserRole(req, res);
    expect(res.json).toHaveBeenCalledWith({ role: 'parent' });
  });
});

describe('sendVerification', () => {
  test('missing email or name -> 400', async () => {
    const req = { body: { email: 'a@a.com' } }; // name missing
    const res = mockRes();
    await sendVerification(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('new / not-yet-verified account -> generates a token, saves it, sends the real verification email', async () => {
    // 1st maybeSingle: existing user_preferences lookup (none yet)
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const req = {
      body: { email: 'a@a.com', name: 'A Student' },
      protocol: 'https',
      get: jest.fn().mockReturnValue('auth.aivorah.ai'),
    };
    const res = mockRes();
    await sendVerification(req, res);

    // 1. Token saved to user_preferences with pending_verification status
    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_email: 'a@a.com',
        data: expect.objectContaining({
          accountStatus: 'pending_verification',
          verifyToken: expect.any(String),
        }),
      }),
      { onConflict: 'user_email' }
    );

    // 2. A short link row is created pointing at the full verify URL
    expect(supabase._chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: expect.any(String),
        url: expect.stringContaining('/user/verify/'),
      })
    );

    // 3. The actual email-sending function is called with a working short verify link
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@a.com',
        name: 'A Student',
        verifyUrl: expect.stringMatching(/^https:\/\/auth\.aivorah\.ai\/v\/[a-f0-9]{10}$/),
      })
    );

    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

describe('verifyEmailToken', () => {
  test('no email param redirects to error', async () => {
    const req = { params: { token: 'tok' }, query: {} };
    const res = mockRes();
    await verifyEmailToken(req, res);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error=1'));
  });

  test('mismatched token on a not-yet-active account redirects to error', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { data: { verifyToken: 'real-token', accountStatus: 'pending_verification' } },
      error: null,
    });
    const req = { params: { token: 'wrong-token' }, query: { email: 'a@a.com' } };
    const res = mockRes();
    await verifyEmailToken(req, res);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error=1'));
  });

  test('mismatched token but account already active redirects to success (pre-fetch case)', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { data: { verifyToken: null, accountStatus: 'active' } },
      error: null,
    });
    const req = { params: { token: 'stale-token' }, query: { email: 'a@a.com' } };
    const res = mockRes();
    await verifyEmailToken(req, res);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('verified=1'));
  });

  test('expired token redirects to error', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { data: { verifyToken: 'tok', verifyTokenExpiry: Date.now() - 1000, accountStatus: 'pending_verification' } },
      error: null,
    });
    const req = { params: { token: 'tok' }, query: { email: 'a@a.com' } };
    const res = mockRes();
    await verifyEmailToken(req, res);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error=1'));
  });

  test('valid, unexpired token marks active and redirects to success', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { data: { verifyToken: 'tok', verifyTokenExpiry: Date.now() + 100000, accountStatus: 'pending_verification' } },
      error: null,
    });
    const req = { params: { token: 'tok' }, query: { email: 'a@a.com' } };
    const res = mockRes();
    await verifyEmailToken(req, res);
    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_email: 'a@a.com', data: expect.objectContaining({ accountStatus: 'active' }) }),
      { onConflict: 'user_email' }
    );
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('verified=1'));
  });
});

describe('checkVerified', () => {
  test('missing email returns 400', async () => {
    const req = { query: {} };
    const res = mockRes();
    await checkVerified(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('no preferences row returns verified:false, accountStatus:null', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const req = { query: { email: 'a@a.com' } };
    const res = mockRes();
    await checkVerified(req, res);
    expect(res.json).toHaveBeenCalledWith({ verified: false, accountStatus: null });
  });

  test('active account returns verified:true', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { data: { accountStatus: 'active' } }, error: null });
    const req = { query: { email: 'a@a.com' } };
    const res = mockRes();
    await checkVerified(req, res);
    expect(res.json).toHaveBeenCalledWith({ verified: true, accountStatus: 'active' });
  });
});
