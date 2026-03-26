const express = require('express');
const db = require('../config/db');
const { generateToken } = require('../middleware/authMiddleware');
const { syncThreads } = require('../services/gmail');
const { sendUserEmail } = require('../services/mailer');

const router = express.Router();

// All routes here are protected by requireAdmin (applied in index.js)

// ══════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════════════════

router.get('/dashboard', async (req, res) => {
  try {
    const [[wsStats]] = await db.query(
      'SELECT COUNT(*) as total, SUM(is_active) as active FROM workspaces'
    );
    const [[userStats]] = await db.query(
      'SELECT COUNT(*) as total, SUM(is_active) as active FROM users'
    );
    const [[threadStats]] = await db.query('SELECT COUNT(*) as total FROM threads');

    const [planDist] = await db.query(
      'SELECT plan, COUNT(*) as count FROM workspaces WHERE is_active = 1 GROUP BY plan'
    );

    // MRR: monthly subs at face value + yearly subs divided by 12
    let mrr = 0;
    let totalRevenue = 0;
    try {
      const [[mrrResult]] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN billing_cycle='monthly' THEN amount ELSE amount/12 END), 0) as mrr
         FROM subscriptions WHERE status = 'active'`
      );
      mrr = parseFloat(mrrResult.mrr) || 0;

      const [[revResult]] = await db.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM payment_transactions WHERE status = 'success'`
      );
      totalRevenue = parseFloat(revResult.total) || 0;
    } catch { /* subscriptions table may not exist yet */ }

    // Signups last 30 days
    const [signups] = await db.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`
    );

    res.json({
      totalWorkspaces: wsStats.total,
      activeWorkspaces: parseInt(wsStats.active) || 0,
      totalUsers: userStats.total,
      activeUsers: parseInt(userStats.active) || 0,
      totalThreads: threadStats.total,
      mrr,
      totalRevenue,
      planDistribution: planDist,
      recentSignups: signups,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  WORKSPACES
// ══════════════════════════════════════════════════════════════════════

router.get('/workspaces', async (req, res) => {
  try {
    const { search, plan, status, onboarding_status, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(w.name LIKE ? OR w.slug LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (plan) { conditions.push('w.plan = ?'); params.push(plan); }
    if (status === 'active') conditions.push('w.is_active = 1');
    else if (status === 'inactive') conditions.push('w.is_active = 0');
    if (onboarding_status) { conditions.push('w.onboarding_status = ?'); params.push(onboarding_status); }

    // Filter by workspaces that have brands with a specific brand_status
    const { brand_status } = req.query;
    let brandJoin = '';
    if (brand_status) {
      brandJoin = 'INNER JOIN brands br ON br.workspace_id = w.id AND br.brand_status = ? AND br.is_active = 1';
      params.unshift(brand_status);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await db.query(
      `SELECT COUNT(DISTINCT w.id) as total FROM workspaces w ${brandJoin} LEFT JOIN users u ON u.id = w.owner_user_id ${where}`,
      params
    );

    const [rows] = await db.query(
      `SELECT DISTINCT w.*, u.name as owner_name, u.email as owner_email,
        (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) as member_count,
        (SELECT COUNT(*) FROM brands b WHERE b.workspace_id = w.id AND b.is_active = 1) as brand_count,
        (SELECT COUNT(*) FROM threads t WHERE t.workspace_id = w.id) as thread_count,
        (SELECT COUNT(*) FROM brands bp WHERE bp.workspace_id = w.id AND bp.brand_status = 'pending_approval' AND bp.is_active = 1) as pending_brand_count
       FROM workspaces w
       ${brandJoin}
       LEFT JOIN users u ON u.id = w.owner_user_id
       ${where}
       ORDER BY w.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/workspaces/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const [[workspace]] = await db.query(
      `SELECT w.*, u.name as owner_name, u.email as owner_email
       FROM workspaces w LEFT JOIN users u ON u.id = w.owner_user_id
       WHERE w.id = ?`, [id]
    );
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const [members] = await db.query(
      `SELECT wm.role, u.id as user_id, u.name, u.email, u.is_active, wm.created_at as joined_at
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ?`, [id]
    );

    const [brands] = await db.query(
      `SELECT b.id, b.label, b.email, b.name, b.category, b.website,
              b.shopify_store, b.gmail_token_id, b.brand_status, b.initial_sync_done,
              (b.shopify_token IS NOT NULL AND b.shopify_token != '') as shopify_connected,
              b.is_active, b.created_at,
              gt.email AS gmail_email
       FROM brands b
       LEFT JOIN gmail_tokens gt ON gt.id = b.gmail_token_id
       WHERE b.workspace_id = ?`, [id]
    );

    const [gmailTokens] = await db.query(
      'SELECT id, email, updated_at FROM gmail_tokens WHERE workspace_id = ?', [id]
    );

    let subscription = null;
    try {
      const [subs] = await db.query(
        'SELECT * FROM subscriptions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1', [id]
      );
      subscription = subs[0] || null;
    } catch { /* table may not exist */ }

    const [threads] = await db.query(
      `SELECT id, subject, customer_email, status, priority, brand, created_at
       FROM threads WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`, [id]
    );

    res.json({
      workspace,
      members,
      brands: brands.map(b => ({ ...b, shopify_connected: !!b.shopify_connected })),
      gmail: gmailTokens[0] || null,
      gmailAccounts: gmailTokens,
      subscription,
      recentThreads: threads,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/workspaces/:id/suspend', async (req, res) => {
  try {
    await db.query('UPDATE workspaces SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/workspaces/:id/reactivate', async (req, res) => {
  try {
    await db.query('UPDATE workspaces SET is_active = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/workspaces/:id/approve', async (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'Gmail label is required to approve.' });
  const wsId = req.params.id;
  try {
    const [[ws]] = await db.query('SELECT id, onboarding_status FROM workspaces WHERE id = ?', [wsId]);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    if (ws.onboarding_status === 'approved') return res.json({ success: true, already: true });

    const [brands] = await db.query(
      'SELECT id FROM brands WHERE workspace_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1', [wsId]
    );

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      if (brands.length) {
        await conn.query('UPDATE brands SET label = ? WHERE id = ?', [label.trim(), brands[0].id]);
      }
      await conn.query(
        "UPDATE workspaces SET onboarding_status = 'approved', is_active = 1 WHERE id = ?", [wsId]
      );
      await conn.commit();
      res.json({ success: true });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/workspaces/:id/plan', async (req, res) => {
  try {
    const { plan, trial_ends_at } = req.body;
    const updates = [];
    const params = [];
    if (plan) { updates.push('plan = ?'); params.push(plan); }
    if (trial_ends_at) { updates.push('trial_ends_at = ?'); params.push(trial_ends_at); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await db.query(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════════════════════════════════

router.get('/users', async (req, res) => {
  try {
    const { search, role, status, brand_name, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(u.name LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (role) { conditions.push('u.role = ?'); params.push(role); }
    if (status === 'active') conditions.push('u.is_active = 1');
    else if (status === 'inactive') conditions.push('u.is_active = 0');

    // Brand filter: find users who belong to workspaces that have a matching brand
    let brandJoin = '';
    if (brand_name) {
      brandJoin = `INNER JOIN workspace_members wm_brand ON wm_brand.user_id = u.id
                   INNER JOIN brands b_filter ON b_filter.workspace_id = wm_brand.workspace_id AND b_filter.name = ? AND b_filter.is_active = 1`;
      params.unshift(brand_name);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await db.query(
      `SELECT COUNT(DISTINCT u.id) as total FROM users u ${brandJoin} ${where}`,
      params
    );

    const [rows] = await db.query(
      `SELECT DISTINCT u.id, u.name, u.email, u.role, u.is_active, u.avatar_url, u.created_at,
        (SELECT COUNT(*) FROM workspace_members wm WHERE wm.user_id = u.id) as workspace_count
       FROM users u ${brandJoin} ${where}
       ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // For each user, get their brands
    for (const user of rows) {
      const [brands] = await db.query(
        `SELECT DISTINCT b.name FROM brands b
         INNER JOIN workspace_members wm ON wm.workspace_id = b.workspace_id
         WHERE wm.user_id = ? AND b.is_active = 1
         ORDER BY b.name ASC`,
        [user.id]
      );
      user.brands = brands.map(b => b.name);
    }

    // Also return all brand names for the filter dropdown
    const [allBrands] = await db.query(
      'SELECT DISTINCT name FROM brands WHERE is_active = 1 ORDER BY name ASC'
    );

    res.json({
      data: rows,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      brands: allBrands.map(b => b.name),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/users/:id/deactivate', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [req.params.id]);
    if (rows.length && rows[0].role === 'admin') {
      return res.status(403).json({ error: 'Cannot deactivate an admin user' });
    }
    await db.query('UPDATE users SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/users/:id/reactivate', async (req, res) => {
  try {
    await db.query('UPDATE users SET is_active = 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    if (rows[0].role === 'admin') {
      return res.status(403).json({ error: 'Cannot delete an admin user' });
    }
    await db.query('DELETE FROM workspace_members WHERE user_id = ?', [req.params.id]);
    await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  SUBSCRIPTIONS & TRANSACTIONS
// ══════════════════════════════════════════════════════════════════════

router.get('/subscriptions', async (req, res) => {
  try {
    const { status: subStatus, plan, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (subStatus) { conditions.push('s.status = ?'); params.push(subStatus); }
    if (plan) { conditions.push('s.plan = ?'); params.push(plan); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM subscriptions s ${where}`, params);

    const [rows] = await db.query(
      `SELECT s.*, w.name as workspace_name, w.slug as workspace_slug
       FROM subscriptions s
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       ${where}
       ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // Revenue summary
    const [[revenue]] = await db.query(
      `SELECT
        COUNT(CASE WHEN status='active' THEN 1 END) as active_count,
        COUNT(CASE WHEN status='active' AND plan='starter' THEN 1 END) as starter_count,
        COUNT(CASE WHEN status='active' AND plan='pro' THEN 1 END) as pro_count,
        COALESCE(SUM(CASE WHEN status='active' AND billing_cycle='monthly' THEN amount
                          WHEN status='active' AND billing_cycle='yearly' THEN amount/12 ELSE 0 END), 0) as mrr
       FROM subscriptions`
    );

    res.json({
      data: rows, total, page: parseInt(page), limit: parseInt(limit),
      revenue: {
        activeSubs: revenue.active_count,
        starterCount: revenue.starter_count,
        proCount: revenue.pro_count,
        mrr: parseFloat(revenue.mrr) || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/transactions', async (req, res) => {
  try {
    const { status: txStatus, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (txStatus) { conditions.push('pt.status = ?'); params.push(txStatus); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM payment_transactions pt ${where}`, params);

    const [rows] = await db.query(
      `SELECT pt.*, w.name as workspace_name
       FROM payment_transactions pt
       LEFT JOIN workspaces w ON w.id = pt.workspace_id
       ${where}
       ORDER BY pt.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/subscriptions/:id/extend-trial', async (req, res) => {
  try {
    const { trial_ends_at } = req.body;
    if (!trial_ends_at) return res.status(400).json({ error: 'trial_ends_at required' });

    const [sub] = await db.query('SELECT workspace_id FROM subscriptions WHERE id = ?', [req.params.id]);
    if (!sub.length) return res.status(404).json({ error: 'Subscription not found' });

    await db.query('UPDATE workspaces SET trial_ends_at = ? WHERE id = ?', [trial_ends_at, sub[0].workspace_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/subscriptions/:id/change-plan', async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['trial', 'starter', 'pro'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

    const [sub] = await db.query('SELECT workspace_id FROM subscriptions WHERE id = ?', [req.params.id]);
    if (!sub.length) return res.status(404).json({ error: 'Subscription not found' });

    await db.query('UPDATE subscriptions SET plan = ? WHERE id = ?', [plan, req.params.id]);
    await db.query('UPDATE workspaces SET plan = ? WHERE id = ?', [plan, sub[0].workspace_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/subscriptions/:id/cancel', async (req, res) => {
  try {
    await db.query(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  COUPONS
// ══════════════════════════════════════════════════════════════════════

router.get('/coupons', async (req, res) => {
  try {
    const { search, status, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (search) { conditions.push('code LIKE ?'); params.push(`%${search}%`); }
    if (status === 'active') conditions.push('is_active = 1');
    else if (status === 'inactive') conditions.push('is_active = 0');

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM coupons ${where}`, params);

    const [rows] = await db.query(
      `SELECT * FROM coupons ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/coupons', async (req, res) => {
  try {
    const { code, discount_type = 'percent', discount_value, min_plan, max_uses, valid_from, valid_until } = req.body;

    if (!code || !discount_value) {
      return res.status(400).json({ error: 'Code and discount_value are required' });
    }
    if (!['percent', 'fixed'].includes(discount_type)) {
      return res.status(400).json({ error: 'discount_type must be percent or fixed' });
    }
    if (discount_type === 'percent' && (discount_value < 1 || discount_value > 100)) {
      return res.status(400).json({ error: 'Percent discount must be between 1 and 100' });
    }

    const [result] = await db.query(
      `INSERT INTO coupons (code, discount_type, discount_value, min_plan, max_uses, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [code.trim().toUpperCase(), discount_type, discount_value, min_plan || null, max_uses || null, valid_from || null, valid_until || null]
    );

    res.json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Coupon code already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/coupons/:id', async (req, res) => {
  try {
    const { code, discount_type, discount_value, min_plan, max_uses, valid_from, valid_until, is_active } = req.body;
    const updates = [];
    const params = [];

    if (code !== undefined) { updates.push('code = ?'); params.push(code.trim().toUpperCase()); }
    if (discount_type !== undefined) { updates.push('discount_type = ?'); params.push(discount_type); }
    if (discount_value !== undefined) { updates.push('discount_value = ?'); params.push(discount_value); }
    if (min_plan !== undefined) { updates.push('min_plan = ?'); params.push(min_plan || null); }
    if (max_uses !== undefined) { updates.push('max_uses = ?'); params.push(max_uses || null); }
    if (valid_from !== undefined) { updates.push('valid_from = ?'); params.push(valid_from || null); }
    if (valid_until !== undefined) { updates.push('valid_until = ?'); params.push(valid_until || null); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await db.query(`UPDATE coupons SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Coupon code already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/coupons/:id', async (req, res) => {
  try {
    // Check if coupon has been used
    const [[{ usage }]] = await db.query('SELECT COUNT(*) as usage FROM coupon_usage WHERE coupon_id = ?', [req.params.id]);
    if (usage > 0) {
      // Soft delete — deactivate instead
      await db.query('UPDATE coupons SET is_active = 0 WHERE id = ?', [req.params.id]);
    } else {
      await db.query('DELETE FROM coupons WHERE id = ?', [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/coupons/:id/usage', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT cu.*, w.name as workspace_name
       FROM coupon_usage cu
       LEFT JOIN workspaces w ON w.id = cu.workspace_id
       WHERE cu.coupon_id = ?
       ORDER BY cu.created_at DESC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  SUPPORT TOOLS
// ══════════════════════════════════════════════════════════════════════

router.post('/impersonate/:userId', async (req, res) => {
  try {
    const [users] = await db.query('SELECT * FROM users WHERE id = ? AND is_active = 1', [req.params.userId]);
    if (!users.length) return res.status(404).json({ error: 'User not found' });

    const targetUser = users[0];

    // Find their first workspace
    const [members] = await db.query(
      `SELECT wm.workspace_id, wm.role as workspace_role
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = ? AND w.is_active = 1
       ORDER BY wm.workspace_id ASC LIMIT 1`,
      [targetUser.id]
    );

    if (!members.length) return res.status(400).json({ error: 'User has no active workspace' });

    const ws = members[0];
    const token = generateToken(targetUser, ws.workspace_id, ws.workspace_role);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.json({
      token,
      url: `${frontendUrl}?token=${token}`,
      user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
      workspace_id: ws.workspace_id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/workspaces/:id/sync', async (req, res) => {
  try {
    const result = await syncThreads(parseInt(req.params.id), true);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/workspaces/:id/reset-gmail', async (req, res) => {
  try {
    await db.query('DELETE FROM gmail_tokens WHERE workspace_id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/brands/:brandId/reset-shopify', async (req, res) => {
  try {
    await db.query('UPDATE brands SET shopify_token = NULL WHERE id = ?', [req.params.brandId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Brand-level approval ──
router.patch('/brands/:brandId/approve', async (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'Gmail label is required to approve.' });

  try {
    const [[brand]] = await db.query(
      'SELECT id, workspace_id, brand_status FROM brands WHERE id = ?',
      [req.params.brandId]
    );
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (brand.brand_status === 'approved') return res.json({ success: true, already: true });
    if (!['draft', 'pending_approval'].includes(brand.brand_status)) {
      return res.status(400).json({ error: `Brand is in "${brand.brand_status}" state. Only draft or pending_approval brands can be approved.` });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Approve the brand with label
      await conn.query(
        "UPDATE brands SET label = ?, brand_status = 'approved', initial_sync_done = 0 WHERE id = ?",
        [label.trim(), brand.id]
      );

      // If this is the first approved brand, also approve the workspace
      const [[{ approvedCount }]] = await conn.query(
        "SELECT COUNT(*) as approvedCount FROM brands WHERE workspace_id = ? AND brand_status = 'approved' AND is_active = 1",
        [brand.workspace_id]
      );
      // approvedCount includes the just-approved brand since we already updated it
      if (approvedCount === 1) {
        await conn.query(
          "UPDATE workspaces SET onboarding_status = 'approved', is_active = 1 WHERE id = ?",
          [brand.workspace_id]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // Send approval email to workspace owner (non-blocking)
    (async () => {
      try {
        const [[owner]] = await db.query(
          `SELECT u.email, u.name FROM users u
           JOIN workspaces w ON w.owner_user_id = u.id
           WHERE w.id = ?`, [brand.workspace_id]
        );
        if (owner?.email) {
          const [[brandInfo]] = await db.query('SELECT name FROM brands WHERE id = ?', [brand.id]);
          const frontendUrl = process.env.FRONTEND_URL || 'https://www.branddesk.in';
          sendUserEmail({
            to: owner.email,
            subject: 'Your brand has been approved!',
            html: `
              <h2 style="margin:0 0 12px;font-size:20px;color:#111827;">Great news! \u2705</h2>
              <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px;">
                Your brand <strong>${brandInfo?.name || 'your brand'}</strong> has been approved and is now active on BrandDesk.
              </p>
              <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 24px;">
                We're now syncing your emails. You can start managing customer conversations from your inbox.
              </p>
              <a href="${frontendUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Open your inbox \u2192</a>`,
          }).catch(err => console.error('Brand approval email failed:', err.message));
        }
      } catch (err) {
        console.error('Brand approval email lookup failed:', err.message);
      }
    })();

    // Trigger initial sync for this brand (async, don't block response)
    syncThreads(brand.workspace_id, true, brand.id).catch(err => {
      console.error(`Initial sync failed for brand ${brand.id}:`, err.message);
    });

    // Mark sync done after a delay (sync runs async)
    setTimeout(async () => {
      try {
        await db.query('UPDATE brands SET initial_sync_done = 1 WHERE id = ?', [brand.id]);
      } catch {}
    }, 60000); // 60s timeout to mark sync done

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Brand-level rejection ──
router.patch('/brands/:brandId/reject', async (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required.' });

  try {
    const [[brand]] = await db.query(
      'SELECT id, workspace_id, brand_status, name FROM brands WHERE id = ?',
      [req.params.brandId]
    );
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (!['draft', 'pending_approval'].includes(brand.brand_status)) {
      return res.status(400).json({ error: `Brand is in "${brand.brand_status}" state. Only draft or pending_approval brands can be rejected.` });
    }

    await db.query(
      "UPDATE brands SET brand_status = 'rejected', rejection_reason = ? WHERE id = ?",
      [reason.trim(), brand.id]
    );

    // Send rejection email to workspace owner (non-blocking)
    (async () => {
      try {
        const [[owner]] = await db.query(
          `SELECT u.email, u.name FROM users u
           JOIN workspaces w ON w.owner_user_id = u.id
           WHERE w.id = ?`, [brand.workspace_id]
        );
        if (owner?.email) {
          sendUserEmail({
            to: owner.email,
            subject: 'Update on your brand request',
            html: `
              <h2 style="margin:0 0 12px;font-size:20px;color:#111827;">Brand Review Update</h2>
              <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px;">
                Unfortunately, your brand <strong>${brand.name}</strong> could not be approved at this time.
              </p>
              <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:0 0 24px;">
                <p style="margin:0;font-size:14px;color:#991b1b;"><strong>Reason:</strong> ${reason.trim()}</p>
              </div>
              <p style="font-size:14px;color:#374151;line-height:1.7;margin:0;">
                You can update your brand details and resubmit for review. If you have questions, contact us at support@branddesk.in.
              </p>`,
          }).catch(err => console.error('Brand rejection email failed:', err.message));
        }
      } catch (err) {
        console.error('Brand rejection email lookup failed:', err.message);
      }
    })();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/brands/:brandId/label', async (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'Label is required' });
  try {
    await db.query('UPDATE brands SET label = ? WHERE id = ?', [label.trim(), req.params.brandId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  DESTRUCTIVE DATA DELETION
// ══════════════════════════════════════════════════════════════════════

// POST /api/admin/brands/:brandId/delete-data — permanently delete brand and its data
router.post('/brands/:brandId/delete-data', async (req, res) => {
  const { confirm_text } = req.body;
  const brandId = req.params.brandId;

  try {
    const [[brand]] = await db.query('SELECT id, name, workspace_id FROM brands WHERE id = ?', [brandId]);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const expectedText = `DELETE ${brand.name}`;
    if (confirm_text !== expectedText) {
      return res.status(400).json({ error: `Please type "${expectedText}" to confirm.` });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Get thread IDs for this brand to delete messages & attachments
      const [threads] = await conn.query(
        'SELECT id FROM threads WHERE workspace_id = ? AND brand = ?',
        [brand.workspace_id, brand.name]
      );
      const threadIds = threads.map(t => t.id);

      if (threadIds.length > 0) {
        // Delete attachments for these threads
        await conn.query(
          `DELETE FROM attachments WHERE thread_id IN (${threadIds.map(() => '?').join(',')})`,
          threadIds
        );
        // Delete messages for these threads
        await conn.query(
          `DELETE FROM messages WHERE thread_id IN (${threadIds.map(() => '?').join(',')})`,
          threadIds
        );
        // Delete threads
        await conn.query(
          `DELETE FROM threads WHERE id IN (${threadIds.map(() => '?').join(',')})`,
          threadIds
        );
      }

      // Delete the brand itself
      await conn.query('DELETE FROM brands WHERE id = ?', [brandId]);

      await conn.commit();
      res.json({ success: true, deleted: { threads: threadIds.length, brand: brand.name } });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/workspaces/:id/delete-data — permanently delete workspace and ALL its data
router.post('/workspaces/:id/delete-data', async (req, res) => {
  const { confirm_text } = req.body;
  const wsId = req.params.id;

  try {
    const [[ws]] = await db.query('SELECT id, name FROM workspaces WHERE id = ?', [wsId]);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });

    const expectedText = `DELETE ${ws.name}`;
    if (confirm_text !== expectedText) {
      return res.status(400).json({ error: `Please type "${expectedText}" to confirm.` });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Get all thread IDs for this workspace
      const [threads] = await conn.query('SELECT id FROM threads WHERE workspace_id = ?', [wsId]);
      const threadIds = threads.map(t => t.id);

      if (threadIds.length > 0) {
        // Delete in batches of 1000 to avoid query size limits
        for (let i = 0; i < threadIds.length; i += 1000) {
          const batch = threadIds.slice(i, i + 1000);
          const placeholders = batch.map(() => '?').join(',');
          await conn.query(`DELETE FROM attachments WHERE thread_id IN (${placeholders})`, batch);
          await conn.query(`DELETE FROM messages WHERE thread_id IN (${placeholders})`, batch);
          await conn.query(`DELETE FROM threads WHERE id IN (${placeholders})`, batch);
        }
      }

      // Delete all workspace-scoped data
      await conn.query('DELETE FROM customers WHERE workspace_id = ?', [wsId]);
      await conn.query('DELETE FROM templates WHERE workspace_id = ?', [wsId]);
      await conn.query('DELETE FROM saved_views WHERE workspace_id = ?', [wsId]);
      await conn.query('DELETE FROM settings WHERE workspace_id = ?', [wsId]);
      await conn.query('DELETE FROM brands WHERE workspace_id = ?', [wsId]);
      await conn.query('DELETE FROM gmail_tokens WHERE workspace_id = ?', [wsId]);

      // Delete billing data
      try {
        await conn.query('DELETE FROM payment_transactions WHERE workspace_id = ?', [wsId]);
        await conn.query('DELETE FROM subscriptions WHERE workspace_id = ?', [wsId]);
        await conn.query('DELETE FROM coupon_usage WHERE workspace_id = ?', [wsId]);
      } catch { /* tables may not exist */ }

      // Delete workspace members (but keep user accounts intact)
      await conn.query('DELETE FROM workspace_members WHERE workspace_id = ?', [wsId]);

      // Finally delete the workspace
      await conn.query('DELETE FROM workspaces WHERE id = ?', [wsId]);

      await conn.commit();
      res.json({ success: true, deleted: { workspace: ws.name, threads: threadIds.length } });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  PLANS MANAGEMENT
// ══════════════════════════════════════════════════════════════════════

const { clearPlanCache } = require('../middleware/planLimits');

// ── GET /api/admin/plans ─────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const [plans] = await db.query('SELECT * FROM plans ORDER BY sort_order, id');
    res.json({ data: plans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/plans ────────────────────────────────────────
router.post('/plans', async (req, res) => {
  try {
    const { name, display_name, description, sort_order, max_brands, max_members, max_threads_per_month, max_templates, price_monthly, price_yearly } = req.body;
    if (!name?.trim() || !display_name?.trim()) {
      return res.status(400).json({ error: 'Name and display name are required' });
    }

    const [result] = await db.query(
      `INSERT INTO plans (name, display_name, description, sort_order, max_brands, max_members, max_threads_per_month, max_templates, price_monthly, price_yearly)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim().toLowerCase(), display_name.trim(), description || null, sort_order || 0,
       max_brands ?? null, max_members ?? null, max_threads_per_month ?? null, max_templates ?? null,
       price_monthly || 0, price_yearly || 0]
    );

    clearPlanCache();
    const [rows] = await db.query('SELECT * FROM plans WHERE id = ?', [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'A plan with this name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/plans/:id ───────────────────────────────────
router.patch('/plans/:id', async (req, res) => {
  try {
    const { display_name, description, sort_order, max_brands, max_members, max_threads_per_month, max_templates, price_monthly, price_yearly, is_active } = req.body;

    const updates = [];
    const params = [];

    if (display_name !== undefined)          { updates.push('display_name = ?');          params.push(display_name); }
    if (description !== undefined)           { updates.push('description = ?');           params.push(description || null); }
    if (sort_order !== undefined)            { updates.push('sort_order = ?');            params.push(sort_order); }
    if (max_brands !== undefined)            { updates.push('max_brands = ?');            params.push(max_brands === '' || max_brands === null ? null : max_brands); }
    if (max_members !== undefined)           { updates.push('max_members = ?');           params.push(max_members === '' || max_members === null ? null : max_members); }
    if (max_threads_per_month !== undefined) { updates.push('max_threads_per_month = ?'); params.push(max_threads_per_month === '' || max_threads_per_month === null ? null : max_threads_per_month); }
    if (max_templates !== undefined)         { updates.push('max_templates = ?');         params.push(max_templates === '' || max_templates === null ? null : max_templates); }
    if (price_monthly !== undefined)         { updates.push('price_monthly = ?');         params.push(price_monthly || 0); }
    if (price_yearly !== undefined)          { updates.push('price_yearly = ?');          params.push(price_yearly || 0); }
    if (is_active !== undefined)             { updates.push('is_active = ?');             params.push(is_active ? 1 : 0); }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    await db.query(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`, params);

    clearPlanCache();
    const [rows] = await db.query('SELECT * FROM plans WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/plans/:id ──────────────────────────────────
router.delete('/plans/:id', async (req, res) => {
  try {
    // Don't allow deleting plans that are in use
    const [plan] = await db.query('SELECT name FROM plans WHERE id = ?', [req.params.id]);
    if (!plan.length) return res.status(404).json({ error: 'Plan not found' });

    const [inUse] = await db.query('SELECT COUNT(*) as cnt FROM workspaces WHERE plan = ?', [plan[0].name]);
    if (inUse[0].cnt > 0) {
      return res.status(400).json({ error: `Cannot delete — ${inUse[0].cnt} workspace(s) are on this plan. Deactivate it instead.` });
    }

    await db.query('DELETE FROM plans WHERE id = ?', [req.params.id]);
    clearPlanCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  DEMO REQUESTS
// ══════════════════════════════════════════════════════════════════════

router.get('/demo-requests', async (req, res) => {
  try {
    const { status, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (status) { conditions.push('status = ?'); params.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM demo_requests ${where}`, params);

    const [rows] = await db.query(
      `SELECT * FROM demo_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // Counts by status
    const [statusCounts] = await db.query('SELECT status, COUNT(*) as count FROM demo_requests GROUP BY status');
    const counts = {};
    for (const r of statusCounts) counts[r.status] = r.count;

    res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit), counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/demo-requests/:id/status', async (req, res) => {
  try {
    const { status, admin_notes } = req.body;
    if (!['new', 'contacted', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updates = ['status = ?'];
    const params = [status];
    if (admin_notes !== undefined) { updates.push('admin_notes = ?'); params.push(admin_notes || null); }
    params.push(req.params.id);

    await db.query(`UPDATE demo_requests SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  SUPPORT TICKETS
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/admin/support/tickets — list all tickets ──
router.get('/support/tickets', async (req, res) => {
  try {
    const { status: ticketStatus, category, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];

    if (ticketStatus) { conditions.push('st.status = ?'); params.push(ticketStatus); }
    if (category) { conditions.push('st.category = ?'); params.push(category); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total FROM support_tickets st ${where}`, params
    );

    const [rows] = await db.query(
      `SELECT st.*, u.name as user_name, u.email as user_email, w.name as workspace_name
       FROM support_tickets st
       LEFT JOIN users u ON u.id = st.user_id
       LEFT JOIN workspaces w ON w.id = st.workspace_id
       ${where}
       ORDER BY st.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // Counts by status
    const [statusCounts] = await db.query(
      `SELECT status, COUNT(*) as count FROM support_tickets GROUP BY status`
    );
    const counts = {};
    for (const r of statusCounts) counts[r.status] = r.count;

    res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit), counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/support/tickets/:id — ticket detail + replies ──
router.get('/support/tickets/:id', async (req, res) => {
  try {
    const [[ticket]] = await db.query(
      `SELECT st.*, u.name as user_name, u.email as user_email, w.name as workspace_name
       FROM support_tickets st
       LEFT JOIN users u ON u.id = st.user_id
       LEFT JOIN workspaces w ON w.id = st.workspace_id
       WHERE st.id = ?`,
      [req.params.id]
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

// ── POST /api/admin/support/tickets/:id/reply — admin reply ──
router.post('/support/tickets/:id/reply', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    const [[ticket]] = await db.query(
      'SELECT id FROM support_tickets WHERE id = ?', [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    // Auto-set to in_progress if still open
    await db.query(
      "UPDATE support_tickets SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END WHERE id = ?",
      [req.params.id]
    );

    const [result] = await db.query(
      `INSERT INTO support_ticket_replies (ticket_id, user_id, is_admin, message)
       VALUES (?, ?, 1, ?)`,
      [req.params.id, req.user.id, message.trim()]
    );

    const [[reply]] = await db.query(
      `SELECT r.*, u.name as user_name, u.email as user_email
       FROM support_ticket_replies r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.id = ?`,
      [result.insertId]
    );

    // Send email to ticket creator about admin reply (non-blocking)
    (async () => {
      try {
        const [[ticketFull]] = await db.query(
          `SELECT st.subject, st.user_id, u.email as user_email, u.name as user_name
           FROM support_tickets st
           LEFT JOIN users u ON u.id = st.user_id
           WHERE st.id = ?`, [req.params.id]
        );
        if (ticketFull?.user_email) {
          sendUserEmail({
            to: ticketFull.user_email,
            subject: `Reply on your ticket: ${ticketFull.subject}`,
            html: `
              <h2 style="margin:0 0 12px;font-size:18px;color:#111827;">You have a reply on your support ticket</h2>
              <p style="font-size:14px;color:#6b7280;margin:0 0 16px;">Ticket: <strong>${ticketFull.subject}</strong></p>
              <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:0 0 24px;">
                <p style="margin:0;font-size:14px;color:#374151;line-height:1.7;white-space:pre-line;">${message.trim()}</p>
              </div>
              <p style="font-size:14px;color:#374151;margin:0;">
                You can view the full conversation and reply from your BrandDesk dashboard under Support.
              </p>`,
          }).catch(err => console.error('Ticket reply email failed:', err.message));
        }
      } catch (err) {
        console.error('Ticket reply email lookup failed:', err.message);
      }
    })();

    res.json(reply);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/support/tickets/:id/status — change ticket status ──
router.patch('/support/tickets/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await db.query('UPDATE support_tickets SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
