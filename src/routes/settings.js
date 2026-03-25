const express = require('express');
const { getAllSettings, setSetting } = require('../services/settings');
const { runAutoAck, runAutoClose }   = require('../services/automation');
const { requireWorkspace, requireWorkspaceAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// GET /api/settings
router.get('/', requireWorkspace, async (req, res) => {
  try {
    const settings = await getAllSettings(req.user.workspace_id);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/settings
router.patch('/', requireWorkspaceAdmin, async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await setSetting(req.user.workspace_id, key, value);
    }
    const settings = await getAllSettings(req.user.workspace_id);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/test-auto-ack
router.post('/test-auto-ack', requireWorkspace, async (req, res) => {
  try {
    await runAutoAck(req.user.workspace_id);
    res.json({ success: true, message: 'Auto-ack run complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/test-auto-close
router.post('/test-auto-close', requireWorkspace, async (req, res) => {
  try {
    await runAutoClose(req.user.workspace_id);
    res.json({ success: true, message: 'Auto-close run complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
