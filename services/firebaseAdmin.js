// Firebase Admin — used to generate password reset links server-side, and by
// a few other endpoints (change-email, delete-account) that need to act on a
// user's Firebase account directly.
//
// Supports two init methods:
//   1. FIREBASE_SERVICE_ACCOUNT env var (JSON string) — used on Cloud Run
//   2. firebase-service-account.json file — used locally
//
// Moved out of routes/user.js so routes/auth.js (and anything else) can share
// the same initialized instance without repeating this setup. Node caches
// required modules, so this init code still only runs once no matter how
// many files require it.

let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    let credential = null;

    // Priority 1: base64-encoded env var (Cloud Run / production — avoids CLI special-char issues)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
      const svcJson = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
      credential = admin.credential.cert(svcJson);
      console.log('[firebase-admin] initialised from FIREBASE_SERVICE_ACCOUNT_B64 env var');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const svcJson = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(svcJson);
      console.log('[firebase-admin] initialised from FIREBASE_SERVICE_ACCOUNT env var');
    } else {
      // Priority 2: local file
      const svcPath = require('path').join(__dirname, '../firebase-service-account.json');
      if (require('fs').existsSync(svcPath)) {
        credential = admin.credential.cert(require(svcPath));
        console.log('[firebase-admin] initialised from service account file');
      }
    }

    if (credential) {
      admin.initializeApp({ credential });
      firebaseAdmin = admin;
    } else {
      console.warn('[firebase-admin] no service account found — password reset will use Firebase default sender');
    }
  } else {
    firebaseAdmin = admin;
  }
} catch (e) {
  console.warn('[firebase-admin] not available:', e.message);
}

module.exports = firebaseAdmin;
