/**
 * BrandDesk — Single consolidated migration
 * 
 * Combines all previous migrations (v1 through v20) into one idempotent script.
 * Every statement uses CREATE TABLE IF NOT EXISTS / ALTER TABLE … ADD COLUMN
 * with error handling for duplicates, so it is safe to run repeatedly.
 *
 * Run:  node src/config/migrate.js
 */
require('dotenv').config();
const mysql  = require('mysql2/promise');
const crypto = require('crypto');

async function migrate() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  const dbName = process.env.DB_NAME || 'helpdesk';
  console.log(`🔄 Running BrandDesk migrations on "${dbName}" …\n`);

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await conn.query(`USE \`${dbName}\``);

  // ════════════════════════════════════════════════════════════════════
  //  TABLES — core
  // ════════════════════════════════════════════════════════════════════

  // -- users (v7 + v10) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(100) NOT NULL,
      email         VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NULL,
      role          ENUM('admin','owner','agent') DEFAULT 'owner',
      google_id     VARCHAR(255) NULL,
      avatar_url    VARCHAR(500) NULL,
      is_active     TINYINT(1) DEFAULT 1,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_email (email),
      UNIQUE INDEX idx_google_id (google_id)
    )
  `, 'users table');

  // Upgrade ENUM for existing databases + backfill owners
  await safely(conn, `
    ALTER TABLE users MODIFY COLUMN role ENUM('admin','owner','agent') DEFAULT 'owner'
  `, 'users.role ENUM upgrade');

  await safely(conn, `
    UPDATE users u
    INNER JOIN workspace_members wm ON wm.user_id = u.id AND wm.role = 'owner'
    SET u.role = 'owner'
    WHERE u.role = 'agent'
  `, 'backfill owner roles');

  // -- auth_tokens (v1, legacy — kept for backward compat) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expiry_date BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `, 'auth_tokens table');

  // -- workspaces (v9 + v14 + v15) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS workspaces (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      slug              VARCHAR(100) NOT NULL UNIQUE,
      name              VARCHAR(255) NOT NULL,
      owner_user_id     INT NOT NULL,
      plan              ENUM('trial','starter','pro') DEFAULT 'trial',
      trial_ends_at     TIMESTAMP NULL,
      is_active         TINYINT(1) DEFAULT 1,
      onboarding_status ENUM('not_started','gmail_connected','brand_added','details_submitted','connections_done','pending_approval','approved') NOT NULL DEFAULT 'not_started',
      pending_plan_change ENUM('trial','starter','pro') NULL,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_slug (slug)
    )
  `, 'workspaces table');

  // -- workspace_members (v9) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS workspace_members (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id      INT NOT NULL,
      role         ENUM('owner','admin','agent') DEFAULT 'agent',
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ws_user (workspace_id, user_id),
      INDEX idx_workspace (workspace_id),
      INDEX idx_user (user_id)
    )
  `, 'workspace_members table');

  // -- gmail_tokens (v9 + v15: multi-gmail) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS gmail_tokens (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id  INT NOT NULL,
      email         VARCHAR(255) NOT NULL,
      access_token  TEXT NOT NULL,
      refresh_token TEXT NULL,
      expiry_date   BIGINT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workspace (workspace_id),
      UNIQUE KEY uq_ws_email (workspace_id, email)
    )
  `, 'gmail_tokens table');

  // -- brands (v9 + v12 + v15 + v18) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS brands (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id    INT NOT NULL,
      label           VARCHAR(100) NULL,
      email           VARCHAR(255) NOT NULL,
      name            VARCHAR(255) NOT NULL,
      category        VARCHAR(255) NULL,
      website         VARCHAR(500) NULL,
      gmail_token_id  INT NULL,
      brand_status    ENUM('draft','pending_approval','approved','rejected') NOT NULL DEFAULT 'draft',
      initial_sync_done TINYINT(1) NOT NULL DEFAULT 0,
      shopify_store   VARCHAR(500) NULL,
      shopify_token   VARCHAR(500) NULL,
      widget_token    VARCHAR(64) NULL,
      rejection_reason TEXT NULL,
      is_active       TINYINT(1) DEFAULT 1,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ws_label (workspace_id, label),
      INDEX idx_workspace (workspace_id)
    )
  `, 'brands table');

  // -- customers (v1 + v9: workspace scoped) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS customers (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id   INT NOT NULL DEFAULT 1,
      email          VARCHAR(255) NOT NULL,
      name           VARCHAR(255),
      shopify_id     VARCHAR(100),
      phone          VARCHAR(50),
      location       VARCHAR(255),
      total_orders   INT DEFAULT 0,
      lifetime_value DECIMAL(10,2) DEFAULT 0,
      notes          TEXT,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ws_email (workspace_id, email)
    )
  `, 'customers table');

  // -- threads (v1 + v2 + v4 + v6 + v9) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS threads (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id        INT NOT NULL DEFAULT 1,
      gmail_thread_id     VARCHAR(255) NOT NULL UNIQUE,
      subject             VARCHAR(500),
      brand               VARCHAR(100),
      brand_email         VARCHAR(255),
      status              ENUM('open','in_progress','resolved') DEFAULT 'open',
      priority            ENUM('urgent','normal','low') DEFAULT 'normal',
      customer_email      VARCHAR(255),
      customer_name       VARCHAR(255),
      is_unread           TINYINT(1) DEFAULT 1,
      snoozed_until       TIMESTAMP NULL,
      tags                JSON,
      first_response_minutes INT NULL,
      extra_fields        JSON NULL,
      ticket_id           VARCHAR(100) NULL,
      order_number        VARCHAR(100) NULL,
      issue_category      VARCHAR(255) NULL,
      sub_issue           VARCHAR(255) NULL,
      customer_phone      VARCHAR(50) NULL,
      customer_country    VARCHAR(10) NULL,
      is_shopify_form     TINYINT(1) DEFAULT 0,
      status_changed_at   TIMESTAMP NULL,
      resolved_by         VARCHAR(255) NULL,
      resolution_note     TEXT NULL,
      resolved_at         TIMESTAMP NULL,
      auto_ack_sent       TINYINT(1) DEFAULT 0,
      created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_gmail_thread_id (gmail_thread_id),
      INDEX idx_status (status),
      INDEX idx_brand (brand),
      INDEX idx_customer_email (customer_email),
      INDEX idx_ticket_id (ticket_id),
      INDEX idx_ws_status (workspace_id, status),
      INDEX idx_ws_brand (workspace_id, brand)
    )
  `, 'threads table');

  // fulltext indexes (v3) — separate because CREATE TABLE can't mix them
  await addIndex(conn, 'threads', 'ft_threads',
    `ALTER TABLE threads ADD FULLTEXT INDEX ft_threads (subject, customer_name, customer_email, ticket_id, order_number, issue_category)`);

  // -- messages (v1 + v9) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS messages (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id     INT NOT NULL DEFAULT 1,
      thread_id        INT NOT NULL,
      gmail_message_id VARCHAR(255) UNIQUE,
      direction        ENUM('inbound','outbound') NOT NULL,
      from_email       VARCHAR(255),
      from_name        VARCHAR(255),
      body             TEXT,
      body_html        TEXT,
      is_note          TINYINT(1) DEFAULT 0,
      sent_at          TIMESTAMP,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
      INDEX idx_thread_id (thread_id),
      INDEX idx_gmail_message_id (gmail_message_id),
      INDEX idx_ws (workspace_id)
    )
  `, 'messages table');

  await addIndex(conn, 'messages', 'ft_messages',
    `ALTER TABLE messages ADD FULLTEXT INDEX ft_messages (body)`);

  // -- attachments (v8 + v9 + v13) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS attachments (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id     INT NOT NULL DEFAULT 1,
      message_id       INT NOT NULL,
      thread_id        INT NULL,
      gmail_message_id VARCHAR(255) NOT NULL,
      attachment_id    VARCHAR(500) NOT NULL,
      filename         VARCHAR(500) NOT NULL,
      mime_type        VARCHAR(100) NOT NULL,
      size             INT DEFAULT 0,
      direction        ENUM('inbound','outbound') DEFAULT 'inbound',
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_message_id (message_id),
      INDEX idx_workspace (workspace_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `, 'attachments table');

  // -- templates (v1 + v9) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS templates (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL DEFAULT 1,
      title        VARCHAR(255) NOT NULL,
      category     VARCHAR(100),
      body         TEXT NOT NULL,
      brand_filter VARCHAR(100) DEFAULT NULL,
      usage_count  INT DEFAULT 0,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workspace (workspace_id)
    )
  `, 'templates table');

  // -- saved_views (v5 + v9) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS saved_views (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL DEFAULT 1,
      name         VARCHAR(100) NOT NULL,
      filters      JSON NOT NULL,
      sort_order   INT DEFAULT 0,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, 'saved_views table');

  // -- settings (v6 + v9) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS settings (
      workspace_id INT NOT NULL DEFAULT 1,
      key_name     VARCHAR(100) NOT NULL,
      value        TEXT,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, key_name)
    )
  `, 'settings table');

  // ════════════════════════════════════════════════════════════════════
  //  TABLES — billing & payments (v11 + v13 + v16)
  // ════════════════════════════════════════════════════════════════════

  await safely(conn, `
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id          INT NOT NULL,
      plan                  ENUM('starter','pro') NOT NULL,
      billing_cycle         ENUM('monthly','yearly') DEFAULT 'monthly',
      payu_subscription_id  VARCHAR(255) NULL,
      status                ENUM('active','cancelled','expired','past_due','pending') DEFAULT 'pending',
      amount                DECIMAL(10,2) NOT NULL,
      currency              VARCHAR(3) DEFAULT 'INR',
      current_period_start  TIMESTAMP NULL,
      current_period_end    TIMESTAMP NULL,
      cancelled_at          TIMESTAMP NULL,
      created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workspace (workspace_id),
      INDEX idx_status (status),
      INDEX idx_payu_sub (payu_subscription_id)
    )
  `, 'subscriptions table');

  await safely(conn, `
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id     INT NOT NULL,
      subscription_id  INT NULL,
      txn_id           VARCHAR(255) NOT NULL UNIQUE,
      payu_mihpayid    VARCHAR(255) NULL,
      amount           DECIMAL(10,2) NOT NULL,
      status           ENUM('success','failure','pending') DEFAULT 'pending',
      payment_method   VARCHAR(50) NULL,
      raw_response     JSON NULL,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workspace (workspace_id),
      INDEX idx_txn (txn_id)
    )
  `, 'payment_transactions table');

  await safely(conn, `
    CREATE TABLE IF NOT EXISTS coupons (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      code            VARCHAR(50) NOT NULL UNIQUE,
      discount_type   ENUM('percent','fixed') NOT NULL DEFAULT 'percent',
      discount_value  DECIMAL(10,2) NOT NULL,
      min_plan        ENUM('starter','pro') DEFAULT NULL,
      max_uses        INT DEFAULT NULL,
      used_count      INT DEFAULT 0,
      valid_from      DATETIME DEFAULT NULL,
      valid_until     DATETIME DEFAULT NULL,
      is_active       TINYINT(1) DEFAULT 1,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_code (code)
    )
  `, 'coupons table');

  await safely(conn, `
    CREATE TABLE IF NOT EXISTS coupon_usage (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      coupon_id       INT NOT NULL,
      workspace_id    INT NOT NULL,
      subscription_id INT NOT NULL,
      discount_amount DECIMAL(10,2) NOT NULL,
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_coupon (coupon_id),
      INDEX idx_workspace (workspace_id)
    )
  `, 'coupon_usage table');

  // -- plans (v16) --
  await safely(conn, `
    CREATE TABLE IF NOT EXISTS plans (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      name                  VARCHAR(50) NOT NULL UNIQUE,
      display_name          VARCHAR(100) NOT NULL,
      description           VARCHAR(500) NULL,
      sort_order            INT NOT NULL DEFAULT 0,
      is_active             TINYINT(1) NOT NULL DEFAULT 1,
      max_brands            INT NULL,
      max_members           INT NULL,
      max_threads_per_month INT NULL,
      max_templates         INT NULL,
      price_monthly         INT NULL DEFAULT 0,
      price_yearly          INT NULL DEFAULT 0,
      is_default            TINYINT(1) NOT NULL DEFAULT 0,
      created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `, 'plans table');

  // ════════════════════════════════════════════════════════════════════
  //  TABLES — support (v17)
  // ════════════════════════════════════════════════════════════════════

  await safely(conn, `
    CREATE TABLE IF NOT EXISTS support_tickets (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id      INT NOT NULL,
      subject      VARCHAR(255) NOT NULL,
      description  TEXT NOT NULL,
      category     ENUM('bug','feature_request','billing','general') NOT NULL DEFAULT 'general',
      priority     ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
      status       ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workspace (workspace_id),
      INDEX idx_status (status),
      INDEX idx_created (created_at)
    )
  `, 'support_tickets table');

  await safely(conn, `
    CREATE TABLE IF NOT EXISTS support_ticket_replies (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id  INT NOT NULL,
      user_id    INT NOT NULL,
      is_admin   TINYINT(1) NOT NULL DEFAULT 0,
      message    TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ticket (ticket_id),
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
    )
  `, 'support_ticket_replies table');

  // ════════════════════════════════════════════════════════════════════
  //  TABLES — marketing (v19)
  // ════════════════════════════════════════════════════════════════════

  await safely(conn, `
    CREATE TABLE IF NOT EXISTS demo_requests (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      brand_name    VARCHAR(255) NOT NULL,
      brand_type    VARCHAR(100) NULL,
      platform      ENUM('shopify','other') NOT NULL DEFAULT 'other',
      contact_name  VARCHAR(255) NOT NULL,
      contact_email VARCHAR(255) NOT NULL,
      contact_phone VARCHAR(50) NULL,
      website       VARCHAR(500) NULL,
      message       TEXT NULL,
      status        ENUM('new','contacted','completed','cancelled') NOT NULL DEFAULT 'new',
      admin_notes   TEXT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_created (created_at)
    )
  `, 'demo_requests table');

  // ════════════════════════════════════════════════════════════════════
  //  SEED DATA
  // ════════════════════════════════════════════════════════════════════

  // Default settings
  const defaults = [
    ['auto_ack_enabled',       'false'],
    ['auto_ack_delay_minutes', '5'],
    ['auto_close_enabled',     'false'],
    ['auto_close_days',        '7'],
  ];
  for (const [key, value] of defaults) {
    await conn.query(
      'INSERT IGNORE INTO settings (workspace_id, key_name, value) VALUES (1, ?, ?)',
      [key, value]
    );
  }
  console.log('  ✅ Default settings seeded');

  // Default plans
  const plans = [
    { name: 'trial',   display_name: 'Trial',   description: '14-day free trial',                     sort_order: 0, max_brands: 1,    max_members: 1,    max_threads_per_month: 200,  max_templates: 5,    price_monthly: 0,    price_yearly: 0,     is_default: 1 },
    { name: 'starter', display_name: 'Starter', description: '3 brands · 3 members · 1K threads/mo', sort_order: 1, max_brands: 3,    max_members: 3,    max_threads_per_month: 1000, max_templates: 20,   price_monthly: 999,  price_yearly: 9999,  is_default: 0 },
    { name: 'pro',     display_name: 'Pro',     description: 'Unlimited everything + priority support', sort_order: 2, max_brands: null, max_members: null, max_threads_per_month: null, max_templates: null, price_monthly: 2499, price_yearly: 24999, is_default: 0 },
  ];
  for (const p of plans) {
    await conn.query(
      `INSERT INTO plans (name, display_name, description, sort_order, max_brands, max_members, max_threads_per_month, max_templates, price_monthly, price_yearly, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)`,
      [p.name, p.display_name, p.description, p.sort_order, p.max_brands, p.max_members, p.max_threads_per_month, p.max_templates, p.price_monthly, p.price_yearly, p.is_default]
    );
  }
  console.log('  ✅ Default plans seeded');

  // Generate widget_token for any brands missing one
  const [brandsMissingToken] = await conn.query('SELECT id FROM brands WHERE widget_token IS NULL');
  for (const brand of brandsMissingToken) {
    const token = crypto.randomBytes(32).toString('hex');
    await conn.query('UPDATE brands SET widget_token = ? WHERE id = ?', [token, brand.id]);
  }
  if (brandsMissingToken.length) console.log(`  ✅ Generated widget_token for ${brandsMissingToken.length} brands`);

  // ════════════════════════════════════════════════════════════════════

  console.log('\n✅ All migrations complete');
  await conn.end();
}

// ── Helpers ─────────────────────────────────────────────────────────

async function safely(conn, sql, label) {
  try {
    await conn.query(sql);
    console.log(`  ✅ ${label}`);
  } catch (err) {
    if (err.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log(`  ⏭  ${label} already exists`);
    } else {
      throw err;
    }
  }
}

async function addIndex(conn, table, name, sql) {
  try {
    await conn.query(sql);
    console.log(`  ✅ ${table}: ${name} index`);
  } catch (err) {
    if (err.code === 'ER_DUP_KEYNAME') console.log(`  ⏭  ${table}: ${name} already exists`);
    else console.log(`  ⚠  ${table}: ${name} skipped: ${err.message}`);
  }
}

// ── Run ─────────────────────────────────────────────────────────────

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
