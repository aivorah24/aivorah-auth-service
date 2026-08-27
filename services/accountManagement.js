// Email-OTP verify/change-email/delete-account — ported from the monolith
// (ai-mentor/server/routes/user.js) 2026-08-27. Grouped here (separate from
// auth-service.js's login/signup/verification domain) because these are all
// account-identity MUTATIONS a signed-in user makes to their own account,
// not the sign-in flow itself.
const supabase = require('./supabase');
const firebaseAdmin = require('./firebaseAdmin');
const otpStore = require('./otpStore');
const { sendEmailOtpCode } = require('./mailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendEmailOtp(req, res) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = req.body?.name ? String(req.body.name) : 'there';
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await otpStore.setOtp(email, 'email_verify', { otp });
    await sendEmailOtpCode({ to: email, otp, name });
    res.json({ ok: true });
  } catch (err) {
    console.error('[email-otp/send]', err.message);
    res.status(500).json({ error: 'Could not send the verification code. Please try again.' });
  }
}

async function verifyEmailOtp(req, res) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    const stored = await otpStore.getOtp(email, 'email_verify');
    if (!stored) return res.status(400).json({ error: 'No code requested. Please send a code first.' });
    if (Date.now() > stored.expiresAt) {
      await otpStore.deleteOtp(email, 'email_verify');
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    }
    if (stored.otp !== otp) return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    await otpStore.deleteOtp(email, 'email_verify');
    res.json({ verified: true });
  } catch (err) {
    console.error('[email-otp/verify]', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
}

// Rename an account's email everywhere it is used as a lookup key: the
// `users` table (the identity row — its failure is fatal), every other
// email-keyed table with no FK (best-effort), and Supabase Auth.
// Firebase Auth is intentionally NOT touched here — the two callers below
// handle it differently (password -> updateUser; Google -> delete old user).
async function renameEmailAcrossData(currentEmail, newEmail, logTag) {
  const { data: updated, error } = await supabase
    .from('users')
    .update({ email: newEmail })
    .eq('email', currentEmail)
    .select('id, name, email, role')
    .single();
  if (error) return { error: error.message };

  const emailKeyedTables = [
    ['user_preferences', 'user_email'],
    ['student_preferences', 'user_email'],
    ['analytics_events', 'user_email'],
    ['habits_checkins', 'user_email'],
    ['llm_logs', 'student_email'],
  ];
  for (const [table, col] of emailKeyedTables) {
    await supabase.from(table).update({ [col]: newEmail }).eq(col, currentEmail)
      .then(({ error: e }) => { if (e) console.error(`[${logTag}] ${table}.${col}:`, e.message); });
  }
  await supabase.from('parent_children').update({ parent_email: newEmail }).eq('parent_email', currentEmail)
    .then(({ error: e }) => { if (e) console.error(`[${logTag}] parent_children.parent_email:`, e.message); });

  try {
    const { data: authList } = await supabase.auth.admin.listUsers();
    const authUser = authList?.users?.find(u => u.email === currentEmail);
    if (authUser) {
      await supabase.auth.admin.updateUserById(authUser.id, { email: newEmail, email_confirm: true });
    }
  } catch (e) {
    console.error(`[${logTag}] supabase auth update failed:`, e.message);
  }

  return { user: updated };
}

async function changeEmail(req, res) {
  try {
    const currentEmail = String(req.body?.currentEmail || '').trim().toLowerCase();
    const newEmail = String(req.body?.newEmail || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    if (!currentEmail || !newEmail || !otp) {
      return res.status(400).json({ error: 'currentEmail, newEmail and otp are required.' });
    }
    if (!EMAIL_RE.test(newEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (newEmail === currentEmail) {
      return res.status(400).json({ error: 'New email must be different from your current one.' });
    }

    const { data: taken } = await supabase.from('users').select('id').eq('email', newEmail).maybeSingle();
    if (taken) return res.status(409).json({ error: 'That email is already in use by another account.' });

    // A Google-SSO account's identity is its linked google.com provider, not
    // the Firebase top-level email — the Admin SDK can't re-point that link,
    // so refuse the rename here and point the user at /change-email-google.
    if (firebaseAdmin) {
      try {
        const fbUser = await firebaseAdmin.auth().getUserByEmail(currentEmail);
        const isGoogleLinked = (fbUser.providerData || []).some(p => p.providerId === 'google.com');
        if (isGoogleLinked) {
          return res.status(409).json({
            error: 'This account signs in with Google, so its email is tied to your Google account and can’t be changed here. To use a different address, sign up / sign in with that Google account instead.',
            code: 'GOOGLE_SSO_EMAIL_IMMUTABLE',
          });
        }
      } catch (e) {
        if (e.code !== 'auth/user-not-found') {
          console.error('[change-email] google-guard lookup failed:', e.message);
        }
      }
    }

    const stored = await otpStore.getOtp(newEmail, 'email_verify');
    if (!stored) return res.status(400).json({ error: 'No code requested for that email. Please send a code first.' });
    if (Date.now() > stored.expiresAt) {
      await otpStore.deleteOtp(newEmail, 'email_verify');
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    }
    if (stored.otp !== otp) return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    await otpStore.deleteOtp(newEmail, 'email_verify');

    const { user: updated, error } = await renameEmailAcrossData(currentEmail, newEmail, 'change-email');
    if (error) return res.status(500).json({ error });

    try {
      if (firebaseAdmin) {
        const fbUser = await firebaseAdmin.auth().getUserByEmail(currentEmail);
        await firebaseAdmin.auth().updateUser(fbUser.uid, { email: newEmail, emailVerified: true });
      }
    } catch (e) {
      console.error('[change-email] firebase auth update failed:', e.message);
    }

    res.json({ ok: true, user: updated });
  } catch (err) {
    console.error('[change-email]', err.message);
    res.status(500).json({ error: 'Could not update your email. Please try again.' });
  }
}

async function changeEmailGoogle(req, res) {
  try {
    const currentEmail = String(req.body?.currentEmail || '').trim().toLowerCase();
    const idToken = String(req.body?.idToken || '').trim();
    if (!currentEmail || !idToken) {
      return res.status(400).json({ error: 'currentEmail and idToken are required.' });
    }
    if (!firebaseAdmin) {
      return res.status(503).json({ error: 'Account migration is temporarily unavailable. Please try again later.' });
    }

    let decoded;
    try {
      decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Could not verify the Google sign-in. Please try again.' });
    }
    const newEmail = String(decoded.email || '').trim().toLowerCase();
    const provider = decoded.firebase?.sign_in_provider;
    if (!newEmail) return res.status(400).json({ error: 'The Google account has no email address.' });
    if (provider !== 'google.com') {
      return res.status(400).json({ error: 'Please confirm with a Google account.' });
    }
    if (newEmail === currentEmail) {
      return res.status(400).json({ error: 'That is the same Google account you already use. Pick a different one.' });
    }

    const { data: taken } = await supabase.from('users').select('id').eq('email', newEmail).maybeSingle();
    if (taken) {
      return res.status(409).json({ error: 'That Google account is already registered with Aivorah. Sign in with it directly instead.' });
    }

    const { user: updated, error } = await renameEmailAcrossData(currentEmail, newEmail, 'change-email-google');
    if (error) return res.status(500).json({ error });

    try {
      const oldFbUser = await firebaseAdmin.auth().getUserByEmail(currentEmail);
      if (oldFbUser.uid !== decoded.uid) {
        await firebaseAdmin.auth().deleteUser(oldFbUser.uid);
      }
    } catch (e) {
      if (e.code !== 'auth/user-not-found') {
        console.error('[change-email-google] old firebase user cleanup failed:', e.message);
      }
    }

    res.json({ ok: true, user: updated, newEmail });
  } catch (err) {
    console.error('[change-email-google]', err.message);
    res.status(500).json({ error: 'Could not switch your Google account. Please try again.' });
  }
}

async function deleteAccount(req, res) {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const emailLc = email.trim().toLowerCase();

    await supabase.from('parent_children').delete().eq('parent_email', emailLc);
    await supabase.from('parent_children').delete().eq('child_email', emailLc);
    const { data: userRow } = await supabase.from('users').select('id').eq('email', emailLc).maybeSingle();
    await supabase.from('student_stats').delete().eq('student_id', userRow?.id || '');
    await supabase.from('user_preferences').delete().eq('user_email', emailLc);
    await supabase.from('users').delete().eq('email', emailLc);

    try {
      if (firebaseAdmin) {
        const fbUser = await firebaseAdmin.auth().getUserByEmail(emailLc).catch(() => null);
        if (fbUser) await firebaseAdmin.auth().deleteUser(fbUser.uid);
      }
    } catch (fbErr) {
      console.warn('[delete-account] firebase delete skipped:', fbErr.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[delete-account]', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { sendEmailOtp, verifyEmailOtp, changeEmail, changeEmailGoogle, deleteAccount };
