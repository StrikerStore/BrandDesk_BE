const express = require('express');
const db      = require('../config/db');
const { requireAuth, requireWorkspace, requireWorkspaceAdmin } = require('../middleware/authMiddleware');
const { checkPlanLimit } = require('../middleware/planLimits');

const router = express.Router();

// ── GET /api/workspaces/mine ─────────────────────────────────
// List all workspaces the authenticated user belongs to.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT w.id, w.slug, w.name, w.plan, w.trial_ends_at, w.is_active,
              wm.role as workspace_role, w.created_at
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = ?
       ORDER BY w.created_at ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch workspaces' });
  }
});

// ── POST /api/workspaces — create a new workspace ────────────
router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Workspace name required' });

  function slugify(text) {
    return text.toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100);
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    let slug = slugify(name);
    const [slugCheck] = await conn.query('SELECT id FROM workspaces WHERE slug = ?', [slug]);
    if (slugCheck.length) slug = `${slug}-${Date.now().toString(36)}`;

    const [result] = await conn.query(
      `INSERT INTO workspaces (slug, name, owner_user_id, plan, trial_ends_at)
       VALUES (?, ?, ?, 'trial', DATE_ADD(NOW(), INTERVAL 14 DAY))`,
      [slug, name.trim().slice(0, 255), req.user.id]
    );
    const workspaceId = result.insertId;

    await conn.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [workspaceId, req.user.id, 'owner']
    );

    // Seed default settings
    const DEFAULTS = [
      ['auto_ack_enabled', 'false'], ['auto_ack_delay_minutes', '5'],
      ['auto_close_enabled', 'false'], ['auto_close_days', '7'],
      ['sla_first_response_hours', '4'], ['sla_resolve_hours', '24'],
    ];
    for (const [key, value] of DEFAULTS) {
      await conn.query(
        'INSERT IGNORE INTO settings (workspace_id, key_name, value) VALUES (?, ?, ?)',
        [workspaceId, key, value]
      );
    }

    await conn.commit();

    const [ws] = await conn.query('SELECT * FROM workspaces WHERE id = ?', [workspaceId]);
    res.status(201).json(ws[0]);
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Failed to create workspace' });
  } finally {
    conn.release();
  }
});

// ── PATCH /api/workspaces/:id — update workspace name/slug ───
router.patch('/:id', requireWorkspaceAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

    // Only allow updating own workspace
    if (parseInt(req.params.id) !== req.user.workspace_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await db.query(
      'UPDATE workspaces SET name = ? WHERE id = ?',
      [name.trim().slice(0, 255), req.params.id]
    );
    const [rows] = await db.query('SELECT * FROM workspaces WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

// ── GET /api/workspaces/:id/members ──────────────────────────
router.get('/:id/members', requireWorkspaceAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.user.workspace_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.is_active, wm.role as workspace_role, wm.created_at
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ?
       ORDER BY wm.role ASC, u.name ASC`,
      [req.user.workspace_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// ── POST /api/workspaces/:id/members — invite by email ───────
router.post('/:id/members', requireWorkspaceAdmin, checkPlanLimit('members'), async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.user.workspace_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { email, role = 'agent' } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email required' });
    if (!['admin', 'agent'].includes(role)) return res.status(400).json({ error: 'Role must be admin or agent' });

    // User must already exist
    const [users] = await db.query(
      'SELECT id FROM users WHERE email = ? AND is_active = 1',
      [email.toLowerCase().trim()]
    );
    if (!users.length) return res.status(404).json({ error: 'No active user with that email' });

    await db.query(
      'INSERT IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [req.user.workspace_id, users[0].id, role]
    );

    res.json({ success: true, userId: users[0].id, role });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// ── PATCH /api/workspaces/:id/members/:userId — change role ──
router.patch('/:id/members/:userId', requireWorkspaceAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.user.workspace_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { role } = req.body;
    if (!['admin', 'agent'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or agent' });
    }

    await db.query(
      'UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?',
      [role, req.user.workspace_id, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update member role' });
  }
});

// ── DELETE /api/workspaces/:id/members/:userId ────────────────
router.delete('/:id/members/:userId', requireWorkspaceAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) !== req.user.workspace_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (parseInt(req.params.userId) === req.user.id) {
      return res.status(400).json({ error: 'Cannot remove yourself' });
    }

    await db.query(
      'DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [req.user.workspace_id, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
