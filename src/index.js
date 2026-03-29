require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');

const threadRoutes     = require('./routes/threads');
const customerRoutes   = require('./routes/customers');
const templateRoutes   = require('./routes/templates');
const brandRoutes      = require('./routes/brands');
const analyticsRoutes  = require('./routes/analytics');
const viewsRoutes      = require('./routes/views');
const settingsRoutes   = require('./routes/settings');
const usersRoutes      = require('./routes/users');
const workspacesRoutes = require('./routes/workspaces');
const ordersRoutes     = require('./routes/orders');
const aiRoutes         = require('./routes/ai');
const authRoutes          = require('./routes/auth');
const subscriptionRoutes  = require('./routes/subscriptions');
const adminRoutes         = require('./routes/admin');
const widgetRoutes        = require('./routes/widget');
const supportRoutes       = require('./routes/support');
const demoRoutes          = require('./routes/demo');
const shopifyWebhookRoutes = require('./routes/shopifyWebhooks');
const db = require('./config/db');
const { syncThreads } = require('./services/gmail');
const { runAutoAck, runAutoClose } = require('./services/automation');
const { requireAuth, requireAdmin, requireWorkspace } = require('./middleware/authMiddleware');
const { globalLimiter, authLimiter, aiLimiter, widgetLimiter, demoLimiter } = require('./middleware/rateLimiter');

const app  = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// ── Security headers ──────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── Rate limiting ────────────────────────────────────────────
app.use(globalLimiter);

// ── CORS ──────────────────────────────────────────────────────
// Always include production origins regardless of NODE_ENV
// so the app works even if NODE_ENV is not explicitly set on Railway.
const allowedOrigins = [
  'https://www.branddesk.in',
  'https://branddesk.in',
  'https://branddesk-frontend-production.up.railway.app',
  process.env.FRONTEND_URL,     // inbox app origin
  process.env.ONBOARDING_URL,   // onboarding/marketing site origin
  process.env.ADMIN_URL,        // super admin panel origin
  'https://admin.branddesk.in',
  // dev origins
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:3000',
].filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);   // allow server-to-server / curl
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

// ── CORS — skip for PayU callbacks (they POST from secure.payu.in) ──
const CORS_BYPASS_PATHS = [
  '/api/subscriptions/success', '/api/subscriptions/failure', '/api/webhooks/payu',
  '/api/webhooks/shopify',
  '/api/webhooks/shopify/customers/data_request',
  '/api/webhooks/shopify/customers/redact',
  '/api/webhooks/shopify/shop/redact',
];
// Widget routes: allow any origin (storefront domains vary; auth is via brand_token)
const widgetCors = cors({ origin: true, credentials: false });
app.use('/api/widget', widgetCors);

app.options('*', cors(corsOptions));
app.use((req, res, next) => {
  if (CORS_BYPASS_PATHS.includes(req.path)) return next();
  if (req.path.startsWith('/api/widget')) return next(); // already handled above
  cors(corsOptions)(req, res, next);
});

// Shopify compliance webhooks — mounted BEFORE express.json() so they get the raw body for HMAC verification
app.use('/api/webhooks/shopify', express.raw({ type: 'application/json' }), shopifyWebhookRoutes);

