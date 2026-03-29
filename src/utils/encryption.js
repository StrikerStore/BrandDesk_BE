const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) throw new Error('FATAL: ENCRYPTION_KEY environment variable is required (64-char hex string from crypto.randomBytes(32).toString("hex"))');

const keyBuffer = Buffer.from(ENCRYPTION_KEY, 'hex');

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns format: iv:authTag:ciphertext (all hex-encoded)
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt ciphertext encrypted by encrypt().
 * Input format: iv:authTag:ciphertext (all hex-encoded)
 * Returns null if input is falsy. Returns original string if not in encrypted format (backward compat).
 */
function decrypt(encryptedStr) {
  if (!encryptedStr) return encryptedStr;
  const parts = encryptedStr.split(':');
  if (parts.length !== 3) return encryptedStr; // Not encrypted (legacy plaintext) — return as-is
  const [ivHex, authTagHex, ciphertext] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return encryptedStr; // Decryption failed — likely legacy plaintext
  }
}

module.exports = { encrypt, decrypt };
