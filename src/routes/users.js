const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../config/db');
const { generateToken, requireAuth, requireAdmin, requireWorkspace } = require('../middleware/authMiddleware');

const router = express.Router();

// ── Rate limiting for login ──────────────────────────────────
const loginAttempts = new Map(); // ip → { count, resetAt }

function checkLoginRateLimit(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= 10) return false;
    entry.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  }
  return true;
}

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  });
}

// ── POST /api/users/register — public ──────────────────────────
// Creates a user + workspace in a single transaction.
router.post('/register', async (req, res) => {
  const { name, email, password, workspaceName } = req.body;

  if (!name?.trim())        return res.status(400).json({ error: 'Name required' });
  if (!email?.trim() || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  if (!password || password.length < 8)       return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!workspaceName?.trim()) return res.status(400).json({ error: 'Workspace/store name required' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const hash = await bcrypt.hash(password, 12);

    // Insert user
    const [userResult] = await conn.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name.trim().slice(0, 100), email.toLowerCase().trim(), hash, 'owner']
    );
    const userId = userResult.insertId;

    // Generate unique slug
    let slug = slugify(workspaceName);
    const [slugCheck] = await conn.query('SELECT id FROM workspaces WHERE slug = ?', [slug]);
    if (slugCheck.length) slug = `${slug}-${Date.now().toString(36)}`;

    // Insert workspace (14-day trial)
    const [wsResult] = await conn.query(
      `INSERT INTO workspaces (slug, name, owner_user_id, plan, trial_ends_at)
       VALUES (?, ?, ?, 'trial', DATE_ADD(NOW(), INTERVAL 14 DAY))`,
      [slug, workspaceName.trim().slice(0, 255), userId]
    );
    const workspaceId = wsResult.insertId;

    // Add user as owner
    await conn.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [workspaceId, userId, 'owner']
    );

    // Seed default settings
    const DEFAULTS = [
      ['auto_ack_enabled',        'false'],
      ['auto_ack_delay_minutes',  '5'],
      ['auto_close_enabled',      'false'],
      ['auto_close_days',         '7'],
      ['sla_first_response_hours','4'],
      ['sla_resolve_hours',       '24'],
    ];
    for (const [key, value] of DEFAULTS) {
      await conn.query(
        'INSERT IGNORE INTO settings (workspace_id, key_name, value) VALUES (?, ?, ?)',
        [workspaceId, key, value]
      );
    }

    await conn.commit();

    const user = { id: userId, name: name.trim(), email: email.toLowerCase().trim(), role: 'owner' };
    const token = generateToken(user, workspaceId, 'owner');
    setAuthCookie(res, token);

    res.status(201).json({
      user:        { ...user, workspace_id: workspaceId, workspace_role: 'owner' },
      token,
      workspaceId,
    });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already registered' });
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    conn.release();
  }
});

