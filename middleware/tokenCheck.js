const firebaseAdmin = require('../services/firebaseAdmin');

// AUTH_ENFORCE=enforce blocks; anything else only logs what would be blocked.
const enforcing = () => process.env.AUTH_ENFORCE === 'enforce';

async function decodeBearer(req) {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!match) return { status: 'missing' };
  if (!firebaseAdmin) return { status: 'unconfigured' };
  try {
    return { status: 'ok', decoded: await firebaseAdmin.auth().verifyIdToken(match[1]) };
  } catch {
    return { status: 'invalid' };
  }
}

function deny(req, res, next, code, error) {
  if (enforcing()) return res.status(code).json({ error });
  console.warn(`[auth-monitor] would ${code} ${req.method} ${req.originalUrl}: ${error}`);
  return next();
}

// Caller must be signed in as the email the request acts on.
function requireSelf(getEmail) {
  return async (req, res, next) => {
    const { status, decoded } = await decodeBearer(req);
    if (status === 'unconfigured') return deny(req, res, next, 500, 'Auth is not configured on this server');
    if (status !== 'ok') return deny(req, res, next, 401, 'Sign in required');
    const tokenEmail = String(decoded.email || '').toLowerCase().trim();
    const target = String(getEmail(req) || '').toLowerCase().trim();
    if (!tokenEmail || (target && target !== tokenEmail)) {
      return deny(req, res, next, 403, 'You can only act on your own account');
    }
    req.authEmail = tokenEmail;
    req.authTime = decoded.auth_time;
    next();
  };
}

// Always enforced: the delete flow already re-confirms the password/Google login first.
const RECENT_LOGIN_SECONDS = 10 * 60;
async function requireRecentSelf(req, res, next) {
  const { status, decoded } = await decodeBearer(req);
  if (status === 'unconfigured') return res.status(500).json({ error: 'Auth is not configured on this server' });
  if (status !== 'ok') return res.status(401).json({ error: 'Sign in required' });
  const tokenEmail = String(decoded.email || '').toLowerCase().trim();
  const target = String(req.body?.email || '').toLowerCase().trim();
  if (!tokenEmail || (target && target !== tokenEmail)) {
    return res.status(403).json({ error: 'You can only delete your own account' });
  }
  if (!decoded.auth_time || Date.now() / 1000 - decoded.auth_time > RECENT_LOGIN_SECONDS) {
    return res.status(401).json({ error: 'Please confirm your password or Google sign-in again' });
  }
  req.body = { ...req.body, email: tokenEmail };
  next();
}

module.exports = { requireSelf, requireRecentSelf, decodeBearer };
