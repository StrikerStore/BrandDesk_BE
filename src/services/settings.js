const db = require('../config/db');

async function getSetting(workspaceId, key, defaultValue = null) {
  const [rows] = await db.query(
    'SELECT value FROM settings WHERE workspace_id = ? AND key_name = ?',
    [workspaceId, key]
  );
  if (!rows.length) return defaultValue;
  return rows[0].value;
}

async function setSetting(workspaceId, key, value) {
  await db.query(
    `INSERT INTO settings (workspace_id, key_name, value) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [workspaceId, key, String(value)]
  );
}

async function getAllSettings(workspaceId) {
  const [rows] = await db.query(
    'SELECT key_name, value FROM settings WHERE workspace_id = ?',
    [workspaceId]
  );
  return rows.reduce((acc, r) => ({ ...acc, [r.key_name]: r.value }), {});
}

module.exports = { getSetting, setSetting, getAllSettings };
