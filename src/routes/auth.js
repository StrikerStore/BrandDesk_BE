const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const { google } = require('googleapis');
const { getAuthUrl, createOAuthClient } = require('../services/gmail');
const { sendAdminNotification, sendUserEmail } = require('../services/mailer');
const { generateToken, requireWorkspace, requireWorkspaceAdmin, JWT_SECRET } = require('../middleware/authMiddleware');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { normalizeShopDomain } = require('../services/shopify');

const router = express.Router();

// ── Helper: Create OAuth2 client for user sign-in (different redirect URI) ──
function createSigninOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_SIGNIN_REDIRECT_URI || 'http://localhost:3001/auth/google/signin/callback'
  );
}

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000,
  });
}

// ══════════════════════════════════════════════════════════════════════
//  USER SIGN-IN via Google (public — no auth required)
//  Separate from workspace Gmail connect flow.
// ══════════════════════════════════════════════════════════════════════

// GET /auth/google/signin?intent=login|signup
router.get('/google/signin', (req, res) => {
  const intent   = req.query.intent || 'login';
  const redirect = req.query.redirect || null;
  const client = createSigninOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'online',
    prompt:      'select_account',
    state:       Buffer.from(JSON.stringify({ intent, redirect })).toString('base64'),
    scope: [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
  res.redirect(url);
});

// GET /auth/google/signin/callback
router.get('/google/signin/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const onboardingUrl = process.env.ONBOARDING_URL || 'http://localhost:5174';
  const frontendUrl   = process.env.FRONTEND_URL   || 'http://localhost:5173';

  if (error) {
    return res.redirect(`${onboardingUrl}?auth_error=${encodeURIComponent(error)}`);
  }

  // Decode intent + redirect from state
  let intent = 'login';
  let redirect = null;
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64').toString());
    intent = parsed.intent || 'login';
    redirect = parsed.redirect || null;
  } catch {}

  try {
    const client = createSigninOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get Google profile
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();
    // profile = { id, email, name, picture, ... }

    if (intent === 'signup') {
      // ── SIGNUP FLOW ──────────────────────────────────────────
      const [existing] = await db.query('SELECT * FROM users WHERE email = ?', [profile.email.toLowerCase()]);
      if (existing.length) {
        // User exists — resume onboarding or redirect to inbox if already approved
        const existingUser = existing[0];
        const [members] = await db.query(
          `SELECT wm.workspace_id, wm.role as workspace_role, w.onboarding_status
           FROM workspace_members wm
           JOIN workspaces w ON w.id = wm.workspace_id
           WHERE wm.user_id = ? ORDER BY wm.workspace_id ASC LIMIT 1`,
          [existingUser.id]
        );
        if (!members.length) {
          return res.redirect(`${onboardingUrl}?auth_error=no_workspace`);
        }
        const ws = members[0];
        const resumeToken = generateToken(existingUser, ws.workspace_id, ws.workspace_role);
        setAuthCookie(res, resumeToken);
        if (ws.onboarding_status === 'approved') {
          return res.redirect(`${frontendUrl}?token=${resumeToken}`);
        }
        return res.redirect(`${onboardingUrl}/onboarding?token=${resumeToken}&resume=1`);
      }

      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // Create user (no password)
        const [userResult] = await conn.query(
          'INSERT INTO users (name, email, google_id, avatar_url, role) VALUES (?, ?, ?, ?, ?)',
          [profile.name, profile.email.toLowerCase(), profile.id, profile.picture || null, 'owner']
        );
        const userId = userResult.insertId;

        // Create workspace — explicitly set not_started so DEFAULT 'approved' doesn't apply
        const wsName = `${profile.name}'s Workspace`;
        let slug = slugify(wsName);
        const [slugCheck] = await conn.query('SELECT id FROM workspaces WHERE slug = ?', [slug]);
        if (slugCheck.length) slug = `${slug}-${Date.now().toString(36)}`;

        const [wsResult] = await conn.query(
          `INSERT INTO workspaces (slug, name, owner_user_id, plan, trial_ends_at, onboarding_status)
           VALUES (?, ?, ?, 'trial', DATE_ADD(NOW(), INTERVAL 14 DAY), 'not_started')`,
          [slug, wsName, userId]
        );
        const workspaceId = wsResult.insertId;

        // Add as owner
        await conn.query(
          'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
          [workspaceId, userId, 'owner']
        );

        // Seed default settings
        const DEFAULTS = [
          ['auto_ack_enabled',        'false'],
          ['auto_ack_delay_minutes',  '5'],
          ['auto_close_enabled',      'false'],
          ['auto_close_days',         '7'],
          ['sla_first_response_hours','4'],
          ['sla_resolve_hours',       '24'],
        ];
        for (const [key, value] of DEFAULTS) {
          await conn.query(
            'INSERT IGNORE INTO settings (workspace_id, key_name, value) VALUES (?, ?, ?)',
            [workspaceId, key, value]
          );
        }

        await conn.commit();

        // ── Admin alert: new signup ──
        sendAdminNotification({
          subject: `New Signup: ${profile.name} (${profile.email})`,
          html: `
            <h2 style="margin:0 0 16px;font-size:18px;color:#111827;">New User Signed Up</h2>
            <table style="border-collapse:collapse;font-size:14px;width:100%;">
              <tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Name</td><td style="padding:8px 12px;">${profile.name}</td></tr>
              <tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Email</td><td style="padding:8px 12px;">${profile.email}</td></tr>
              <tr><td style="padding:8px 12px;font-weight:600;color:#374151;">Workspace</td><td style="padding:8px 12px;">${wsName} (#${workspaceId})</td></tr>
            </table>`,
        }).catch(err => console.error('Signup admin notification failed:', err.message));

        // ── Welcome email to user ──
        sendUserEmail({
          to: profile.email,
          subject: 'Welcome to BrandDesk!',
          html: `
            <h2 style="margin:0 0 12px;font-size:20px;color:#111827;">Welcome aboard, ${profile.name}! 🎉</h2>
            <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 16px;">
              Your BrandDesk workspace is ready. Complete the onboarding steps to start managing your customer emails in one place.
            </p>
            <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 24px;">
              Here's what to do next:
            </p>
            <ol style="font-size:14px;color:#374151;line-height:2;padding-left:20px;margin:0 0 24px;">
              <li>Connect your Gmail account</li>
              <li>Add your first brand</li>
              <li>Sync your emails</li>
            </ol>
            <a href="${onboardingUrl}/onboarding" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Start Onboarding →</a>`,
        }).catch(err => console.error('Welcome email failed:', err.message));

        const user = { id: userId, name: profile.name, email: profile.email.toLowerCase(), role: 'owner' };
        const token = generateToken(user, workspaceId, 'owner');
        setAuthCookie(res, token);

        res.redirect(`${onboardingUrl}/onboarding?token=${token}`);
      } catch (err) {
        await conn.rollback();
        console.error('Signup callback error:', err.message);
        res.redirect(`${onboardingUrl}?auth_error=callback_failed`);
      } finally {
        conn.release();
      }

    } else {
      // ── LOGIN FLOW ───────────────────────────────────────────
      const isAdminLogin = redirect === 'admin';
      const adminUrl = process.env.ADMIN_URL || 'http://localhost:5175';
      const errorRedirectBase = isAdminLogin ? `${adminUrl}/login` : onboardingUrl;

      console.log(`[AUTH] Login attempt: email=${profile.email}, intent=${intent}, redirect=${redirect}`);

      const [rows] = await db.query(
        'SELECT * FROM users WHERE email = ? AND is_active = 1',
        [profile.email.toLowerCase()]
      );

      if (!rows.length) {
        console.log(`[AUTH] No account for ${profile.email}, redirecting to signup`);
        return res.redirect(`${onboardingUrl}?auth_error=no_account`);
      }

      const user = rows[0];
      console.log(`[AUTH] User found: id=${user.id}, email=${user.email}, role=${user.role}`);

      // Backfill google_id and avatar_url if missing
      if (!user.google_id || !user.avatar_url) {
        await db.query(
          'UPDATE users SET google_id = COALESCE(google_id, ?), avatar_url = COALESCE(avatar_url, ?) WHERE id = ?',
          [profile.id, profile.picture || null, user.id]
        );
      }

      // Admin panel redirect — no workspace needed for platform admins
      if (isAdminLogin) {
        if (user.role !== 'admin') {
          console.log(`[AUTH] FAILED: user ${user.email} is not admin (role=${user.role})`);
          return res.redirect(`${adminUrl}/login?auth_error=not_admin`);
        }
        const token = generateToken(user);
        setAuthCookie(res, token);
        console.log(`[AUTH] SUCCESS: admin login for ${user.email}, redirecting to ${adminUrl}`);
        return res.redirect(`${adminUrl}?token=${token}`);
      }

      // Look up workspaces
      const [members] = await db.query(
        `SELECT wm.workspace_id, wm.role as workspace_role, w.name as workspace_name,
                w.onboarding_status
         FROM workspace_members wm
         JOIN workspaces w ON w.id = wm.workspace_id
         WHERE wm.user_id = ? AND w.is_active = 1
         ORDER BY wm.workspace_id ASC`,
        [user.id]
      );

      if (members.length === 0) {
        return res.redirect(`${onboardingUrl}?auth_error=no_workspace`);
      }

      let token;
      if (members.length === 1) {
        const ws = members[0];
        token = generateToken(user, ws.workspace_id, ws.workspace_role);
        // Gate: if workspace not yet approved, send back to onboarding
        if (ws.onboarding_status !== 'approved') {
          setAuthCookie(res, token);
          return res.redirect(`${onboardingUrl}/onboarding?token=${token}&status=${ws.onboarding_status}`);
        }
      } else {
        // Multi-workspace — inbox app will show workspace switcher
        token = generateToken(user);
      }

      setAuthCookie(res, token);
      res.redirect(`${frontendUrl}?token=${token}`);
    }
  } catch (err) {
    console.error('[AUTH] Google signin callback error:', err.message, err.stack);
    const adminUrl = process.env.ADMIN_URL || 'http://localhost:5175';
    const errorRedirectBase = redirect === 'admin' ? `${adminUrl}/login` : onboardingUrl;
    res.redirect(`${errorRedirectBase}?auth_error=callback_failed`);
  }
});