// ── POST /api/users/login — public ───────────────────────────
router.post('/login', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  try {
    const { email, password } = req.body;
    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const [rows] = await db.query(
      'SELECT * FROM users WHERE email = ? AND is_active = 1',
      [email.toLowerCase().trim()]
    );

    if (!rows.length) {
      await bcrypt.hash('dummy', 10); // timing attack prevention
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];

    // Google-only users have no password — must use Google Sign-in
    if (!user.password_hash) {
      return res.status(400).json({ error: 'This account uses Google Sign-in. Please sign in with Google.', useGoogle: true });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    // Look up workspaces for this user
    const [members] = await db.query(
      `SELECT wm.workspace_id, wm.role as workspace_role, w.name as workspace_name, w.is_active
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = ? AND w.is_active = 1
       ORDER BY wm.workspace_id ASC`,
      [user.id]
    );

    loginAttempts.delete(ip);

    if (members.length === 0) {
      // No workspace — return token without workspace (edge case)
      const token = generateToken(user);
      setAuthCookie(res, token);
      return res.json({
        user:  { id: user.id, name: user.name, email: user.email, role: user.role },
        token,
        needsWorkspaceSelection: false,
      });
    }

    if (members.length === 1) {
      // Single workspace — auto-select, embed in token
      const ws    = members[0];
      const token = generateToken(user, ws.workspace_id, ws.workspace_role);
      setAuthCookie(res, token);
      return res.json({
        user: {
          id:             user.id,
          name:           user.name,
          email:          user.email,
          role:           user.role,
          workspace_id:   ws.workspace_id,
          workspace_role: ws.workspace_role,
        },
        token,
      });
    }

    // Multiple workspaces — return pre-auth token, let client choose
    const preAuthToken = generateToken(user); // no workspace_id
    setAuthCookie(res, preAuthToken);
    return res.json({
      user:                    { id: user.id, name: user.name, email: user.email, role: user.role },
      token:                   preAuthToken,
      needsWorkspaceSelection: true,
      workspaces:              members.map(m => ({
        id:   m.workspace_id,
        name: m.workspace_name,
        role: m.workspace_role,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/users/select-workspace — auth required ─────────
// Exchanges a pre-auth token (no workspace_id) for a full token.
router.post('/select-workspace', requireAuth, async (req, res) => {
  try {
    const { workspace_id } = req.body;
    if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });

    const [members] = await db.query(
      `SELECT wm.role as workspace_role, w.is_active
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = ? AND wm.workspace_id = ? AND w.is_active = 1`,
      [req.user.id, workspace_id]
    );

    if (!members.length) return res.status(403).json({ error: 'Access denied to this workspace' });

    const ws    = members[0];
    const token = generateToken(req.user, workspace_id, ws.workspace_role);
    setAuthCookie(res, token);

    res.json({
      user: {
        id:             req.user.id,
        name:           req.user.name,
        email:          req.user.email,
        role:           req.user.role,
        workspace_id,
        workspace_role: ws.workspace_role,
      },
      token,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to select workspace' });
  }
});

// ── POST /api/users/logout — public ──────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  });
  res.json({ success: true });
});

// ── GET /api/users/me — auth required ────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, role, avatar_url, created_at FROM users WHERE id = ? AND is_active = 1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const user = rows[0];

    // Attach workspace context from token if present
    if (req.user.workspace_id) {
      user.workspace_id   = req.user.workspace_id;
      user.workspace_role = req.user.workspace_role;
      // Include workspace name
      const [ws] = await db.query('SELECT name FROM workspaces WHERE id = ?', [req.user.workspace_id]);
      if (ws.length) user.workspace_name = ws[0].name;
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── PATCH /api/users/me — auth required ──────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { name, current_password, new_password } = req.body;
    const updates = [];
    const params  = [];

    if (name?.trim()) {
      updates.push('name = ?');
      params.push(name.trim().slice(0, 100));
    }

    if (new_password) {
      if (!current_password) return res.status(400).json({ error: 'Current password required' });
      const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
      if (!rows[0].password_hash) return res.status(400).json({ error: 'Google accounts cannot set a password' });
      const valid = await bcrypt.compare(current_password, rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
      if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
      updates.push('password_hash = ?');
      params.push(await bcrypt.hash(new_password, 12));
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.user.id);
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    const [rows] = await db.query('SELECT id, name, email, role FROM users WHERE id = ?', [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── GET /api/users — workspace-scoped ─────────────────────────
router.get('/', requireWorkspace, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active, u.created_at, wm.role as workspace_role
       FROM users u
       INNER JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.workspace_id = ? AND u.is_active = 1
       ORDER BY wm.role ASC, u.name ASC`,
      [req.user.workspace_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ── POST /api/users — admin only ─────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role = 'agent' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    if (!email?.trim() || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (role !== 'agent') return res.status(400).json({ error: 'Role must be agent' });

    const hash = await bcrypt.hash(password, 12);
    const [result] = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name.trim().slice(0, 100), email.toLowerCase().trim(), hash, 'agent']
    );

    // Also add to workspace if caller is workspace-aware
    if (req.user.workspace_id) {
      await db.query(
        'INSERT IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
        [req.user.workspace_id, result.insertId, 'agent']
      );
    }

    const [rows] = await db.query(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?',
      [result.insertId]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── PATCH /api/users/:id — admin only ────────────────────────
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, is_active, password } = req.body;
    const updates = [];
    const params  = [];

    if (name?.trim())                           { updates.push('name = ?');          params.push(name.trim().slice(0, 100)); }
    if (role && ['owner','agent'].includes(role)) { updates.push('role = ?');        params.push(role); }
    if (is_active !== undefined)                { updates.push('is_active = ?');     params.push(is_active ? 1 : 0); }
    if (password && password.length >= 8) {
      updates.push('password_hash = ?');
      params.push(await bcrypt.hash(password, 12));
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    const [rows] = await db.query(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?',
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ── DELETE /api/users/:id — admin only ───────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }
    await db.query('UPDATE users SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

module.exports = router;