app.use(express.json({ limit: '2mb' })); // tighter limit
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// ── Public routes ─────────────────────────────────────────────
app.use('/api/users', authLimiter, usersRoutes); // login/logout are public; admin routes protected inside
app.get('/health',    (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Gmail OAuth ───────────────────────────────────────────────
// /auth/google requires admin (inside route)
// /auth/google/callback is public (Google redirect)
app.use('/auth', authRoutes);

// ── Subscription routes (mixed auth — initiate/cancel require admin, success/failure are public PayU callbacks)
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/webhooks',      subscriptionRoutes);

// ── Workspace routes (auth required, workspace lookup inside) ─
app.use('/api/workspaces', workspacesRoutes);

// ── Protected API routes ──────────────────────────────────────
app.use('/api/threads',   requireAuth, threadRoutes);
app.use('/api/customers', requireAuth, customerRoutes);
app.use('/api/templates', requireAuth, templateRoutes);
app.use('/api/brands',      requireAuth, brandRoutes);
app.use('/api/onboarding',  requireAuth, brandRoutes);
app.use('/api/analytics', requireAuth, analyticsRoutes);
app.use('/api/views',     requireAuth, viewsRoutes);
app.use('/api/settings',  requireAuth, settingsRoutes);
app.use('/api/orders',    requireAuth, ordersRoutes);
app.use('/api/ai',        requireAuth, aiLimiter, aiRoutes);
app.use('/api/support',   requireAuth, supportRoutes);
app.use('/api/admin',     requireAdmin, adminRoutes);
app.use('/api/widget',    widgetLimiter, widgetRoutes);  // public — widget auth via brand_token
app.use('/api/demo',     demoLimiter, demoRoutes);   // public — demo request form

// Manual sync — workspace-scoped
app.post('/api/sync', requireWorkspace, async (req, res) => {
  try {
    const fullSync = req.query.full === 'true';
    if (fullSync && req.user.workspace_role === 'agent') {
      return res.status(403).json({ error: 'Full resync requires workspace admin access' });
    }
    const result = await syncThreads(req.user.workspace_id, fullSync);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: isProd ? 'Internal server error' : err.message });
});

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Cron jobs — loop all active workspaces ────────────────────
const pollMinutes = Math.max(1, Math.round(parseInt(process.env.POLL_INTERVAL || '60000') / 60000));

async function getActiveWorkspaceIds() {
  const [rows] = await db.query('SELECT id FROM workspaces WHERE is_active = 1');
  return rows.map(r => r.id);
}

cron.schedule(`*/${pollMinutes} * * * *`, async () => {
  try {
    const ids = await getActiveWorkspaceIds();
    for (const wsId of ids) {
      try { await syncThreads(wsId, false); }
      catch (err) {
        if (!err.message?.includes('Not authenticated')) {
          console.error(`Sync error [ws:${wsId}]:`, err.message);
        }
      }
    }
  } catch (err) { console.error('Sync cron outer error:', err.message); }
});

cron.schedule('* * * * *', async () => {
  try {
    const ids = await getActiveWorkspaceIds();
    for (const wsId of ids) {
      try { await runAutoAck(wsId); }
      catch (err) { console.error(`Auto-ack error [ws:${wsId}]:`, err.message); }
    }
  } catch (err) { console.error('Auto-ack cron outer error:', err.message); }
});

cron.schedule('0 0 * * *', async () => {
  try {
    const ids = await getActiveWorkspaceIds();
    for (const wsId of ids) {
      try { await runAutoClose(wsId); }
      catch (err) { console.error(`Auto-close error [ws:${wsId}]:`, err.message); }
    }
  } catch (err) { console.error('Auto-close cron outer error:', err.message); }
});

// ── Subscription lifecycle crons (daily at 00:30) ────────────────
cron.schedule('30 0 * * *', async () => {
  console.log('🔄 Running subscription lifecycle checks...');

  // 1. Downgrade cancelled subscriptions past their period end
  try {
    const [cancelled] = await db.query(
      `SELECT s.id, s.workspace_id, w.pending_plan_change
       FROM subscriptions s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.status = 'cancelled' AND s.current_period_end < NOW()`
    );
    for (const sub of cancelled) {
      const newPlan = sub.pending_plan_change || 'trial';
      await db.query("UPDATE workspaces SET plan = ?, pending_plan_change = NULL WHERE id = ?", [newPlan, sub.workspace_id]);
      await db.query("UPDATE subscriptions SET status = 'expired' WHERE id = ?", [sub.id]);
      console.log(`  🔻 Downgraded workspace ${sub.workspace_id} to ${newPlan} (subscription expired)`);
    }
  } catch (err) { console.error('Subscription downgrade cron error:', err.message); }

  // 2. Handle past-due grace period (3 days)
  try {
    const [pastDue] = await db.query(
      `SELECT s.id, s.workspace_id
       FROM subscriptions s
       WHERE s.status = 'past_due' AND s.updated_at < DATE_SUB(NOW(), INTERVAL 3 DAY)`
    );
    for (const sub of pastDue) {
      await db.query("UPDATE workspaces SET plan = 'trial', pending_plan_change = NULL WHERE id = ?", [sub.workspace_id]);
      await db.query("UPDATE subscriptions SET status = 'expired' WHERE id = ?", [sub.id]);
      console.log(`  🔻 Past-due grace expired for workspace ${sub.workspace_id} — downgraded to trial`);
    }
  } catch (err) { console.error('Past-due grace cron error:', err.message); }
});

// ── Seed super-admin on startup (skip if already exists) ─────
async function ensureSuperAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  if (!email) return;
  try {
    const [rows] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (rows.length) return;
    await db.query(
      'INSERT INTO users (name, email, role, is_active) VALUES (?, ?, ?, 1)',
      [process.env.ADMIN_NAME || 'Admin', email, 'admin']
    );
    console.log(`✅ Super-admin seeded: ${email}`);
  } catch (err) {
    console.error('Super-admin seed error:', err.message);
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 BrandDesk backend running on port ${PORT}`);
  console.log(`🔒 Environment: ${isProd ? 'production' : 'development'}`);
  if (isProd) console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
  await ensureSuperAdmin();
});

// Test commit for deployment - ignore