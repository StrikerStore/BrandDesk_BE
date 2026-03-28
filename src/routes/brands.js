const express = require('express');
const crypto  = require('crypto');
const db      = require('../config/db');
const { requireWorkspace, requireWorkspaceAdmin } = require('../middleware/authMiddleware');
const { checkPlanLimit } = require('../middleware/planLimits');
const { getLabels } = require('../services/gmail');
const { sendAdminNotification } = require('../services/mailer');

const router = express.Router();

// ── GET /api/brands/gmail-labels — fetch Gmail labels for dropdown ──
router.get('/gmail-labels', requireWorkspace, async (req, res) => {
  try {
    const labels = await getLabels(req.user.workspace_id);
    res.json({ labels });
  } catch (err) {
    console.error('Failed to fetch Gmail labels:', err.message);
    res.status(500).json({ error: 'Failed to fetch Gmail labels. Make sure Gmail is connected.' });
  }
});

// ── GET /api/brands/gmail-accounts — list all connected Gmail accounts ──
router.get('/gmail-accounts', requireWorkspace, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, email FROM gmail_tokens WHERE workspace_id = ? ORDER BY email ASC',
      [req.user.workspace_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/brands — list workspace brands ───────────────────
router.get('/', requireWorkspace, async (req, res) => {
  try {
    const [brands] = await db.query(
      `SELECT b.id, b.label, b.email, b.name, b.category, b.website,
              b.shopify_store, b.gmail_token_id, b.brand_status, b.initial_sync_done,
              b.rejection_reason, b.widget_token,
              (b.shopify_token IS NOT NULL AND b.shopify_token != '') AS shopify_connected,
              b.is_active, b.created_at,
              gt.email AS gmail_email
       FROM brands b
       LEFT JOIN gmail_tokens gt ON gt.id = b.gmail_token_id
       WHERE b.workspace_id = ? AND b.is_active = 1 ORDER BY b.name ASC`,
      [req.user.workspace_id]
    );
    res.json(brands.map(b => ({ ...b, shopify_connected: !!b.shopify_connected })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/brands — create brand (onboarding or admin) ──────
router.post('/', requireWorkspaceAdmin, async (req, res) => {
  try {
    const { name, email, category, website, label, shopify_store, shopify_token } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email required' });
    if (!name?.trim())  return res.status(400).json({ error: 'Brand name required' });

    const widgetToken = crypto.randomBytes(32).toString('hex');
    const [result] = await db.query(
      `INSERT INTO brands (workspace_id, label, email, name, category, website, shopify_store, shopify_token, widget_token, brand_status, initial_sync_done)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0)`,
      [req.user.workspace_id, label?.trim() || null, email.trim(), name.trim(),
       category?.trim() || null, website?.trim() || null,
       shopify_store?.trim() || null, shopify_token?.trim() || null, widgetToken]
    );

    const [rows] = await db.query('SELECT * FROM brands WHERE id = ?', [result.insertId]);

    // Advance onboarding status to details_submitted if still in early stage
    await db.query(
      `UPDATE workspaces SET onboarding_status = 'details_submitted'
       WHERE id = ? AND onboarding_status IN ('not_started', 'details_submitted')`,
      [req.user.workspace_id]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'A brand with that label already exists in this workspace' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/brands/request — request new brand (from Settings) ──
router.post('/request', requireWorkspaceAdmin, checkPlanLimit('brands'), async (req, res) => {
  try {
    const { name, email, category, website } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email required' });
    if (!name?.trim())  return res.status(400).json({ error: 'Brand name required' });

    const widgetToken = crypto.randomBytes(32).toString('hex');
    const [result] = await db.query(
      `INSERT INTO brands (workspace_id, email, name, category, website, widget_token, brand_status, initial_sync_done)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', 0)`,
      [req.user.workspace_id, email.trim(), name.trim(),
       category?.trim() || null, website?.trim() || null, widgetToken]
    );

    const [rows] = await db.query('SELECT * FROM brands WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/brands/:id/link-gmail — link existing Gmail account to brand ──
router.post('/:id/link-gmail', requireWorkspaceAdmin, async (req, res) => {
  try {
    const { gmail_token_id } = req.body;
    if (!gmail_token_id) return res.status(400).json({ error: 'gmail_token_id required' });

    // Verify gmail token belongs to workspace
    const [tokenRows] = await db.query(
      'SELECT id FROM gmail_tokens WHERE id = ? AND workspace_id = ?',
      [gmail_token_id, req.user.workspace_id]
    );
    if (!tokenRows.length) return res.status(404).json({ error: 'Gmail account not found' });

    const [result] = await db.query(
      'UPDATE brands SET gmail_token_id = ? WHERE id = ? AND workspace_id = ?',
      [gmail_token_id, req.params.id, req.user.workspace_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Brand not found' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/brands/:id/mark-synced — mark initial sync complete ──
router.post('/:id/mark-synced', requireWorkspace, async (req, res) => {
  try {
    await db.query(
      'UPDATE brands SET initial_sync_done = 1 WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.user.workspace_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/onboarding/status — current onboarding step ─────
// Mounted at both /api/brands/onboarding/status AND /api/onboarding/status
const onboardingStatusHandler = async (req, res) => {
  try {
    const wsId = req.user.workspace_id;
    const [[ws]] = await db.query('SELECT onboarding_status FROM workspaces WHERE id = ?', [wsId]);

    // Find the draft/pending brand for this workspace (most recent)
    const [brandRows] = await db.query(
      `SELECT b.*, gt.email AS gmail_email,
              (b.shopify_token IS NOT NULL AND b.shopify_token != '') AS shopify_connected
       FROM brands b
       LEFT JOIN gmail_tokens gt ON gt.id = b.gmail_token_id
       WHERE b.workspace_id = ? AND b.is_active = 1 AND b.brand_status IN ('draft','pending_approval','rejected')
       ORDER BY b.id DESC LIMIT 1`,
      [wsId]
    );

    const brand = brandRows[0] || null;

    res.json({
      onboarding_status: ws?.onboarding_status || 'not_started',
      brand: brand ? {
        id: brand.id,
        name: brand.name,
        email: brand.email,
        category: brand.category,
        website: brand.website,
        gmail_token_id: brand.gmail_token_id,
        gmail_email: brand.gmail_email,
        shopify_store: brand.shopify_store,
        shopify_connected: !!brand.shopify_connected,
        brand_status: brand.brand_status,
        rejection_reason: brand.rejection_reason || null,
      } : null,
      gmail_connected: brand ? !!brand.gmail_token_id : false,
      shopify_connected: brand ? !!brand.shopify_connected : false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
router.get('/onboarding/status', requireWorkspaceAdmin, onboardingStatusHandler);
router.get('/status', requireWorkspaceAdmin, onboardingStatusHandler);

// ── POST /api/onboarding/submit — submit for admin review ─────
// Mounted at both /api/brands/onboarding/submit AND /api/onboarding/submit
const onboardingSubmitHandler = async (req, res) => {
  try {
    const wsId = req.user.workspace_id;
    const [[ws]] = await db.query('SELECT onboarding_status FROM workspaces WHERE id = ?', [wsId]);

    if (ws.onboarding_status === 'pending_approval') {
      return res.json({ success: true, status: 'pending_approval' });
    }
    if (ws.onboarding_status === 'approved') {
      return res.status(400).json({ error: 'Workspace is already approved.' });
    }

    // Find the draft brand
    const [brandRows] = await db.query(
      `SELECT id, gmail_token_id, shopify_token FROM brands
       WHERE workspace_id = ? AND is_active = 1 AND brand_status = 'draft'
       ORDER BY id DESC LIMIT 1`,
      [wsId]
    );
    if (!brandRows.length) {
      return res.status(400).json({ error: 'No brand found to submit.' });
    }

    const brand = brandRows[0];
    if (!brand.gmail_token_id) {
      return res.status(400).json({ error: 'Gmail must be connected to the brand before submitting.' });
    }

    // Update brand status and workspace onboarding status
    await db.query("UPDATE brands SET brand_status = 'pending_approval' WHERE id = ?", [brand.id]);
    await db.query("UPDATE workspaces SET onboarding_status = 'pending_approval' WHERE id = ?", [wsId]);

    // Admin alert: onboarding submitted (non-blocking)
    (async () => {
      try {
        const [[wsInfo]] = await db.query('SELECT name FROM workspaces WHERE id = ?', [wsId]);
        const [[brandInfo]] = await db.query('SELECT name, email FROM brands WHERE id = ?', [brand.id]);
        sendAdminNotification({
          subject: `Onboarding Submitted: ${brandInfo?.name || 'Unknown'} — ${wsInfo?.name || 'Workspace #' + wsId}`,
          html: `
            <h2 style="margin:0 0 16px;font-size:18px;color:#111827;">New Onboarding Submission</h2>
            <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px;">A workspace has completed onboarding and is waiting for your approval.</p>
            <table style="border-collapse:collapse;font-size:14px;width:100%;">
              <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Workspace</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${wsInfo?.name || '#' + wsId}</td></tr>
              <tr><td style="padding:8px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">Brand</td><td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;">${brandInfo?.name || '—'}</td></tr>
              <tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Brand Email</td><td style="padding:8px 12px;">${brandInfo?.email || '—'}</td></tr>
            </table>
            <p style="font-size:14px;color:#374151;line-height:1.7;margin:16px 0 0;">
              <a href="${process.env.ADMIN_URL || 'https://admin.branddesk.in'}" style="color:#6366f1;text-decoration:none;font-weight:600;">Go to Admin Panel →</a>
            </p>`,
        }).catch(err => console.error('Onboarding submission admin notification failed:', err.message));
      } catch (err) {
        console.error('Onboarding notification lookup failed:', err.message);
      }
    })();

    res.json({ success: true, status: 'pending_approval' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
router.post('/onboarding/submit', requireWorkspaceAdmin, onboardingSubmitHandler);
router.post('/submit', requireWorkspaceAdmin, onboardingSubmitHandler);

// ── PATCH /api/brands/:id — update brand (user-editable fields only) ──
router.patch('/:id', requireWorkspaceAdmin, async (req, res) => {
  try {
    const { email, name, category, website, shopify_store, shopify_token } = req.body;
    const updates = [];
    const params  = [];

    // Users cannot update: label, brand_status, gmail_token_id (admin-only)
    if (email?.trim())         { updates.push('email = ?');         params.push(email.trim()); }
    if (name?.trim())          { updates.push('name = ?');          params.push(name.trim()); }
    if (category !== undefined) { updates.push('category = ?');     params.push(category?.trim() || null); }
    if (website !== undefined)  { updates.push('website = ?');      params.push(website?.trim() || null); }
    if (shopify_store !== undefined) { updates.push('shopify_store = ?'); params.push(shopify_store?.trim() || null); }
    if (shopify_token !== undefined) { updates.push('shopify_token = ?'); params.push(shopify_token?.trim() || null); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id, req.user.workspace_id);
    const [result] = await db.query(
      `UPDATE brands SET ${updates.join(', ')} WHERE id = ? AND workspace_id = ?`,
      params
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Brand not found' });

    const [rows] = await db.query('SELECT * FROM brands WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/brands/:id/shopify-disconnect — remove Shopify connection ──
router.post('/:id/shopify-disconnect', requireWorkspaceAdmin, async (req, res) => {
  try {
    const [result] = await db.query(
      'UPDATE brands SET shopify_token = NULL WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.user.workspace_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Brand not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/brands/:id — soft delete ─────────────────────
router.delete('/:id', requireWorkspaceAdmin, async (req, res) => {
  try {
    const [result] = await db.query(
      'UPDATE brands SET is_active = 0 WHERE id = ? AND workspace_id = ?',
      [req.params.id, req.user.workspace_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Brand not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
