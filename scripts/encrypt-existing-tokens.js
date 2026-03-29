/**
 * One-time migration script to encrypt existing plaintext tokens in the database.
 *
 * Usage:  node scripts/encrypt-existing-tokens.js
 *
 * Prerequisites:
 *   - Set ENCRYPTION_KEY in .env before running
 *   - This script is idempotent — already-encrypted values are detected and skipped
 */
require('dotenv').config();
const db = require('../src/config/db');
const { encrypt, decrypt } = require('../src/utils/encryption');

function isAlreadyEncrypted(value) {
  if (!value) return true; // null/empty — nothing to encrypt
  const parts = value.split(':');
  if (parts.length !== 3) return false; // Not in iv:tag:ciphertext format
  // Try decrypting — if it works, it's already encrypted
  try {
    const decrypted = decrypt(value);
    return decrypted !== value; // decrypt returns original if it fails, different if success
  } catch {
    return false;
  }
}

async function migrateGmailTokens() {
  const [rows] = await db.query('SELECT id, access_token, refresh_token FROM gmail_tokens');
  let updated = 0;
  for (const row of rows) {
    const updates = [];
    const params = [];

    if (row.access_token && !isAlreadyEncrypted(row.access_token)) {
      updates.push('access_token = ?');
      params.push(encrypt(row.access_token));
    }
    if (row.refresh_token && !isAlreadyEncrypted(row.refresh_token)) {
      updates.push('refresh_token = ?');
      params.push(encrypt(row.refresh_token));
    }

    if (updates.length) {
      params.push(row.id);
      await db.query(`UPDATE gmail_tokens SET ${updates.join(', ')} WHERE id = ?`, params);
      updated++;
    }
  }
  console.log(`Gmail tokens: ${updated}/${rows.length} rows encrypted`);
}

async function migrateShopifyTokens() {
  const [rows] = await db.query('SELECT id, shopify_token FROM brands WHERE shopify_token IS NOT NULL AND shopify_token != ""');
  let updated = 0;
  for (const row of rows) {
    if (!isAlreadyEncrypted(row.shopify_token)) {
      await db.query('UPDATE brands SET shopify_token = ? WHERE id = ?', [encrypt(row.shopify_token), row.id]);
      updated++;
    }
  }
  console.log(`Shopify tokens: ${updated}/${rows.length} rows encrypted`);
}

async function main() {
  try {
    console.log('Starting token encryption migration...');
    await migrateGmailTokens();
    await migrateShopifyTokens();
    console.log('Migration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await db.end();
  }
}

main();
