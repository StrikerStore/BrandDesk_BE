const express = require('express');
const db = require('../config/db');
const { requireWorkspace } = require('../middleware/authMiddleware');
const { checkPlanLimit } = require('../middleware/planLimits');

const router = express.Router();

// GET /api/templates
router.get('/', requireWorkspace, async (req, res) => {
  try {
    const { brand, category } = req.query;
    const wsId = req.user.workspace_id;

    let where  = 'workspace_id = ?';
    const params = [wsId];

    if (brand) {
      where += ' AND (brand_filter IS NULL OR brand_filter = ?)';
      params.push(brand);
    }
    if (category) {
      where += ' AND category = ?';
      params.push(category);
    }

    const [templates] = await db.query(
      `SELECT * FROM templates WHERE ${where} ORDER BY category, title`,
      params
    );

    const grouped = templates.reduce((acc, t) => {
      const cat = t.category || 'General';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(t);
      return acc;
    }, {});

    res.json({ templates, grouped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/templates
router.post('/', requireWorkspace, checkPlanLimit('templates'), async (req, res) => {
  try {
    const { title, category, body, brand_filter } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });

    const [result] = await db.query(
      'INSERT INTO templates (workspace_id, title, category, body, brand_filter) VALUES (?, ?, ?, ?, ?)',
      [req.user.workspace_id, title, category || 'General', body, brand_filter || null]
    );

    const [rows] = await db.query('SELECT * FROM templates WHERE id=?', [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/templates/:id
router.put('/:id', requireWorkspace, async (req, res) => {
  try {
    const { title, category, body, brand_filter } = req.body;

    const [result] = await db.query(
      'UPDATE templates SET title=?, category=?, body=?, brand_filter=? WHERE id=? AND workspace_id=?',
      [title, category || 'General', body, brand_filter || null, req.params.id, req.user.workspace_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Template not found' });

    const [rows] = await db.query('SELECT * FROM templates WHERE id=?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/templates/:id
router.delete('/:id', requireWorkspace, async (req, res) => {
  try {
    const [result] = await db.query(
      'DELETE FROM templates WHERE id=? AND workspace_id=?',
      [req.params.id, req.user.workspace_id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/templates/:id/use
router.post('/:id/use', requireWorkspace, async (req, res) => {
  try {
    await db.query(
      'UPDATE templates SET usage_count = usage_count + 1 WHERE id=? AND workspace_id=?',
      [req.params.id, req.user.workspace_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
