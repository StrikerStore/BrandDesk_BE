const express = require('express');
const crypto  = require('crypto');
const db      = require('../config/db');

const router = express.Router();

// ── HMAC verification for Shopify webhooks ────────────────────
// Shopify signs the raw body with HMAC-SHA256 using the app secret.
// Header: X-Shopify-Hmac-Sha256 (base64-encoded)
function verifyShopifyHmac(req, res, next) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) {
    return res.status(401).json({ error: 'Missing HMAC header' });
  }

  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) {
    console.error('SHOPIFY_CLIENT_SECRET not set — cannot verify webhook');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.body) // req.body is a raw Buffer (express.raw)
    .digest('base64');

  if (!crypto.timingSafeEqual(Buffer.from(digest, 'base64'), Buffer.from(hmacHeader, 'base64'))) {
    return res.status(401).json({ error: 'HMAC verification failed' });
  }

  // Parse the raw body into JSON for the route handlers
  try {
    req.shopifyPayload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  next();
}

router.use(verifyShopifyHmac);

// ══════════════════════════════════════════════════════════════
// Single-endpoint dispatcher (Shopify TOML uses one URI for all
// compliance topics and sends the topic in X-Shopify-Topic header)
// ══════════════════════════════════════════════════════════════
router.post('/', (req, res, next) => {
  const topic = req.headers['x-shopify-topic'];
  if (topic === 'customers/data_request') req.url = '/customers/data_request';
  else if (topic === 'customers/redact')  req.url = '/customers/redact';
  else if (topic === 'shop/redact')       req.url = '/shop/redact';
  else return res.status(400).json({ error: `Unknown topic: ${topic}` });
  next();
});

// ── Helper: find workspace IDs that use a given Shopify shop ──
async function findWorkspacesByShop(shopDomain) {
  const normalized = shopDomain.toLowerCase().trim();
  const [rows] = await db.query(
    'SELECT DISTINCT workspace_id FROM brands WHERE LOWER(shopify_store) = ? AND is_active = 1',
    [normalized]
  );
  return rows.map(r => r.workspace_id);
}

// ══════════════════════════════════════════════════════════════
// 1. POST /customers/data_request
//    A customer requested their data. Acknowledge with 200.
//    Shopify does not expect a data payload in the response —
//    you email the data to the customer separately if needed.
// ══════════════════════════════════════════════════════════════
router.post('/customers/data_request', async (req, res) => {
  const { shop_domain, customer } = req.shopifyPayload;
  console.log(`[Shopify Webhook] customers/data_request — shop: ${shop_domain}, customer: ${customer?.email}`);

  // Nothing to delete — just acknowledge.
  // If you store significant customer data, email it to the customer here.
  res.status(200).json({});
});

// ══════════════════════════════════════════════════════════════
// 2. POST /customers/redact
//    A customer asked the store to erase their personal data.
//    Delete or anonymise everything we store about this customer.
// ══════════════════════════════════════════════════════════════
router.post('/customers/redact', async (req, res) => {
  const { shop_domain, customer } = req.shopifyPayload;
  const email = customer?.email;
  console.log(`[Shopify Webhook] customers/redact — shop: ${shop_domain}, customer: ${email}`);

  if (!email || !shop_domain) return res.status(200).json({});

  try {
    const workspaceIds = await findWorkspacesByShop(shop_domain);
    if (!workspaceIds.length) return res.status(200).json({});

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      for (const wsId of workspaceIds) {
        // Anonymise threads from this customer
        await conn.query(
          `UPDATE threads SET customer_email = '[redacted]', customer_name = '[redacted]', customer_phone = NULL
           WHERE workspace_id = ? AND customer_email = ?`,
          [wsId, email]
        );

        // Delete customer record
        await conn.query(
          'DELETE FROM customers WHERE workspace_id = ? AND email = ?',
          [wsId, email]
        );
      }

      await conn.commit();
      console.log(`[Shopify Webhook] Customer data redacted for ${email} across ${workspaceIds.length} workspace(s)`);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('[Shopify Webhook] customers/redact error:', err.message);
  }

  res.status(200).json({});
});

// ══════════════════════════════════════════════════════════════
// 3. POST /shop/redact
//    The merchant uninstalled the app. Delete all data we stored
//    for this shop within 48 hours.
// ══════════════════════════════════════════════════════════════
router.post('/shop/redact', async (req, res) => {
  const { shop_domain } = req.shopifyPayload;
  console.log(`[Shopify Webhook] shop/redact — shop: ${shop_domain}`);

  if (!shop_domain) return res.status(200).json({});

  try {
    const normalized = shop_domain.toLowerCase().trim();

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Find all brands linked to this Shopify shop
      const [brands] = await conn.query(
        'SELECT id, workspace_id FROM brands WHERE LOWER(shopify_store) = ?',
        [normalized]
      );

      for (const brand of brands) {
        // Clear Shopify credentials from the brand
        await conn.query(
          'UPDATE brands SET shopify_store = NULL, shopify_token = NULL WHERE id = ?',
          [brand.id]
        );
      }

      await conn.commit();
      console.log(`[Shopify Webhook] Shop data redacted for ${shop_domain} — ${brands.length} brand(s) disconnected`);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('[Shopify Webhook] shop/redact error:', err.message);
  }

  res.status(200).json({});
});

module.exports = router;
