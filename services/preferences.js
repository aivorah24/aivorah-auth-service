// Reads and writes the Supabase user_preferences table.
//
// Moved out of routes/user.js so routes/auth.js (and anything else) can share
// it without duplicating the logic. Behavior is unchanged from before the move.

const supabase = require('./supabase');

async function getPreferences(email) {
  try {
    const key = email.toLowerCase().trim();
    const { data } = await supabase.from('user_preferences').select('data').eq('user_email', key).maybeSingle();
    return data?.data ?? null;
  } catch { return null; }
}

async function setPreferences(email, updates) {
  try {
    const key = email.toLowerCase().trim();
    const { data: existing } = await supabase.from('user_preferences').select('data').eq('user_email', key).maybeSingle();
    const merged = { ...(existing?.data ?? {}), ...updates };
    await supabase.from('user_preferences').upsert({ user_email: key, data: merged, updated_at: new Date().toISOString() }, { onConflict: 'user_email' });
  } catch (err) { console.error('[setPreferences]', err?.message); }
}

async function readPreferences() {
  // Returns all rows as a flat object keyed by email (for CSV export)
  try {
    const { data } = await supabase.from('user_preferences').select('user_email, data');
    const out = {};
    for (const row of (data ?? [])) out[row.user_email] = row.data ?? {};
    return out;
  } catch { return {}; }
}

module.exports = { getPreferences, setPreferences, readPreferences };
