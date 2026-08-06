// The actual logic behind POST /user/sync — called on every login.
// Upserts the Firebase-authenticated user into the Supabase users table
// (read-only lookup if name is omitted), resolves school_id, and returns
// the full profile.
//
// Moved out of routes/user.js (was mixed in with photo upload, OTP, billing,
// etc. in one 2,000+ line file). Behavior is unchanged from before the move.

//Here we import supabase and two helper functions(decrypt and getPreferences).
const supabase = require('./supabase');
const { decrypt } = require('../utils/encryption');
const { getPreferences } = require('./preferences');

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
    if (curriculum) patch.curriculum = curriculum;
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
        .select('id, name, email, role, grade, school, school_id, curriculum, location, phone, onboarding_complete, photo_url')
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
        if (!existingRow || !existingRow.role || existingRow.role === role) {
          patch.role = role;
        } else {
          console.warn(`[/user/sync] Ignored role change for ${patch.email}: existing="${existingRow.role}" incoming="${role}"`);
        }
      }

      ({ data, error } = await supabase
        .from('users')
        .upsert(patch, { onConflict: 'email' })
        .select('id, name, email, role, grade, school, school_id, curriculum, location, phone, onboarding_complete, photo_url')
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
      curriculum:         data.curriculum,
      location:           data.location,
      phone:              data.phone ? decrypt(data.phone) : null,
      // Trust the DB column directly. NULL means not complete (new/migrated accounts).
      onboardingComplete: data.onboarding_complete === true,
      photoUrl:           data.photo_url ?? null,
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

module.exports = { syncUserProfile };
