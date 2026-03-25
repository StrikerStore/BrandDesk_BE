const express = require('express');
const { requireWorkspace } = require('../middleware/authMiddleware');
const { resolveDataSource, fetchOrdersByEmail, fetchOrderById } = require('../services/shopify');

const router = express.Router();

/**
 * GET /api/orders/customer/:email?brand=LABEL
 * Lists orders for a customer email via Shopify.
 */
router.get('/customer/:email', requireWorkspace, async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const brand = req.query.brand;

  try {
    const ds = await resolveDataSource(req.user.workspace_id, brand);

    if (ds.source === 'shopify') {
      const orders = await fetchOrdersByEmail(ds.shop, ds.token, email);
      return res.json(orders);
    }

    // No Shopify connected — return empty
    res.json([]);
  } catch (err) {
    if (err.message === 'SHOPIFY_AUTH_INVALID') return res.status(401).json({ error: 'Shopify connection expired. Please reconnect.' });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/orders/:orderId?brand=LABEL
 * Fetches a single order by ID via Shopify.
 */
router.get('/:orderId', requireWorkspace, async (req, res) => {
  const cleanId = req.params.orderId.replace(/^#/, '').trim();
  if (!cleanId) return res.status(400).json({ error: 'Order ID required' });

  const brand = req.query.brand;

  try {
    const ds = await resolveDataSource(req.user.workspace_id, brand);

    if (ds.source === 'shopify') {
      const order = await fetchOrderById(ds.shop, ds.token, cleanId);
      if (!order) return res.status(404).json({ error: 'Order not found', order_id: cleanId });
      return res.json(order);
    }

    // No Shopify connected
    res.status(404).json({ error: 'Connect Shopify to view orders', order_id: cleanId });
  } catch (err) {
    if (err.message === 'SHOPIFY_AUTH_INVALID') return res.status(401).json({ error: 'Shopify connection expired. Please reconnect.' });
    console.error('Order fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;