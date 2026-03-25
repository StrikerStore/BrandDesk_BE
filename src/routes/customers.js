const express = require('express');
const db = require('../config/db');
const { requireWorkspace } = require('../middleware/authMiddleware');
const { resolveDataSource, fetchCustomerByEmail } = require('../services/shopify');

const router = express.Router();

// GET /api/customers/:email?brand=LABEL
router.get('/:email', requireWorkspace, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const wsId  = req.user.workspace_id;
    const brand = req.query.brand;

    // Always fetch local customer + past tickets (they live in local DB)
    const [rows] = await db.query(
      'SELECT * FROM customers WHERE email=? AND workspace_id=?',
      [email, wsId]
    );
    const customer = rows[0] || { email, name: null, phone: null };

    const [pastTickets] = await db.query(
      `SELECT id, subject, status, brand, ticket_id, order_number,
              issue_category, sub_issue, created_at
       FROM threads
       WHERE customer_email=? AND workspace_id=?
       ORDER BY created_at DESC LIMIT 10`,
      [email, wsId]
    );

    // Enrich with Shopify customer data if applicable
    const ds = await resolveDataSource(wsId, brand);
    if (ds.source === 'shopify') {
      try {
        const shopifyCustomer = await fetchCustomerByEmail(ds.shop, ds.token, email);
        if (shopifyCustomer) {
          // Shopify enriches fields that are missing locally
          customer.name     = customer.name || shopifyCustomer.name;
          customer.phone    = customer.phone || shopifyCustomer.phone;
          customer.location = customer.location || shopifyCustomer.address;
          customer.shopify_orders_count = shopifyCustomer.orders_count;
          customer.shopify_total_spent  = shopifyCustomer.total_spent;
        }
      } catch (err) {
        // Don't fail the whole request if Shopify enrichment fails
        console.error('Shopify customer enrichment error:', err.message);
      }
    }

    res.json({ found: !!rows.length, customer, pastTickets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/customers/:email/notes
router.patch('/:email/notes', requireWorkspace, async (req, res) => {
  try {
    const email  = decodeURIComponent(req.params.email);
    const { notes } = req.body;
    await db.query(
      'UPDATE customers SET notes=? WHERE email=? AND workspace_id=?',
      [notes, email, req.user.workspace_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers
router.post('/', requireWorkspace, async (req, res) => {
  try {
    const { email, name, phone, location, notes } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const wsId = req.user.workspace_id;

    await db.query(
      `INSERT INTO customers (workspace_id, email, name, phone, location, notes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), phone=VALUES(phone), location=VALUES(location), notes=VALUES(notes)`,
      [wsId, email, name || '', phone || null, location || null, notes || null]
    );

    const [rows] = await db.query(
      'SELECT * FROM customers WHERE email=? AND workspace_id=?',
      [email, wsId]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
