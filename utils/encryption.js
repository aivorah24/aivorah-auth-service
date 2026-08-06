/**
 * AES-256-GCM encryption for sensitive PII fields stored in local JSON files.
 * Usage:
 *   const { encrypt, decrypt, hashEmail } = require('./encryption');
 *   const stored  = encrypt('user@example.com');   // cipher:iv:tag
 *   const plain   = decrypt(stored);               // 'user@example.com'
 *   const key     = hashEmail('user@example.com'); // sha-256 hex (used as JSON key)
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LEN    = 12; // 96-bit recommended for GCM
const TAG_LEN   = 16;

// Derive a 32-byte key from the env variable.
// Falls back to a fixed dev key so the server starts without configuration,
// but logs a loud warning.
function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[encryption] WARNING: ENCRYPTION_KEY not set — using insecure dev key. Set this in .env for production!');
    }
    return Buffer.from('aivorah-dev-key-do-not-use-in-prod-!!', 'utf8').subarray(0, 32);
  }
  // Accept any string — derive exactly 32 bytes via SHA-256
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypt a string value.
 * Returns a colon-separated base64 string: "ciphertext:iv:authTag"
 * Returns the original value unchanged if it is already encrypted (contains ':').
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  // Idempotency guard — don't double-encrypt
  if (typeof plaintext === 'string' && plaintext.split(':').length === 3) return plaintext;

  const key = getKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    encrypted.toString('base64'),
    iv.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a value previously encrypted with encrypt().
 * Returns the original value unchanged if it is not in cipher format.
 */
function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  const parts = String(ciphertext).split(':');
  if (parts.length !== 3) return ciphertext; // not encrypted — return as-is

  try {
    const [encB64, ivB64, tagB64] = parts;
    const key     = getKey();
    const iv      = Buffer.from(ivB64, 'base64');
    const tag     = Buffer.from(tagB64, 'base64');
    const encData = Buffer.from(encB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Decryption failed (wrong key or corrupted) — return empty string
    return '';
  }
}

/**
 * One-way SHA-256 hash of an email address.
 * Used as the JSON object key so raw emails are not stored as plaintext keys.
 * Always lowercases + trims the email first.
 */
function hashEmail(email) {
  return crypto
    .createHash('sha256')
    .update(String(email).toLowerCase().trim())
    .digest('hex');
}

module.exports = { encrypt, decrypt, hashEmail };
