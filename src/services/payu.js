const crypto = require('crypto');
const db = require('../config/db');

const PAYU_KEY  = () => process.env.PAYU_MERCHANT_KEY;
const PAYU_SALT = () => process.env.PAYU_MERCHANT_SALT;
const PAYU_BASE = () => process.env.PAYU_BASE_URL || 'https://test.payu.in';

// ── Pricing (fallback) ──────────────────────────────────────────
const PRICING_FALLBACK = {
  starter: { monthly: 999, yearly: 9999 },
  pro:     { monthly: 2499, yearly: 24999 },
};

// Keep backward-compatible sync export
const PRICING = { ...PRICING_FALLBACK };

let _pricingCacheTime = 0;
const PRICING_CACHE_TTL = 60_000;

async function loadPricing() {
  const now = Date.now();
  if (now - _pricingCacheTime < PRICING_CACHE_TTL && Object.keys(PRICING).length > 0) return PRICING;

  try {
    const [rows] = await db.query('SELECT name, price_monthly, price_yearly FROM plans WHERE is_active = 1');
    if (rows.length) {
      // Clear and rebuild
      for (const key of Object.keys(PRICING)) delete PRICING[key];
      for (const r of rows) {
        if (r.price_monthly > 0 || r.price_yearly > 0) {
          PRICING[r.name] = { monthly: r.price_monthly || 0, yearly: r.price_yearly || 0 };
        }
      }
    }
    _pricingCacheTime = now;
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') console.error('Failed to load pricing from DB:', err.message);
    // Fall back to hardcoded
    if (!Object.keys(PRICING).length) Object.assign(PRICING, PRICING_FALLBACK);
    _pricingCacheTime = now;
  }
  return PRICING;
}

async function getAmount(plan, cycle) {
  const pricing = await loadPricing();
  return pricing[plan]?.[cycle] ?? 0;
}

// ── Unique transaction ID ──────────────────────────────────────────
function generateTxnId(workspaceId) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(2).toString('hex');
  return `BD-${workspaceId}-${ts}-${rand}`;
}

// ── SHA-512 hash generation ────────────────────────────────────────
// Formula: sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
function generateHash({ txnid, amount, productinfo, firstname, email, udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '' }) {
  const str = `${PAYU_KEY()}|${txnid}|${amount}|${productinfo}|${firstname}|${email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${PAYU_SALT()}`;
  console.log('[PAYU] Hash input:', str.replace(PAYU_SALT(), '***SALT***'));
  return crypto.createHash('sha512').update(str).digest('hex');
}

// ── Reverse hash verification (PayU callback) ──────────────────────
// Formula: sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
function verifyPaymentHash(payuResponse) {
  const { status, email, firstname, productinfo, amount, txnid, hash,
          udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '' } = payuResponse;
  const str = `${PAYU_SALT()}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${PAYU_KEY()}`;
  const computed = crypto.createHash('sha512').update(str).digest('hex');
  return computed === hash;
}

// ── Build full PayU form parameters ────────────────────────────────
async function buildPaymentParams({ plan, cycle, workspace, user, successUrl, failureUrl, overrideAmount }) {
  const baseAmount = overrideAmount != null ? overrideAmount : await getAmount(plan, cycle);
  const amount = baseAmount.toFixed(2);
  const txnid = generateTxnId(workspace.id);
  const productinfo = `BrandDesk ${plan} plan (${cycle})`;

  const params = {
    key:         PAYU_KEY(),
    txnid,
    amount,
    productinfo,
    firstname:   user.name || 'User',
    email:       user.email,
    phone:       '',
    surl:        successUrl,
    furl:        failureUrl,
    // Store workspace_id and plan info in udf fields for retrieval in callback
    udf1:        String(workspace.id),   // workspace_id
    udf2:        plan,                    // plan name
    udf3:        cycle,                   // billing cycle
    udf4:        '',
    udf5:        '',
  };

  // Generate hash (standard formula — no SI/recurring for now)
  params.hash = generateHash(params);

  return {
    payuBaseUrl: PAYU_BASE(),
    formParams: params,
    txnid,
    amount: parseFloat(amount),
  };
}

module.exports = {
  PRICING,
  loadPricing,
  getAmount,
  generateTxnId,
  generateHash,
  verifyPaymentHash,
  buildPaymentParams,
};
