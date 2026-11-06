// The login + signup + password-reset logic: syncUserProfile (called on
// every login and signup), getUserRole/sendVerification/verifyEmailToken
// (signup + email verification), sendPasswordReset (forgot password).
// Grouped in one file because they're the same domain - "who is this user,
// are they who they claim, let them back in" - not because they're the
// same endpoint.
//
// Moved out of routes/user.js (was mixed in with photo upload, OTP, billing,
// etc. in one 2,000+ line file). Behavior is unchanged from before the move.

const crypto = require('crypto');
const supabase = require('./supabase');
const firebaseAdmin = require('./firebaseAdmin');
const { decrypt } = require('../utils/encryption');
const { getPreferences } = require('./preferences');
const { normalizeCurriculum } = require('../utils/curriculum');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./mailer');

// Admin roles are provisioned by the admin services, never self-assigned here.
const SELF_SIGNUP_ROLES = new Set(['student', 'teacher', 'parent']);

async function syncUserProfile(req, res) {
  try {
    const { name, email, role, grade, school, curriculum, location } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Build upsert patch — only include fields that are provided
    // IMPORTANT: only set name if explicitly provided; never fall back to email prefix
    // (fetchSupabaseProfile calls this with only email, and we must not overwrite a real name)
    const patch = { email: email.toLowerCase().trim(), last_active_at: new Date().toISOString() };
    if (name)       patch.name       = name;
    if (grade)      patch.grade      = grade;
    if (school)     patch.school     = school?.trim();
    if (curriculum) patch.curriculum = normalizeCurriculum(curriculum);
    if (location)   patch.location   = location;

    // Resolve the free-text school to a schools row so new users don't pile up
    // with school_id = null (the V1 tenant boundary is users.school_id).
    // MATCH-ONLY: never auto-create a school from arbitrary signup text — the
    // schools table already has near-duplicate noise, and only a case-insensitive
    // exact match (guaranteed unique by schools_name_lower_idx) is unambiguous.
    // No match → school_id stays untouched (null for new users).
    //
    // ONE-TIME FILL ONLY — never overwrite an existing school_id. `/user/sync`
    // runs on every login, and the client's `school` fallback (AuthContext:
    // `profile.school || 'Hyderabad International School'`) fires whenever the
    // DB's free-text `school` column happens to be empty — including for
    // school_admin accounts whose real tenant boundary is school_id, not that
    // legacy text field. Re-resolving on every login would silently reassign a
    // school_admin's scope to whatever that fallback string matches. Only fill
    // school_id when the row doesn't have one yet.
    if (patch.school) {
      try {
        const { data: existing } = await supabase
          .from('users').select('school_id').eq('email', patch.email).maybeSingle();
        if (!existing?.school_id) {
          const { data: schoolRow } = await supabase
            .from('schools').select('id')
            .ilike('name', patch.school)
            .maybeSingle();
          if (schoolRow) patch.school_id = schoolRow.id;
        }
      } catch (e) {
        console.warn('[/user/sync] school_id resolution skipped:', e.message);
      }
    }

    // If name is not provided, do a SELECT only — don't upsert
    // Upserting without name would fail the NOT NULL constraint on the name column
    const isReadOnly = !patch.name;

    let data, error;
    if (isReadOnly) {
      ({ data, error } = await supabase
        .from('users')
        .select('id, name, email, role, grade, school, school_id, curriculum, location, phone, onboarding_complete, photo_url, dob, gender, state, country, status')
        .eq('email', patch.email)
        .maybeSingle());
    } else {
      // Detect whether this upsert CREATES the row (fresh signup for this email)
      const { data: existingRow } = await supabase
        .from('users').select('id, role').eq('email', patch.email).maybeSingle();

      // Only set role on first signup (no existing row / no role yet) or when it
      // matches the existing role. This endpoint runs on EVERY login — blindly
      // writing whatever role the client happened to send silently flipped real
      // teacher/parent accounts to the wrong role whenever any call passed a
      // different one (e.g. opening a differently-roled screen with the same
      // login). An intentional role change goes through /user/add-role instead.
      if (role) {
        const isNewRole = !existingRow || !existingRow.role;
        if (isNewRole && !SELF_SIGNUP_ROLES.has(role)) {
          console.warn(`[/user/sync] Refused self-signup role "${role}" for ${patch.email}`);
        } else if (isNewRole || existingRow.role === role) {
          patch.role = role;
        } else {
          console.warn(`[/user/sync] Ignored role change for ${patch.email}: existing="${existingRow.role}" incoming="${role}"`);
        }
      }

      ({ data, error } = await supabase
        .from('users')
        .upsert(patch, { onConflict: 'email' })
        .select('id, name, email, role, grade, school, school_id, curriculum, location, phone, onboarding_complete, photo_url, dob, gender, state, country, status')
        .single());

      // Fresh signup + leftover user_preferences from a previously DELETED account:
      // its accountStatus 'active' makes the app treat the new signup as already
      // verified and silently skip "Check your inbox" (founder-reported). Reset the
      // verification state so every re-registered email verifies like a new user.
      if (!existingRow && !error) {
        const { data: pref } = await supabase
          .from('user_preferences').select('data').eq('user_email', patch.email).maybeSingle();
        if (pref?.data?.accountStatus === 'active') {
          await supabase.from('user_preferences').update({
            data: { ...pref.data, accountStatus: 'pending_verification', verifyToken: null, verifyTokenExpiry: null },
          }).eq('user_email', patch.email);
          console.log('[/user/sync] reset stale verified state for re-registered email:', patch.email);
        }
      }
    }

    if (error) {
      console.error('[/user/sync] Supabase error:', JSON.stringify(error));
      console.error('[/user/sync] patch was:', JSON.stringify(patch));
      return res.status(500).json({ error: error.message });
    }

    // No row yet — user hasn't completed signup flow
    if (!data) return res.json({ email: patch.email, onboardingComplete: false });

    // Auto-create student_stats if role is student
    if ((role === 'student' || data?.role === 'student') && data?.id) {
      await supabase.from('student_stats')
        .upsert({ student_id: data.id }, { onConflict: 'student_id', ignoreDuplicates: true });
    }

    // Pull roles + isPro from user_preferences (stored there since users table has no roles/isPro column)
    const prefs = await getPreferences(data.email);
    const rolesFromPrefs = Array.isArray(prefs?.roles) ? prefs.roles : null;

    res.json({
      id:                 data.id,
      name:               data.name,
      email:              data.email,
      role:               data.role,
      roles:              rolesFromPrefs || [data.role].filter(Boolean),
      grade:              data.grade,
      school:             data.school,
      // Authoritative B2B tenant boundary: a real school-org FK. NULL = B2C /
      // independent self-signup (no official school link). The client uses this
      // to hide school-only features (My Classes, Attendance) for B2C users.
      schoolId:           data.school_id ?? null,
      // users.status: 'active' | 'inactive' | 'archived'. A student archived by
      // their school keeps school_id; the client uses this to offer Connect to
      // School so they can join a new one.
      status:             data.status ?? 'active',
      curriculum:         normalizeCurriculum(data.curriculum),
      location:           data.location,
      phone:              data.phone ? decrypt(data.phone) : null,
      // Trust the DB column directly. NULL means not complete (new/migrated accounts).
      onboardingComplete: data.onboarding_complete === true,
      photoUrl:           data.photo_url ?? null,
      // dob/gender/state/country: added 2026-08-26, now real `users` columns
      // (see aivorah-profile-service) instead of living only in
      // user_preferences — that split was the root cause of a bug where
      // these 3 fields silently vanished on next login whenever the
      // separate GET /user/preferences call failed, while everything
      // selected from `users` here never did.
      dob:                data.dob ?? null,
      gender:             data.gender ?? null,
      state:              data.state ?? null,
      country:            data.country ?? null,
      isPro:              prefs?.isPro === true,
      // For auto-generated @aivorah.student accounts: default to true (must change) unless
      // explicitly cleared (false) after the student has changed their password.
      // For all other accounts: only true if explicitly set.
      mustChangePassword: (data.email || '').endsWith('@aivorah.student')
        ? prefs?.mustChangePassword !== false
        : prefs?.mustChangePassword === true,
      // BUG FIX (2026-07-21): this was never included even though `prefs` was
      // already fetched above — the Google SSO client-side check
      // (`profile.accountStatus === 'active'`) could therefore never see a
      // true "already verified" state, so every single Google login resent
      // the verification email instead of only the first one.
      accountStatus:      prefs?.accountStatus ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /user/role — used on signup to show a helpful "already registered as
// X" error, and to detect the teacher->parent dual-role case.
async function getUserRole(req, res) {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  const { data, error } = await supabase.from('users').select('role').eq('email', email).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'User not found' });
  res.json({ role: data.role });
}

// POST /user/send-verification — generates a branded verification email
// from aivorah24@gmail.com (not Firebase's own spam-flagged one).
async function sendVerification(req, res) {
  try {
    const { email, name, frontendOrigin } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'email and name required' });

    // Store token in user_preferences.data
    const { data: existing } = await supabase
      .from('user_preferences')
      .select('data')
      .eq('user_email', email.toLowerCase())
      .maybeSingle();

    const currentData = existing?.data || {};

    // Idempotency guard (regression fix, 2026-07-20): an already-active account
    // must never be resent a verification email or downgraded back to
    // pending_verification. Without this, any caller that races ahead of a
    // fresh accountStatus read (e.g. the client re-checking on every SSO
    // login) silently re-parks a verified user in "pending" state.
    if (currentData.accountStatus === 'active') {
      return res.json({ ok: true, alreadyVerified: true });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

    await supabase.from('user_preferences').upsert({
      user_email: email.toLowerCase(),
      data: { ...currentData, verifyToken: token, verifyTokenExpiry: expiry, accountStatus: 'pending_verification' },
    }, { onConflict: 'user_email' });

    const serverBase = `${req.protocol}://${req.get('host')}`;
    const appBase = frontendOrigin || 'https://aivorah.ai';
    const redirect = encodeURIComponent(appBase + '/verify-success');
    const encodedEmail = encodeURIComponent(email.toLowerCase());
    const fullVerifyUrl = `${serverBase}/user/verify/${token}?email=${encodedEmail}&redirect=${redirect}`;

    // Generate a short code and store the full URL so we can send a clean /v/:code link
    const shortCode = crypto.randomBytes(5).toString('hex'); // 10-char hex
    const expiresAt = new Date(expiry).toISOString();
    await supabase.from('short_links').insert({ code: shortCode, url: fullVerifyUrl, expires_at: expiresAt });
    const verifyUrl = `${serverBase}/v/${shortCode}`;

    await sendVerificationEmail({ to: email, name, verifyUrl });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /user/verify/:token — called when the user clicks the verification
// link in the email. Validates the token, marks the account active, then
// redirects to the frontend.
async function verifyEmailToken(req, res) {
  const { token } = req.params;
  const email = (req.query.email || '').toLowerCase();
  const appRedirect = req.query.redirect || 'https://aivorah.ai/verify-success';

  // Always redirect back to the app — pass ?verified=1 or ?error=1 so app can react
  const successUrl = appRedirect.includes('?') ? `${appRedirect}&verified=1` : `${appRedirect}?verified=1`;
  const errorUrl   = appRedirect.includes('?') ? `${appRedirect}&error=1`    : `${appRedirect}?error=1`;

  try {
    if (!email) {
      console.warn('[verify] no email param');
      return res.redirect(errorUrl);
    }

    // Look up by email (primary key) — no JSONB scanning
    const { data: pref, error: fetchErr } = await supabase
      .from('user_preferences')
      .select('data')
      .eq('user_email', email)
      .maybeSingle();

    console.log('[verify]', email, '| token match:', pref?.data?.verifyToken === token, '| fetchErr:', fetchErr?.message);

    if (fetchErr || !pref) {
      return res.redirect(errorUrl);
    }

    // Token already consumed (cleared after first verification) — this happens
    // when an email client (e.g. Apple Mail Privacy Protection, Outlook Safe
    // Links) pre-fetches the link before the user taps it, which verifies the
    // account on the first hit. If the account is already active, treat any
    // later hit on the same link as a success too, not an error.
    if (pref.data?.verifyToken !== token) {
      if (pref.data?.accountStatus === 'active') {
        return res.redirect(successUrl);
      }
      return res.redirect(errorUrl);
    }

    const meta = pref.data || {};
    if (meta.verifyTokenExpiry && Date.now() > meta.verifyTokenExpiry) {
      return res.redirect(errorUrl);
    }

    // Mark verified — clear token, set active
    await supabase.from('user_preferences').upsert({
      user_email: email,
      data: { ...meta, accountStatus: 'active', verifyToken: null, verifyTokenExpiry: null },
    }, { onConflict: 'user_email' });

    console.log('[verify] ✅ verified:', email);
    res.redirect(successUrl);
  } catch (err) {
    console.error('[verify] unexpected error:', err);
    res.redirect(errorUrl);
  }
}

// POST /user/send-password-reset — generates a Firebase password-reset link
// and sends it from aivorah24@gmail.com. For @aivorah.student synthetic
// accounts (no real inbox), delivers to the linked parent's email instead.
async function sendPasswordReset(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const emailLc = email.trim().toLowerCase();

    const { frontendOrigin } = req.body;
    const appBase = frontendOrigin || 'https://aivorah.ai';
    let resetLink = null;

    // Synthetic student logins (@aivorah.student) have no real inbox — the
    // Firebase credential lives on that email, but the reset email must be
    // delivered to the parent's real address.
    let deliverTo = emailLc;
    let childName = null;
    if (emailLc.endsWith('@aivorah.student')) {
      const { data: childUser } = await supabase
        .from('users').select('id, name').eq('email', emailLc).maybeSingle();
      if (childUser?.id) {
        const { data: link } = await supabase
          .from('parent_children').select('parent_email').eq('child_id', childUser.id).maybeSingle();
        if (link?.parent_email) {
          deliverTo = link.parent_email.toLowerCase();
          childName = childUser.name || 'your child';
        }
      }
      if (deliverTo === emailLc) {
        // No parent on file — nothing deliverable; don't leak existence.
        console.warn('[send-password-reset] student account with no parent email:', emailLc);
        return res.json({ ok: true, note: 'no_recipient' });
      }
    }

    // 1. Try Firebase Admin SDK if service account is available
    if (firebaseAdmin) {
      try {
        const actionCodeSettings = {
          url: `${appBase}/reset-password`,
          handleCodeInApp: false, // link opens in browser, not app
        };
        resetLink = await firebaseAdmin.auth().generatePasswordResetLink(emailLc, actionCodeSettings);
      } catch (adminErr) {
        if (adminErr.code === 'auth/user-not-found') return res.json({ ok: true });
        console.warn('[send-password-reset] admin err:', adminErr.message);
      }
    }

    // 2. Try Firebase REST API with returnOobLink (requires admin; may not work without service account)
    if (!resetLink) {
      const fbRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${process.env.FIREBASE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: emailLc, returnOobLink: true }),
        }
      );
      const fbData = await fbRes.json();
      if (fbData.oobLink) {
        resetLink = fbData.oobLink;
      } else if (fbData.error?.message === 'EMAIL_NOT_FOUND') {
        return res.json({ ok: true }); // don't expose user enumeration
      } else {
        // returnOobLink not available without admin — fall back to Firebase sending its own email
        console.warn('[send-password-reset] returnOobLink not available, using Firebase default sender');
        await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${process.env.FIREBASE_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: emailLc }),
          }
        );
        return res.json({ ok: true, note: 'firebase_fallback' });
      }
    }

    // Point the link at OUR themed /reset-password page instead of Firebase's
    // generic firebaseapp.com action page. Firebase's link carries the oobCode
    // as a query param — extract it and rebuild against the Aivorah frontend.
    let themedLink = resetLink;
    try {
      const oob = new URL(resetLink).searchParams.get('oobCode');
      if (oob) themedLink = `${appBase}/reset-password?oobCode=${encodeURIComponent(oob)}`;
    } catch (_) { /* keep original link if parsing fails */ }

    // 3. Send branded email from aivorah24@gmail.com (to parent for student accounts)
    await sendPasswordResetEmail({ to: deliverTo, resetLink: themedLink, childName });
    res.json({ ok: true });
  } catch (err) {
    console.error('[send-password-reset]', err.message);
    res.status(500).json({ error: err.message });
  }
}

// GET /user/check-verified — returns accountStatus for an email, polled by
// VerifyEmailScreen every 2s to detect when verification completes.
async function checkVerified(req, res) {
  try {
    const email = (req.query.email || '').toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });

    const { data: pref } = await supabase
      .from('user_preferences')
      .select('data')
      .eq('user_email', email)
      .maybeSingle();

    const accountStatus = pref?.data?.accountStatus || null;
    res.json({ verified: accountStatus === 'active', accountStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { syncUserProfile, getUserRole, sendVerification, verifyEmailToken, sendPasswordReset, checkVerified };
