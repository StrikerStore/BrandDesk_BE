const express = require('express');
const db      = require('../config/db');
const { PLAN_LIMITS } = require('../middleware/planLimits');
const { sendWidgetEmail } = require('../services/mailer');

const router = express.Router();

// ── Helper: Resolve brand by shop domain + widget_token ──────
async function resolveBrand(shop, widgetToken) {
  if (!shop || !widgetToken) return null;

  const [brands] = await db.query(
    `SELECT b.id, b.workspace_id, b.label, b.email, b.name
     FROM brands b
     WHERE b.widget_token = ? AND b.is_active = 1`,
    [widgetToken]
  );

  return brands[0] || null;
}

// ══════════════════════════════════════════════════════════════════════
//  POST /api/widget/ticket — Create support ticket from storefront
// ══════════════════════════════════════════════════════════════════════
router.post('/ticket', async (req, res) => {
  try {
    const { shop, brand_token, name, email, phone, order_number, issue_category, sub_issue, message } = req.body;

    if (!email || !message) {
      return res.status(400).json({ error: 'Email and message are required' });
    }

    const brand = await resolveBrand(shop, brand_token);
    if (!brand) {
      return res.status(401).json({ error: 'Invalid widget credentials' });
    }

    // Check thread limit
    const [wsRow] = await db.query('SELECT plan FROM workspaces WHERE id = ?', [brand.workspace_id]);
    const plan = wsRow[0]?.plan || 'trial';
    const threadLimit = PLAN_LIMITS[plan]?.threads_per_month;
    if (threadLimit !== undefined && threadLimit !== Infinity) {
      const [countRow] = await db.query(
        `SELECT COUNT(*) as cnt FROM threads WHERE workspace_id = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
        [brand.workspace_id]
      );
      if (countRow[0].cnt >= threadLimit) {
        return res.status(402).json({
          error: `Monthly thread limit reached (${threadLimit} threads). Please upgrade your plan.`,
          upgrade: true, resource: 'threads_per_month', limit: threadLimit, current: countRow[0].cnt,
        });
      }
    }

    // Generate a ticket ID
    const ticketId = `WDG-${Date.now().toString(36).toUpperCase()}`;

    // Send structured email to brand owner's Gmail instead of direct DB insert.
    // Gmail sync will pick it up via label, emailParser will extract all fields.
    await sendWidgetEmail({
      to:            brand.email,
      replyTo:       email.trim(),
      brandName:     brand.name,
      ticketId,
      customerName:  name || null,
      customerEmail: email.toLowerCase().trim(),
      customerPhone: phone || null,
      orderNumber:   order_number || null,
      issueCategory: issue_category || null,
      subIssue:      sub_issue || null,
      message,
    });

    res.status(201).json({
      success: true,
      ticket_id: ticketId,
      message: 'Your ticket has been submitted. We will get back to you shortly.',
    });
  } catch (err) {
    console.error('Widget ticket creation error:', err.message);
    res.status(500).json({ error: 'Failed to submit ticket' });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  GET /api/widget/track — Track existing ticket(s)
// ══════════════════════════════════════════════════════════════════════
router.get('/track', async (req, res) => {
  try {
    const { shop, brand_token, email, ticket_id } = req.query;

    const brand = await resolveBrand(shop, brand_token);
    if (!brand) {
      return res.status(401).json({ error: 'Invalid widget credentials' });
    }

    const conditions = ['t.workspace_id = ?', 't.brand = ?'];
    const params = [brand.workspace_id, brand.label];

    if (ticket_id) {
      conditions.push('t.ticket_id = ?');
      params.push(ticket_id);
    } else if (email) {
      conditions.push('t.customer_email = ?');
      params.push(email.toLowerCase().trim());
    } else {
      return res.status(400).json({ error: 'Provide email or ticket_id' });
    }

    const [tickets] = await db.query(
      `SELECT t.id, t.ticket_id, t.subject, t.status, t.customer_email,
              t.created_at, t.updated_at
       FROM threads t
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.created_at DESC
       LIMIT 10`,
      params
    );

    // For each ticket, get last 5 messages (public replies only)
    const results = [];
    for (const ticket of tickets) {
      const [messages] = await db.query(
        `SELECT from_email, body, sent_at, direction
         FROM messages
         WHERE thread_id = ?
         ORDER BY sent_at ASC
         LIMIT 10`,
        [ticket.id]
      );

      results.push({
        ticket_id: ticket.ticket_id,
        subject: ticket.subject,
        status: ticket.status,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
        messages: messages.map(m => ({
          from: m.direction === 'inbound' ? 'you' : 'support',
          message: m.body?.substring(0, 500) || '',
          date: m.sent_at,
        })),
      });
    }

    res.json({ tickets: results });
  } catch (err) {
    console.error('Widget track error:', err.message);
    res.status(500).json({ error: 'Failed to track ticket' });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  GET /api/widget/config — Widget configuration for a brand
// ══════════════════════════════════════════════════════════════════════
router.get('/config', async (req, res) => {
  try {
    const { shop, brand_token } = req.query;

    const brand = await resolveBrand(shop, brand_token);
    if (!brand) {
      return res.status(401).json({ error: 'Invalid widget credentials' });
    }

    res.json({
      brand_name: brand.name,
      support_email: brand.email,
      issue_categories: [
        'Order Issue',
        'Shipping & Delivery',
        'Returns & Refund',
        'Product Inquiry',
        'Payment Issue',
        'Other',
      ],
      sub_categories: {
        'Order Issue':          ['Wrong Item Received', 'Missing Item', 'Order Not Received', 'Cancel Order', 'Modify Order', 'Other'],
        'Shipping & Delivery':  ['Delayed Delivery', 'Tracking Not Updated', 'Damaged in Transit', 'Wrong Address', 'Other'],
        'Returns & Refund':     ['Initiate Return', 'Refund Status', 'Exchange Request', 'Return Pickup Issue', 'Other'],
        'Product Inquiry':      ['Size Guide', 'Product Availability', 'Product Quality', 'Other'],
        'Payment Issue':        ['Payment Failed', 'Double Charged', 'Refund Not Received', 'COD Issue', 'Other'],
        'Other':                ['General Query', 'Feedback', 'Complaint', 'Other'],
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load config' });
  }
});

module.exports = router;
