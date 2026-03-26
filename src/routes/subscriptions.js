const express = require('express');
const db = require('../config/db');
const { requireWorkspace, requireWorkspaceAdmin } = require('../middleware/authMiddleware');
const payu = require('../services/payu');
const { PLAN_LIMITS } = require('../middleware/planLimits');
const { sendPaymentReceipt } = require('../services/mailer');

const router = express.Router();

const FRONTEND_URL    = () => process.env.FRONTEND_URL    || 'http://localhost:5173';
const ONBOARDING_URL  = () => process.env.ONBOARDING_URL  || 'http://localhost:5174';
const API_URL         = () => process.env.API_URL || `http://localhost:${process.env.PORT || 3001}`;

// ── Helper: validate a coupon code ─────────────────────────────────
async function validateCoupon(code, plan, cycle) {
  const [rows] = await db.query('SELECT * FROM coupons WHERE code = ? AND is_active = 1', [code]);
  if (!rows.length) return { valid: false, error: 'Invalid coupon code' };

  const coupon = rows[0];

  // Check date range
  const now = new Date();
  if (coupon.valid_from && new Date(coupon.valid_from) > now) {
    return { valid: false, error: 'Coupon is not yet active' };
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    return { valid: false, error: 'Coupon has expired' };
  }

  // Check usage limits
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
    return { valid: false, error: 'Coupon usage limit reached' };
  }

  // Check plan compatibility
  if (coupon.min_plan === 'pro' && plan !== 'pro') {
    return { valid: false, error: 'This coupon is only valid for the Pro plan' };
  }

  // Calculate discount
  const originalAmount = await payu.getAmount(plan, cycle);
  let discountAmount;
  if (coupon.discount_type === 'percent') {
    discountAmount = Math.round(originalAmount * coupon.discount_value / 100);
  } else {
    discountAmount = coupon.discount_value;
  }

  const finalAmount = Math.max(1, originalAmount - discountAmount);

  return {
    valid: true,
    coupon_id: coupon.id,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    discount_amount: discountAmount,
    original_amount: originalAmount,
    final_amount: finalAmount,
  };
}

