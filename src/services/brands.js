/**
 * Brand DB service — replaces config/brands.js (env-var approach).
 * All functions are workspace-scoped and async.
 */
const db = require('../config/db');

async function getBrandsByWorkspace(workspaceId) {
  const [rows] = await db.query(
    'SELECT * FROM brands WHERE workspace_id = ? AND is_active = 1 ORDER BY name ASC',
    [workspaceId]
  );
  return rows;
}

async function getBrandByNameForWorkspace(workspaceId, name) {
  const [rows] = await db.query(
    'SELECT * FROM brands WHERE workspace_id = ? AND name = ? AND is_active = 1 LIMIT 1',
    [workspaceId, name]
  );
  return rows[0] || null;
}

async function getBrandByEmailForWorkspace(workspaceId, email) {
  const [rows] = await db.query(
    'SELECT * FROM brands WHERE workspace_id = ? AND email = ? AND is_active = 1 LIMIT 1',
    [workspaceId, email]
  );
  return rows[0] || null;
}

async function getBrandByLabelForWorkspace(workspaceId, label) {
  const [rows] = await db.query(
    'SELECT * FROM brands WHERE workspace_id = ? AND label = ? AND is_active = 1 LIMIT 1',
    [workspaceId, label]
  );
  return rows[0] || null;
}

module.exports = {
  getBrandsByWorkspace,
  getBrandByNameForWorkspace,
  getBrandByEmailForWorkspace,
  getBrandByLabelForWorkspace,
};
