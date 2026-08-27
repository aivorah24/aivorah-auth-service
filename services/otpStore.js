// ── Stateless OTP store ────────────────────────────────────────────
// Ported verbatim from ai-mentor/server/services/otpStore.js (2026-08-27) —
// backs one-time codes (email verification) with the `otp_codes` Supabase
// table so they survive across instances behind a load balancer. Same
// Supabase project as the monolith, so the table (and any in-flight codes)
// are shared/compatible.
//
// Safety net: if the `otp_codes` table doesn't exist yet, falls back to an
// in-memory Map (single-instance behaviour, i.e. no regression) and logs a
// one-time warning.

const supabase = require('./supabase');

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _mem = new Map();                // key = `${purpose}:${email}` → { otp, recoveryEmail, expiresAt }
let _tableMissing = false;

const memKey = (email, purpose) => `${purpose}:${email}`;

function isMissingTable(error) {
  return (
    error?.code === '42P01' ||      // postgres: undefined_table
    error?.code === 'PGRST205' ||   // postgrest: table not in schema cache
    /relation .* does not exist|could not find the table/i.test(error?.message || '')
  );
}

function warnMissing() {
  if (_tableMissing) return;
  _tableMissing = true;
  console.warn(
    '[otpStore] `otp_codes` table not found — using in-memory fallback ' +
    '(NOT safe across multiple instances). Run server/sql/otp_codes.sql in Supabase.'
  );
}

/** Store (or replace) a code for an email+purpose. */
async function setOtp(email, purpose, { otp, recoveryEmail = null, ttlMs = DEFAULT_TTL_MS } = {}) {
  const expiresAt = Date.now() + ttlMs;
  try {
    if (!_tableMissing) {
      const { error } = await supabase
        .from('otp_codes')
        .upsert(
          { email, purpose, otp, recovery_email: recoveryEmail, expires_at: new Date(expiresAt).toISOString() },
          { onConflict: 'email,purpose' }
        );
      if (error) throw error;
      return;
    }
  } catch (error) {
    if (isMissingTable(error)) warnMissing();
    else console.error('[otpStore.setOtp]', error.message || error);
  }
  _mem.set(memKey(email, purpose), { otp, recoveryEmail, expiresAt });
}

/** Fetch a code → { otp, recoveryEmail, expiresAt } or null. */
async function getOtp(email, purpose) {
  try {
    if (!_tableMissing) {
      const { data, error } = await supabase
        .from('otp_codes')
        .select('otp, recovery_email, expires_at')
        .eq('email', email)
        .eq('purpose', purpose)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { otp: data.otp, recoveryEmail: data.recovery_email, expiresAt: new Date(data.expires_at).getTime() };
    }
  } catch (error) {
    if (isMissingTable(error)) warnMissing();
    else console.error('[otpStore.getOtp]', error.message || error);
  }
  const m = _mem.get(memKey(email, purpose));
  return m ? { otp: m.otp, recoveryEmail: m.recoveryEmail, expiresAt: m.expiresAt } : null;
}

/** Remove a code (after a successful verify, or to invalidate). */
async function deleteOtp(email, purpose) {
  try {
    if (!_tableMissing) {
      const { error } = await supabase.from('otp_codes').delete().eq('email', email).eq('purpose', purpose);
      if (error) throw error;
    }
  } catch (error) {
    if (isMissingTable(error)) warnMissing();
    else console.error('[otpStore.deleteOtp]', error.message || error);
  }
  _mem.delete(memKey(email, purpose));
}

module.exports = { setOtp, getOtp, deleteOtp };
