require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const USER_NAME     = 'Shopify Reviewer';
const USER_EMAIL    = 'shopify-reviewer@branddesk.in';
const USER_PASSWORD = 'ShopifyReview2024!';
const WS_SLUG       = 'shopify-review-workspace';
const BRAND_LABEL   = 'shopify-test';

const SETTINGS_DEFAULTS = [
  ['auto_ack_enabled',         'false'],
  ['auto_ack_delay_minutes',   '5'],
  ['auto_close_enabled',       'false'],
  ['auto_close_days',          '7'],
  ['sla_first_response_hours', '4'],
  ['sla_resolve_hours',        '24'],
];

async function seedShopifyTest() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Create user (email + password login)
    const hash = await bcrypt.hash(USER_PASSWORD, 12);
    await conn.query(
      `INSERT INTO users (name, email, password_hash, role, is_active)
       VALUES (?, ?, ?, 'owner', 1)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), password_hash = VALUES(password_hash),
         role = 'owner', is_active = 1`,
      [USER_NAME, USER_EMAIL.toLowerCase(), hash]
    );
    const [[user]] = await conn.query('SELECT id FROM users WHERE email = ?', [USER_EMAIL.toLowerCase()]);

    // 2. Create workspace — approved, pro plan, onboarding bypassed
    await conn.query(
      `INSERT INTO workspaces (slug, name, owner_user_id, plan, trial_ends_at, onboarding_status, is_active)
       VALUES (?, 'Shopify Review Workspace', ?, 'pro', NULL, 'approved', 1)
       ON DUPLICATE KEY UPDATE
         owner_user_id = VALUES(owner_user_id), plan = 'pro',
         trial_ends_at = NULL, onboarding_status = 'approved', is_active = 1`,
      [WS_SLUG, user.id]
    );
    const [[ws]] = await conn.query('SELECT id FROM workspaces WHERE slug = ?', [WS_SLUG]);

    // 3. Workspace member (owner role)
    await conn.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')
       ON DUPLICATE KEY UPDATE role = 'owner'`,
      [ws.id, user.id]
    );

    // 4. Default settings (same 6 keys seeded by normal registration)
    for (const [key, value] of SETTINGS_DEFAULTS) {
      await conn.query(
        'INSERT IGNORE INTO settings (workspace_id, key_name, value) VALUES (?, ?, ?)',
        [ws.id, key, value]
      );
    }

    // 5. Pre-approved brand — Shopify store left NULL (reviewer connects their own dev store)
    const widgetToken = crypto.randomBytes(32).toString('hex');
    await conn.query(
      `INSERT INTO brands (workspace_id, label, email, name, brand_status, initial_sync_done, widget_token, is_active)
       VALUES (?, ?, 'demo@branddesk.in', 'Demo Brand', 'approved', 1, ?, 1)
       ON DUPLICATE KEY UPDATE
         brand_status = 'approved', initial_sync_done = 1, is_active = 1`,
      [ws.id, BRAND_LABEL, widgetToken]
    );

    await conn.commit();

    console.log('\n==========================================');
    console.log('  SHOPIFY REVIEWER CREDENTIALS');
    console.log('==========================================');
    console.log(`  URL:      https://www.branddesk.in`);
    console.log(`  Email:    ${USER_EMAIL}`);
    console.log(`  Password: ${USER_PASSWORD}`);
    console.log(`  Plan:     pro (unlimited, approved)`);
    console.log('==========================================');
    console.log('\nNext: run  npm run db:seed:demo-threads\n');

  } catch (err) {
    await conn.rollback();
    console.error('Failed:', err.message);
    process.exit(1);
  } finally {
    conn.release();
  }
  process.exit(0);
}

seedShopifyTest();
