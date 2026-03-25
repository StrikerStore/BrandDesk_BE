const db = require('../config/db');

// ── Hardcoded fallback (used before DB is seeded) ────────────────
const PLAN_LIMITS_FALLBACK = {
  trial:   { brands: 1, members: 1, threads_per_month: 200, templates: 5 },
  starter: { brands: 3, members: 3, threads_per_month: 1000, templates: 20 },
  pro:     { brands: Infinity, members: Infinity, threads_per_month: Infinity, templates: Infinity },
};

// ── In-memory cache ──────────────────────────────────────────────
let _planCache = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

async function loadPlans() {
  const now = Date.now();
  if (_planCache && now - _cacheTime < CACHE_TTL) return _planCache;

  try {
    const [rows] = await db.query('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order');
    if (!rows.length) {
      _planCache = PLAN_LIMITS_FALLBACK;
      _cacheTime = now;
      return _planCache;
    }

    const plans = {};
    for (const r of rows) {
      plans[r.name] = {
        brands:            r.max_brands ?? Infinity,
        members:           r.max_members ?? Infinity,
        threads_per_month: r.max_threads_per_month ?? Infinity,
        templates:         r.max_templates ?? Infinity,
      };
    }
    _planCache = plans;
    _cacheTime = now;
    return plans;
  } catch (err) {
    // Table might not exist yet — fall back to hardcoded
    if (err.code === 'ER_NO_SUCH_TABLE') {
      _planCache = PLAN_LIMITS_FALLBACK;
      _cacheTime = now;
      return _planCache;
    }
    throw err;
  }
}

function clearPlanCache() {
  _planCache = null;
  _cacheTime = 0;
}

// Keep backward-compatible PLAN_LIMITS export (sync accessor for non-middleware callers)
// Callers that need fresh data should use loadPlans() instead.
const PLAN_LIMITS = new Proxy(PLAN_LIMITS_FALLBACK, {
  get(target, prop) {
    if (_planCache && _planCache[prop]) return _planCache[prop];
    return target[prop];
  },
  ownKeys() {
    if (_planCache) return Object.keys(_planCache);
    return Object.keys(PLAN_LIMITS_FALLBACK);
  },
  getOwnPropertyDescriptor(target, prop) {
    const src = _planCache || target;
    if (prop in src) return { configurable: true, enumerable: true, value: src[prop] };
    return undefined;
  },
});

// ── checkPlanLimit(resource) ───────────────────────────────────────
// Middleware factory that checks a specific resource count against plan limits.
// Returns 402 with upgrade flag if over limit.
function checkPlanLimit(resource) {
  return async (req, res, next) => {
    try {
      const wsId = req.user?.workspace_id;
      if (!wsId) return next(); // No workspace context — skip

      const plans = await loadPlans();
      const [ws] = await db.query('SELECT plan FROM workspaces WHERE id = ?', [wsId]);
      const plan = ws[0]?.plan || 'trial';
      const limit = plans[plan]?.[resource];

      if (limit === undefined || limit === Infinity) return next();

      let count = 0;

      if (resource === 'brands') {
        const [rows] = await db.query(
          'SELECT COUNT(*) as cnt FROM brands WHERE workspace_id = ? AND is_active = 1',
          [wsId]
        );
        count = rows[0].cnt;
      } else if (resource === 'members') {
        const [rows] = await db.query(
          'SELECT COUNT(*) as cnt FROM workspace_members WHERE workspace_id = ?',
          [wsId]
        );
        count = rows[0].cnt;
      } else if (resource === 'templates') {
        const [rows] = await db.query(
          'SELECT COUNT(*) as cnt FROM templates WHERE workspace_id = ?',
          [wsId]
        );
        count = rows[0].cnt;
      } else if (resource === 'threads_per_month') {
        const [rows] = await db.query(
          `SELECT COUNT(*) as cnt FROM threads
           WHERE workspace_id = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
          [wsId]
        );
        count = rows[0].cnt;
      }

      if (count >= limit) {
        return res.status(402).json({
          error: `Your ${plan} plan allows up to ${limit} ${resource.replace('_', ' ')}. Upgrade to add more.`,
          upgrade: true,
          resource,
          limit,
          current: count,
        });
      }

      next();
    } catch (err) {
      console.error('Plan limit check error:', err);
      next(); // Don't block on errors — fail open
    }
  };
}

// ── checkTrialExpiry ───────────────────────────────────────────────
// Middleware that blocks access if trial has expired.
async function checkTrialExpiry(req, res, next) {
  try {
    const wsId = req.user?.workspace_id;
    if (!wsId) return next();

    const [ws] = await db.query(
      'SELECT plan, trial_ends_at FROM workspaces WHERE id = ?',
      [wsId]
    );

    if (!ws[0] || ws[0].plan !== 'trial') return next(); // Not on trial — skip

    if (ws[0].trial_ends_at && new Date(ws[0].trial_ends_at) < new Date()) {
      return res.status(402).json({
        error: 'Your free trial has expired. Upgrade to continue using BrandDesk.',
        upgrade: true,
        trialExpired: true,
      });
    }

    next();
  } catch (err) {
    console.error('Trial expiry check error:', err);
    next(); // Fail open
  }
}

module.exports = { PLAN_LIMITS, loadPlans, clearPlanCache, checkPlanLimit, checkTrialExpiry };
