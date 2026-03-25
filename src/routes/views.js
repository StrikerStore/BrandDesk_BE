const express = require('express');
const db = require('../config/db');
const { requireWorkspace } = require('../middleware/authMiddleware');

const router = express.Router();

// GET /api/views
router.get('/', requireWorkspace, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM saved_views WHERE workspace_id=? ORDER BY sort_order ASC, created_at ASC',
      [req.user.workspace_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/views
router.post('/', requireWorkspace, async (req, res) => {
  try {
    const { name, filters } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    if (!filters)      return res.status(400).json({ error: 'Filters required' });

    const [result] = await db.query(
      'INSERT INTO saved_views (workspace_id, name, filters) VALUES (?, ?, ?)',
      [req.user.workspace_id, name.trim(), JSON.stringify(filters)]
    );
    const [rows] = await db.query('SELECT * FROM saved_views WHERE id=?', [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/views/:id
router.delete('/:id', requireWorkspace, async (req, res) => {
  try {
    const [result] = await db.query(
      'DELETE FROM saved_views WHERE id=? AND workspace_id=?',
      [req.params.id, req.user.workspace_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'View not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