// Step 1: Redirect to Google consent — workspace admin only
// Encodes workspace_id, brand_id, origin in OAuth `state` param.
router.get('/google', requireWorkspaceAdmin, (req, res) => {
  const brandId = req.query.brand_id ? parseInt(req.query.brand_id) : null;
  const origin  = req.query.origin || 'onboarding';
  const url = getAuthUrl(req.user.workspace_id, brandId, origin);
  res.redirect(url);
});

// Step 2: Google redirects back with code + state (JSON or legacy int)
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const frontendUrl   = process.env.FRONTEND_URL   || 'http://localhost:5173';
  const onboardingUrl = process.env.ONBOARDING_URL || frontendUrl;

  if (error) {
    return res.redirect(`${frontendUrl}?auth_error=${encodeURIComponent(error)}`);
  }

  // Parse state — supports new JSON format and legacy plain integer
  let workspaceId, brandId, origin;
  try {
    const parsed = JSON.parse(state);
    workspaceId = parsed.workspace_id;
    brandId     = parsed.brand_id || null;
    origin      = parsed.origin || 'onboarding';
  } catch {
    workspaceId = parseInt(state);
    brandId     = null;
    origin      = 'onboarding';
  }

  if (!workspaceId || isNaN(workspaceId)) {
    return res.redirect(`${frontendUrl}?auth_error=invalid_state`);
  }

  try {
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get connected Gmail address
    const oauth2    = google.oauth2({ version: 'v2', auth: client });
    const userInfo  = await oauth2.userinfo.get();
    const gmailEmail = userInfo.data.email;

    // ── Trial duplicate check: prevent same Gmail from claiming trial twice ──
    const [currentWs] = await db.query('SELECT plan FROM workspaces WHERE id = ?', [workspaceId]);
    if (currentWs.length && currentWs[0].plan === 'trial') {
      const [existingGmail] = await db.query(
        'SELECT gt.workspace_id FROM gmail_tokens gt JOIN workspaces w ON w.id = gt.workspace_id WHERE gt.email = ? AND gt.workspace_id != ?',
        [gmailEmail, workspaceId]
      );
      if (existingGmail.length) {
        if (origin === 'settings') {
          return res.redirect(`${frontendUrl}?auth_error=gmail_already_used`);
        }
        return res.redirect(`${onboardingUrl}/onboarding?auth_error=gmail_already_used`);
      }
    }

    // Store (or update) tokens for this workspace+email combo
    await db.query(
      `INSERT INTO gmail_tokens (workspace_id, email, access_token, refresh_token, expiry_date)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token  = VALUES(access_token),
         refresh_token = IF(VALUES(refresh_token) IS NOT NULL, VALUES(refresh_token), refresh_token),
         expiry_date   = VALUES(expiry_date),
         updated_at    = NOW()`,
      [workspaceId, gmailEmail, tokens.access_token, tokens.refresh_token, tokens.expiry_date]
    );

    // Get the gmail_token row id
    const [tokenRow] = await db.query(
      'SELECT id FROM gmail_tokens WHERE workspace_id = ? AND email = ?',
      [workspaceId, gmailEmail]
    );
    const gmailTokenId = tokenRow[0].id;

    // If brandId provided, link brand to this gmail token
    if (brandId) {
      await db.query(
        'UPDATE brands SET gmail_token_id = ? WHERE id = ? AND workspace_id = ?',
        [gmailTokenId, brandId, workspaceId]
      );
    }

    // Advance onboarding status if still in early stages
    await db.query(
      `UPDATE workspaces SET onboarding_status = 'details_submitted'
       WHERE id = ? AND onboarding_status IN ('not_started', 'details_submitted')`,
      [workspaceId]
    );

    // Redirect based on origin
    if (origin === 'settings') {
      return res.redirect(`${frontendUrl}?gmail_connected=1`);
    }
    res.redirect(`${onboardingUrl}/onboarding?auth=success&step=2`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`${onboardingUrl}?auth_error=callback_failed`);
  }
});