// ── GET /api/subscriptions/usage ────────────────────────────────────
// Returns current plan usage stats for the workspace
router.get('/usage', requireWorkspace, async (req, res) => {
  try {
    const wsId = req.user.workspace_id;
    const [ws] = await db.query('SELECT plan FROM workspaces WHERE id = ?', [wsId]);
    const plan = ws[0]?.plan || 'trial';
    const { loadPlans } = require('../middleware/planLimits');
    const allPlans = await loadPlans();
    const limits = allPlans[plan] || allPlans.trial || PLAN_LIMITS.trial;

    const [threads] = await db.query(
      `SELECT COUNT(*) as cnt FROM threads WHERE workspace_id = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
      [wsId]
    );
    const [members] = await db.query(
      'SELECT COUNT(*) as cnt FROM workspace_members WHERE workspace_id = ?',
      [wsId]
    );
    const [templates] = await db.query(
      'SELECT COUNT(*) as cnt FROM templates WHERE workspace_id = ?',
      [wsId]
    );
    const [brands] = await db.query(
      'SELECT COUNT(*) as cnt FROM brands WHERE workspace_id = ? AND is_active = 1',
      [wsId]
    );

    res.json({
      plan,
      usage: {
        threads_per_month: threads[0].cnt,
        members: members[0].cnt,
        templates: templates[0].cnt,
        brands: brands[0].cnt,
      },
      limits: {
        threads_per_month: limits.threads_per_month === Infinity ? null : limits.threads_per_month,
        members: limits.members === Infinity ? null : limits.members,
        templates: limits.templates === Infinity ? null : limits.templates,
        brands: limits.brands === Infinity ? null : limits.brands,
      },
    });
  } catch (err) {
    console.error('Fetch plan usage error:', err);
    res.status(500).json({ error: 'Failed to fetch plan usage' });
  }
});

// ── POST /api/subscriptions/validate-coupon ────────────────────────
router.post('/validate-coupon', requireWorkspace, async (req, res) => {
  try {
    const { code, plan, cycle = 'monthly' } = req.body;
    if (!code) return res.status(400).json({ error: 'Coupon code is required' });
    if (!['starter', 'pro'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

    const result = await validateCoupon(code.trim().toUpperCase(), plan, cycle);
    res.json(result);
  } catch (err) {
    console.error('Validate coupon error:', err);
    res.status(500).json({ error: 'Failed to validate coupon' });
  }
});

// ── Invoice number generator ──────────────────────────────────────────
async function generateInvoiceNumber() {
  const prefix = `BD-INV-${new Date().toISOString().slice(0, 7).replace('-', '')}`;
  const [rows] = await db.query(
    "SELECT COUNT(*) as cnt FROM payment_transactions WHERE invoice_number LIKE ?",
    [`${prefix}%`]
  );
  return `${prefix}-${String(rows[0].cnt + 1).padStart(4, '0')}`;
}

// ── POST /api/subscriptions/initiate ───────────────────────────────
// Creates a pending subscription + transaction, returns PayU form params
router.post('/initiate', requireWorkspaceAdmin, async (req, res) => {
  try {
    const { plan, cycle = 'monthly', coupon_code, customer_gst } = req.body;

    if (!['starter', 'pro'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Choose starter or pro.' });
    }
    if (!['monthly', 'yearly'].includes(cycle)) {
      return res.status(400).json({ error: 'Invalid cycle. Choose monthly or yearly.' });
    }

    const wsId = req.user.workspace_id;

    // Check if already on this plan with active subscription
    const [ws] = await db.query('SELECT plan FROM workspaces WHERE id = ?', [wsId]);
    if (ws[0]?.plan === plan) {
      const [activeSub] = await db.query(
        "SELECT id FROM subscriptions WHERE workspace_id = ? AND plan = ? AND status = 'active'",
        [wsId, plan]
      );
      if (activeSub.length > 0) {
        return res.status(400).json({ error: 'You are already on this plan.' });
      }
    }

    // Load GST config
    let gstPercent = 18;
    try {
      const [cfgRows] = await db.query('SELECT gst_percent FROM billing_config WHERE id = 1');
      if (cfgRows.length) gstPercent = parseFloat(cfgRows[0].gst_percent) || 18;
    } catch (_) {}

    // Validate and apply coupon if provided
    let baseAmount = await payu.getAmount(plan, cycle);
    let couponData = null;
    let couponDiscount = 0;
    if (coupon_code) {
      const couponResult = await validateCoupon(coupon_code.trim().toUpperCase(), plan, cycle);
      if (!couponResult.valid) {
        return res.status(400).json({ error: couponResult.error });
      }
      couponDiscount = couponResult.discount_amount;
      baseAmount = couponResult.final_amount;
      couponData = couponResult;
    }

    // Calculate GST on discounted base
    const gstAmount = Math.round(baseAmount * gstPercent / 100 * 100) / 100;
    const totalAmount = Math.round((baseAmount + gstAmount) * 100) / 100;

    const successUrl = `${API_URL()}/api/subscriptions/success`;
    const failureUrl = `${API_URL()}/api/subscriptions/failure`;

    const { payuBaseUrl, formParams, txnid } = await payu.buildPaymentParams({
      plan, cycle,
      workspace: { id: wsId },
      user: req.user,
      successUrl,
      failureUrl,
      overrideAmount: totalAmount,
    });

    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber();

    // Create pending subscription
    const [subResult] = await db.query(
      `INSERT INTO subscriptions (workspace_id, plan, billing_cycle, amount, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [wsId, plan, cycle, totalAmount]
    );

    // Create pending transaction with full billing detail
    await db.query(
      `INSERT INTO payment_transactions
       (workspace_id, subscription_id, txn_id, amount, base_amount, gst_amount,
        coupon_code, coupon_discount, customer_gst, plan_name, billing_cycle, invoice_number, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [wsId, subResult.insertId, txnid, totalAmount, baseAmount, gstAmount,
       coupon_code ? coupon_code.trim().toUpperCase() : null,
       couponDiscount || null,
       customer_gst?.trim() || null,
       plan, cycle, invoiceNumber]
    );

    // Store coupon info in udf4 for retrieval in success callback
    if (couponData) {
      formParams.udf4 = `${couponData.coupon_id}:${couponData.discount_amount}`;
      formParams.hash = payu.generateHash(formParams);
    }

    res.json({ payuBaseUrl, formParams, gst_percent: gstPercent, base_amount: baseAmount, gst_amount: gstAmount, total: totalAmount });
  } catch (err) {
    console.error('Subscription initiate error:', err);
    res.status(500).json({ error: 'Failed to initiate subscription' });
  }
});

// ── POST /api/subscriptions/success ────────────────────────────────
// PayU POSTs here after successful payment (form-urlencoded)
router.post('/success', async (req, res) => {
  try {
    const payuResp = req.body;

    // Verify hash
    if (!payu.verifyPaymentHash(payuResp)) {
      console.error('PayU hash verification failed for txn:', payuResp.txnid);
      return res.redirect(`${FRONTEND_URL()}?billing=failed&reason=verification`);
    }

    const { txnid, mihpayid, mode, status, udf1, udf2, udf3, udf4 } = payuResp;
    const wsId  = parseInt(udf1);
    const plan  = udf2;
    const cycle = udf3;

    if (status !== 'success') {
      // PayU sometimes sends to surl even if status is not success
      await db.query(
        "UPDATE payment_transactions SET status = 'failure', payu_mihpayid = ?, raw_response = ? WHERE txn_id = ?",
        [mihpayid, JSON.stringify(payuResp), txnid]
      );
      return res.redirect(`${FRONTEND_URL()}?billing=failed`);
    }

    // Update transaction
    await db.query(
      "UPDATE payment_transactions SET status = 'success', payu_mihpayid = ?, payment_method = ?, raw_response = ? WHERE txn_id = ?",
      [mihpayid, mode || null, JSON.stringify(payuResp), txnid]
    );

    // Get subscription linked to this txn
    const [txnRows] = await db.query('SELECT subscription_id FROM payment_transactions WHERE txn_id = ?', [txnid]);
    const subId = txnRows[0]?.subscription_id;

    if (subId) {
      // Calculate period end based on cycle
      const periodInterval = cycle === 'yearly' ? 'INTERVAL 1 YEAR' : 'INTERVAL 1 MONTH';

      await db.query(
        `UPDATE subscriptions
         SET status = 'active',
             payu_subscription_id = ?,
             current_period_start = NOW(),
             current_period_end = DATE_ADD(NOW(), ${periodInterval})
         WHERE id = ?`,
        [mihpayid, subId]
      );
    }

    // Upgrade workspace plan
    await db.query(
      "UPDATE workspaces SET plan = ?, trial_ends_at = NULL, pending_plan_change = NULL WHERE id = ?",
      [plan, wsId]
    );

    // Record coupon usage if coupon was applied (stored in udf4 as "couponId:discountAmount")
    console.log('[PAYU] Coupon udf4:', udf4, 'subId:', subId);
    if (udf4 && udf4.includes(':') && subId) {
      try {
        const [couponId, discountAmount] = udf4.split(':');
        await db.query(
          `INSERT INTO coupon_usage (coupon_id, workspace_id, subscription_id, discount_amount)
           VALUES (?, ?, ?, ?)`,
          [parseInt(couponId), wsId, subId, parseFloat(discountAmount)]
        );
        await db.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [parseInt(couponId)]);
      } catch (couponErr) {
        console.error('Coupon usage recording error:', couponErr);
      }
    }

    console.log(`✅ Subscription activated: workspace=${wsId}, plan=${plan}, cycle=${cycle}, txn=${txnid}`);

    // Send receipt email
    try {
      const [txnRows2] = await db.query('SELECT * FROM payment_transactions WHERE txn_id = ?', [txnid]);
      const [cfgRows] = await db.query('SELECT * FROM billing_config WHERE id = 1');
      const txnData = txnRows2[0];
      const cfg = cfgRows[0] || {};
      if (txnData) {
        sendPaymentReceipt({
          to: payuResp.email,
          invoice: { ...txnData, company_name: cfg.company_name, company_address: cfg.company_address, gst_number: cfg.gst_number, gst_percent: cfg.gst_percent },
        }).catch(err => console.error('Receipt email failed:', err.message));
      }
    } catch (emailErr) {
      console.error('Receipt email error:', emailErr.message);
    }

    // Redirect user back to app
    res.redirect(`${FRONTEND_URL()}?billing=success`);
  } catch (err) {
    console.error('Subscription success handler error:', err);
    res.redirect(`${FRONTEND_URL()}?billing=failed&reason=server`);
  }
});

// ── POST /api/subscriptions/failure ────────────────────────────────
// PayU POSTs here after failed payment
router.post('/failure', async (req, res) => {
  try {
    const payuResp = req.body;
    const { txnid, mihpayid } = payuResp;

    if (txnid) {
      await db.query(
        "UPDATE payment_transactions SET status = 'failure', payu_mihpayid = ?, raw_response = ? WHERE txn_id = ?",
        [mihpayid || null, JSON.stringify(payuResp), txnid]
      );
    }

    console.log(`❌ Payment failed: txn=${txnid}`);
    res.redirect(`${FRONTEND_URL()}?billing=failed`);
  } catch (err) {
    console.error('Subscription failure handler error:', err);
    res.redirect(`${FRONTEND_URL()}?billing=failed`);
  }
});

// ── POST /api/webhooks/payu ────────────────────────────────────────
// PayU server-to-server webhook for recurring payment updates
router.post('/payu', async (req, res) => {
  try {
    const payuResp = req.body;

    // Verify hash
    if (!payu.verifyPaymentHash(payuResp)) {
      console.error('PayU webhook hash verification failed');
      return res.status(400).json({ error: 'Hash verification failed' });
    }

    const { txnid, mihpayid, status, mode, udf1, udf2, udf3 } = payuResp;
    const wsId  = parseInt(udf1);
    const plan  = udf2;
    const cycle = udf3;

    // Idempotency: check if this txn already processed
    const [existing] = await db.query('SELECT id FROM payment_transactions WHERE txn_id = ?', [txnid]);
    if (existing.length > 0) {
      return res.json({ status: 'already_processed' });
    }

    // Find active subscription for this workspace
    const [subs] = await db.query(
      "SELECT id, billing_cycle FROM subscriptions WHERE workspace_id = ? AND status IN ('active','past_due') ORDER BY id DESC LIMIT 1",
      [wsId]
    );

    if (subs.length === 0) {
      console.error(`Webhook: no active subscription for workspace ${wsId}`);
      return res.status(404).json({ error: 'No active subscription' });
    }

    const sub = subs[0];
    const amount = await payu.getAmount(plan, cycle || sub.billing_cycle);

    // Insert transaction record
    await db.query(
      `INSERT INTO payment_transactions (workspace_id, subscription_id, txn_id, payu_mihpayid, amount, status, payment_method, raw_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [wsId, sub.id, txnid, mihpayid, amount, status === 'success' ? 'success' : 'failure',
       mode || null, JSON.stringify(payuResp)]
    );

    if (status === 'success') {
      // Renew subscription period
      const periodInterval = (cycle || sub.billing_cycle) === 'yearly' ? 'INTERVAL 1 YEAR' : 'INTERVAL 1 MONTH';
      await db.query(
        `UPDATE subscriptions
         SET status = 'active',
             current_period_start = current_period_end,
             current_period_end = DATE_ADD(current_period_end, ${periodInterval})
         WHERE id = ?`,
        [sub.id]
      );
      console.log(`✅ Recurring payment success: workspace=${wsId}, txn=${txnid}`);
    } else {
      // Payment failed — mark as past_due (cron handles downgrade after grace)
      await db.query("UPDATE subscriptions SET status = 'past_due' WHERE id = ?", [sub.id]);
      console.log(`⚠️ Recurring payment failed: workspace=${wsId}, txn=${txnid}`);
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('PayU webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── GET /api/subscriptions/current ─────────────────────────────────
// Returns current subscription + recent transactions
router.get('/current', requireWorkspace, async (req, res) => {
  try {
    const wsId = req.user.workspace_id;

    // Get workspace plan info
    const [ws] = await db.query(
      'SELECT plan, trial_ends_at, pending_plan_change FROM workspaces WHERE id = ?',
      [wsId]
    );

    // Get active/most recent subscription
    const [subs] = await db.query(
      `SELECT id, plan, billing_cycle, status, amount, current_period_start, current_period_end, cancelled_at, created_at
       FROM subscriptions WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
      [wsId]
    );

    // Get last 10 transactions (include invoice fields)
    const [txns] = await db.query(
      `SELECT txn_id, amount, base_amount, gst_amount, invoice_number, coupon_code, coupon_discount,
              status, payment_method, payu_mihpayid, plan_name, billing_cycle, created_at
       FROM payment_transactions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 10`,
      [wsId]
    );

    // Load pricing and plans from DB
    const pricing = await payu.loadPricing();
    let plansList = [];
    try {
      const [rows] = await db.query('SELECT name, display_name, description, price_monthly, price_yearly, max_brands, max_members, max_threads_per_month, max_templates FROM plans WHERE is_active = 1 ORDER BY sort_order');
      plansList = rows;
    } catch (_) {}

    res.json({
      workspace: {
        plan: ws[0]?.plan || 'trial',
        trial_ends_at: ws[0]?.trial_ends_at,
        pending_plan_change: ws[0]?.pending_plan_change,
      },
      subscription: subs[0] || null,
      transactions: txns,
      pricing,
      plans: plansList,
    });
  } catch (err) {
    console.error('Fetch subscription error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

// ── POST /api/subscriptions/cancel ─────────────────────────────────
// Cancels subscription — plan stays until period end
router.post('/cancel', requireWorkspaceAdmin, async (req, res) => {
  try {
    const wsId = req.user.workspace_id;

    const [subs] = await db.query(
      "SELECT id, current_period_end FROM subscriptions WHERE workspace_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      [wsId]
    );

    if (subs.length === 0) {
      return res.status(400).json({ error: 'No active subscription to cancel.' });
    }

    const sub = subs[0];

    await db.query(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?",
      [sub.id]
    );

    await db.query(
      "UPDATE workspaces SET pending_plan_change = 'trial' WHERE id = ?",
      [wsId]
    );

    console.log(`🔻 Subscription cancelled: workspace=${wsId}, active until=${sub.current_period_end}`);

    res.json({
      message: 'Subscription cancelled. Your plan remains active until the end of the current billing period.',
      active_until: sub.current_period_end,
    });
  } catch (err) {
    console.error('Cancel subscription error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

// ── GET /api/subscriptions/invoice/:txnId ─────────────────────────────
// Returns invoice data for a specific transaction (user-facing, workspace-scoped)
router.get('/invoice/:txnId', requireWorkspace, async (req, res) => {
  try {
    const wsId = req.user.workspace_id;
    const [rows] = await db.query(
      `SELECT pt.*, w.name as workspace_name
       FROM payment_transactions pt
       LEFT JOIN workspaces w ON w.id = pt.workspace_id
       WHERE pt.txn_id = ? AND pt.workspace_id = ?`,
      [req.params.txnId, wsId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });

    const txn = rows[0];
    // Load billing config for company details
    let billingConfig = { gst_number: null, gst_percent: 18, company_name: 'BrandDesk', company_address: null };
    try {
      const [bc] = await db.query('SELECT * FROM billing_config WHERE id = 1');
      if (bc.length) billingConfig = bc[0];
    } catch {}

    res.json({
      invoice_number: txn.invoice_number,
      txn_id: txn.txn_id,
      payu_mihpayid: txn.payu_mihpayid,
      created_at: txn.created_at,
      plan_name: txn.plan_name,
      billing_cycle: txn.billing_cycle,
      base_amount: txn.base_amount,
      gst_amount: txn.gst_amount,
      gst_percent: billingConfig.gst_percent,
      amount: txn.amount,
      coupon_code: txn.coupon_code,
      coupon_discount: txn.coupon_discount,
      customer_gst: txn.customer_gst,
      payment_method: txn.payment_method,
      status: txn.status,
      workspace_name: txn.workspace_name,
      company_name: billingConfig.company_name,
      company_address: billingConfig.company_address,
      gst_number: billingConfig.gst_number,
    });
  } catch (err) {
    console.error('Invoice fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

module.exports = router;
