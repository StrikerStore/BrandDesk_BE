const express = require('express');
const db = require('../config/db');
const { requireWorkspace } = require('../middleware/authMiddleware');
const { sendAdminNotification } = require('../services/mailer');

const router = express.Router();

// All routes require auth (applied in index.js) + workspace context
router.use(requireWorkspace);

// ── GET /api/support/tickets — list tickets for current workspace ──
router.get('/tickets', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT st.*, u.name as user_name, u.email as user_email
       FROM support_tickets st
       LEFT JOIN users u ON u.id = st.user_id
       WHERE st.workspace_id = ?
       ORDER BY st.created_at DESC`,
      [req.user.workspace_id]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/support/tickets — create a new ticket ──
router.post('/tickets', async (req, res) => {
  try {
    const { subject, description, category, priority } = req.body;
    if (!subject?.trim() || !description?.trim()) {
      return res.status(400).json({ error: 'Subject and description are required' });
    }

    const [result] = await db.query(
      `INSERT INTO support_tickets (workspace_id, user_id, subject, description, category, priority)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.workspace_id, req.user.id, subject.trim(), description.trim(),
       category || 'general', priority || 'medium']
    );

    const [[ticket]] = await db.query('SELECT * FROM support_tickets WHERE id = ?', [result.insertId]);

    // Admin alert: new support ticket (non-blocking)
    sendAdminNotification({
      subject: `New Support Ticket: #${result.insertId} ${subject.trim()}`,
      html: `
        <h2 style="margin:0 0 16px;font-size:18px;color:#111827;">New Support Ticket — #${result.insertId}</h2>
        <table style="border-collapse:collapse;font-size:14px;width:100%;">
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Subject</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${subject.trim()}</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Category</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${category || 'general'}</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Priority</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${priority || 'medium'}</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">User</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${req.user.name || 'Unknown'} (${req.user.email || '—'})</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Description</td><td style="padding:8px 12px;">${description.trim().substring(0, 500)}</td></tr>
        </table>`,
    }).catch(err => console.error('Support ticket admin notification failed:', err.message));

    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/support/tickets/:id — get ticket with replies ──
router.get('/tickets/:id', async (req, res) => {
  try {
    const [[ticket]] = await db.query(
      `SELECT st.*, u.name as user_name, u.email as user_email
       FROM support_tickets st
       LEFT JOIN users u ON u.id = st.user_id
       WHERE st.id = ? AND st.workspace_id = ?`,
      [req.params.id, req.user.workspace_id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const [replies] = await db.query(
      `SELECT r.*, u.name as user_name, u.email as user_email
       FROM support_ticket_replies r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.ticket_id = ?
       ORDER BY r.created_at ASC`,
      [req.params.id]
    );

    res.json({ ticket, replies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/support/tickets/:id/reply — add reply to ticket ──
router.post('/tickets/:id/reply', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    // Verify ticket belongs to this workspace
    const [[ticket]] = await db.query(
      'SELECT id FROM support_tickets WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.user.workspace_id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const [result] = await db.query(
      `INSERT INTO support_ticket_replies (ticket_id, user_id, is_admin, message)
       VALUES (?, ?, 0, ?)`,
      [req.params.id, req.user.id, message.trim()]
    );

    const [[reply]] = await db.query(
      `SELECT r.*, u.name as user_name, u.email as user_email
       FROM support_ticket_replies r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.id = ?`,
      [result.insertId]
    );

    res.json(reply);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