// GET /auth/status — workspace-scoped Gmail connection status
router.get('/status', requireWorkspace, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT email, updated_at FROM gmail_tokens WHERE workspace_id = ?',
      [req.user.workspace_id]
    );
    if (rows.length) {
      res.json({ authenticated: true, email: rows[0].email, updated_at: rows[0].updated_at });
    } else {
      res.json({ authenticated: false });
    }
  } catch {
    res.json({ authenticated: false });
  }
});

// POST /auth/logout — disconnect Gmail for this workspace (admin only)
router.post('/logout', requireWorkspaceAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM gmail_tokens WHERE workspace_id = ?', [req.user.workspace_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect Gmail' });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  SHOPIFY OAuth — connect a brand's Shopify store
// ══════════════════════════════════════════════════════════════════════

// GET /auth/shopify/install?shop= — Shopify App Store install flow
// Called when merchant installs from Shopify App Store (no BrandDesk auth needed)
router.get('/shopify/install', (req, res) => {
  const { shop } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (!shop) return res.status(400).send('Missing shop parameter');

  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) return res.status(400).send('Invalid shop domain');

  // State includes install=true flag so callback knows this is an app store install
  const state = jwt.sign({ install: true, shop: normalizedShop }, JWT_SECRET, { expiresIn: '10m' });

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const redirectUri = process.env.SHOPIFY_REDIRECT_URI || 'http://localhost:3001/auth/shopify/callback';
  const scopes = 'read_customers,read_orders,read_fulfillments';

  const authUrl = `https://${normalizedShop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});

// GET /auth/shopify?brand_id=&shop=&origin= — Manual connect from BrandDesk Settings or Onboarding
router.get('/shopify', requireWorkspaceAdmin, async (req, res) => {
  const { brand_id, shop, origin } = req.query;
  const wsId = req.user.workspace_id;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (!brand_id || !shop) {
    return res.redirect(`${frontendUrl}?shopify_error=missing_params`);
  }

  // Validate brand belongs to this workspace
  const [brands] = await db.query(
    'SELECT id FROM brands WHERE id = ? AND workspace_id = ? AND is_active = 1',
    [brand_id, wsId]
  );
  if (!brands.length) {
    return res.redirect(`${frontendUrl}?shopify_error=brand_not_found`);
  }

  const normalizedShop = normalizeShopDomain(shop);
  if (!normalizedShop) {
    return res.redirect(`${frontendUrl}?shopify_error=invalid_shop`);
  }

  // Create signed state JWT (includes origin for redirect after callback)
  const state = jwt.sign({ brand_id: parseInt(brand_id), workspace_id: wsId, shop: normalizedShop, origin: origin || 'settings' }, JWT_SECRET, { expiresIn: '10m' });

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const redirectUri = process.env.SHOPIFY_REDIRECT_URI || `http://localhost:3001/auth/shopify/callback`;
  const scopes = 'read_customers,read_orders,read_fulfillments';

  const authUrl = `https://${normalizedShop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});

// GET /auth/shopify/callback
router.get('/shopify/callback', async (req, res) => {
  const { code, shop, state, hmac } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (!code || !state) {
    return res.redirect(`${frontendUrl}?shopify_error=missing_params`);
  }

  // Verify state JWT
  let stateData;
  try {
    stateData = jwt.verify(state, JWT_SECRET);
  } catch {
    return res.redirect(`${frontendUrl}?shopify_error=invalid_state`);
  }

  // Verify HMAC from Shopify
  if (hmac) {
    const secret = process.env.SHOPIFY_CLIENT_SECRET;
    const params = { ...req.query };
    delete params.hmac;
    delete params.signature;
    const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const digest = crypto.createHmac('sha256', secret).update(sorted).digest('hex');
    if (digest !== hmac) {
      return res.redirect(`${frontendUrl}?shopify_error=hmac_invalid`);
    }
  }

  try {
    // Exchange code for permanent access token
    const normalizedShop = normalizeShopDomain(shop || stateData.shop);
    const { data: tokenData } = await axios.post(`https://${normalizedShop}/admin/oauth/access_token`, {
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      code,
    });

    const accessToken = tokenData.access_token;

    if (stateData.install) {
      // ── APP STORE INSTALL FLOW ──
      // Auto-connect: find a brand with matching shopify_store, or find workspace by shop owner email
      try {
        // First try: match by shopify_store domain
        const [existingBrands] = await db.query(
          'SELECT id, workspace_id FROM brands WHERE shopify_store = ? AND is_active = 1 LIMIT 1',
          [normalizedShop]
        );

        if (existingBrands.length) {
          // Update existing brand with token
          await db.query(
            'UPDATE brands SET shopify_token = ? WHERE id = ?',
            [accessToken, existingBrands[0].id]
          );
        } else {
          // Get shop info from Shopify to find the owner's email
          const shopInfo = await axios.get(`https://${normalizedShop}/admin/api/2024-01/shop.json`, {
            headers: { 'X-Shopify-Access-Token': accessToken },
          });
          const shopEmail = shopInfo.data.shop?.email;
          const shopName  = shopInfo.data.shop?.name || normalizedShop.replace('.myshopify.com', '');

          if (shopEmail) {
            // Find user by email → find their workspace → create/update brand
            const [users] = await db.query('SELECT id FROM users WHERE email = ? AND is_active = 1', [shopEmail.toLowerCase()]);
            if (users.length) {
              const [members] = await db.query(
                `SELECT workspace_id FROM workspace_members WHERE user_id = ? ORDER BY workspace_id ASC LIMIT 1`,
                [users[0].id]
              );
              if (members.length) {
                const wsId = members[0].workspace_id;
                const widgetToken = require('crypto').randomBytes(32).toString('hex');
                // Create a brand for this shop
                await db.query(
                  `INSERT INTO brands (workspace_id, label, email, name, shopify_store, shopify_token, widget_token)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE shopify_token = VALUES(shopify_token), shopify_store = VALUES(shopify_store)`,
                  [wsId, shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), shopEmail, shopName, normalizedShop, accessToken, widgetToken]
                );
              }
            }
          }
        }
      } catch (autoErr) {
        console.error('Shopify auto-connect error:', autoErr.message);
        // Don't fail the install — token exchange succeeded
      }

      // Redirect to a success page (Shopify expects a redirect after install)
      res.redirect(`${frontendUrl}?shopify=installed`);
    } else {
      // ── MANUAL CONNECT FLOW ── (from BrandDesk Settings or Onboarding)

      // Trial duplicate check: prevent same Shopify store from claiming trial twice
      const [manualWs] = await db.query('SELECT plan FROM workspaces WHERE id = ?', [stateData.workspace_id]);
      if (manualWs.length && manualWs[0].plan === 'trial') {
        const [existingShop] = await db.query(
          'SELECT b.workspace_id FROM brands b JOIN workspaces w ON w.id = b.workspace_id WHERE b.shopify_store = ? AND b.workspace_id != ? AND b.is_active = 1',
          [normalizedShop, stateData.workspace_id]
        );
        if (existingShop.length) {
          const onboardingUrl = process.env.ONBOARDING_URL || frontendUrl;
          const redirectUrl = stateData.origin === 'onboarding'
            ? `${onboardingUrl}/onboarding?shopify_error=store_already_used`
            : `${frontendUrl}?shopify_error=store_already_used`;
          return res.redirect(redirectUrl);
        }
      }

      await db.query(
        'UPDATE brands SET shopify_store = ?, shopify_token = ? WHERE id = ? AND workspace_id = ?',
        [normalizedShop, accessToken, stateData.brand_id, stateData.workspace_id]
      );

      if (stateData.origin === 'onboarding') {
        const onboardingUrl = process.env.ONBOARDING_URL || frontendUrl;
        res.redirect(`${onboardingUrl}/onboarding?shopify=connected&step=2`);
      } else {
        res.redirect(`${frontendUrl}?shopify=connected`);
      }
    }
  } catch (err) {
    console.error('Shopify OAuth callback error:', err.message);
    res.redirect(`${frontendUrl}?shopify_error=callback_failed`);
  }
});

module.exports = router;
