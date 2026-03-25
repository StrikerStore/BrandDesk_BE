const express = require('express');
const db = require('../config/db');
const { sendAdminNotification } = require('../services/mailer');

const router = express.Router();

// ── POST /api/demo/request — public, no auth required ──
router.post('/request', async (req, res) => {
  try {
    const { brand_name, brand_type, platform, contact_name, contact_email, contact_phone, website, message } = req.body;

    if (!brand_name?.trim() || !contact_name?.trim() || !contact_email?.trim()) {
      return res.status(400).json({ error: 'Brand name, contact name, and email are required' });
    }

    const [result] = await db.query(
      `INSERT INTO demo_requests (brand_name, brand_type, platform, contact_name, contact_email, contact_phone, website, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [brand_name.trim(), brand_type?.trim() || null, platform || 'other',
       contact_name.trim(), contact_email.trim(), contact_phone?.trim() || null,
       website?.trim() || null, message?.trim() || null]
    );

    // Send notification email to admin (non-blocking)
    sendAdminNotification({
      subject: `New Demo Request: ${brand_name.trim()} — ${contact_name.trim()}`,
      html: `
        <h2 style="margin:0 0 16px;font-size:18px;color:#111827;">New Demo Request — #${result.insertId}</h2>
        <table style="border-collapse:collapse;font-size:14px;width:100%;">
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Brand Name</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${brand_name}</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Brand Type</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${brand_type || '—'}</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Platform</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${platform || '—'}</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Contact</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${contact_name} (${contact_email})</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Phone</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${contact_phone || '—'}</td></tr>
          <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Website</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${website || '—'}</td></tr>
          ${message ? `<tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Message</td><td style="padding:8px 12px;">${message}</td></tr>` : ''}
        </table>`,
    }).catch(err => console.error('Demo notification email failed:', err.message));

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
