const jwt  = require('jsonwebtoken');
const db   = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'branddesk-jwt-secret-change-in-production';

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

/**
 * requireWorkspace — verifies the user is authenticated and has a workspace_id in their token.
 * Backward-compat: if the token is old (no workspace_id) but the user belongs to exactly one
 * workspace, auto-upgrades the token and attaches the workspace info to req.user.
 */
async function requireWorkspace(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }

  req.user = decoded;

  // Token already has workspace_id — proceed
  if (decoded.workspace_id) return next();

  // Backward-compat: old token without workspace_id
  // Auto-select workspace if user belongs to exactly one
  try {
    const [members] = await db.query(
      `SELECT wm.workspace_id, wm.role as workspace_role, w.is_active
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = ? AND w.is_active = 1`,
      [decoded.id]
    );

    if (members.length === 1) {
      const ws = members[0];
      req.user = { ...decoded, workspace_id: ws.workspace_id, workspace_role: ws.workspace_role };
      // Issue upgraded token in response header so client can store it
      const newToken = generateToken(req.user, ws.workspace_id, ws.workspace_role);
      res.setHeader('X-Refreshed-Token', newToken);
      return next();
    }

    if (members.length > 1) {
      return res.status(403).json({
        error: 'Workspace not selected',
        needsWorkspaceSelection: true,
        workspaces: members.map(m => ({ id: m.workspace_id, role: m.workspace_role })),
      });
    }

    return res.status(403).json({ error: 'You do not belong to any active workspace' });
  } catch (err) {
    return res.status(500).json({ error: 'Workspace lookup failed' });
  }
}

/**
 * requireWorkspaceAdmin — must be workspace owner or admin role.
 */
function requireWorkspaceAdmin(req, res, next) {
  requireWorkspace(req, res, () => {
    if (!['owner', 'admin'].includes(req.user?.workspace_role)) {
      return res.status(403).json({ error: 'Workspace admin access required' });
    }
    next();
  });
}

/**
 * generateToken — embeds user info + optional workspace context.
 */
function generateToken(user, workspaceId = null, workspaceRole = null) {
  const payload = {
    id:   user.id,
    email: user.email,
    name:  user.name,
    role:  user.role,
  };
  if (workspaceId)   payload.workspace_id   = workspaceId;
  if (workspaceRole) payload.workspace_role = workspaceRole;

  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireWorkspace,
  requireWorkspaceAdmin,
  generateToken,
  JWT_SECRET,
};
