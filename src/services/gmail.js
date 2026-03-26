const { google } = require('googleapis');
const db = require('../config/db');
const { parseShopifyEmail, buildChatBody, extractAllFields } = require('./emailParser');
const { getBrandsByWorkspace } = require('./brands');
const { PLAN_LIMITS } = require('../middleware/planLimits');

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(workspaceId, brandId, origin) {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    state:       JSON.stringify({ workspace_id: workspaceId, brand_id: brandId || null, origin: origin || 'onboarding' }),
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
}

async function getAuthenticatedClient(workspaceId) {
  const [rows] = await db.query(
    'SELECT * FROM gmail_tokens WHERE workspace_id = ? LIMIT 1',
    [workspaceId]
  );
  const tokens = rows[0];
  if (!tokens) throw new Error(`Not authenticated — visit /auth/google to connect Gmail`);

  return _buildClient(tokens);
}

async function getAuthenticatedClientForBrand(brandId) {
  const [rows] = await db.query(
    `SELECT gt.* FROM gmail_tokens gt
     JOIN brands b ON b.gmail_token_id = gt.id
     WHERE b.id = ?`,
    [brandId]
  );
  const tokens = rows[0];
  if (!tokens) throw new Error(`No Gmail account linked to brand ${brandId}`);

  return _buildClient(tokens);
}

function _buildClient(tokenRow) {
  const client = createOAuthClient();
  client.setCredentials({
    access_token:  tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date:   tokenRow.expiry_date,
  });

  client.on('tokens', async (newTokens) => {
    await db.query(
      'UPDATE gmail_tokens SET access_token = ?, expiry_date = ?, updated_at = NOW() WHERE id = ?',
      [newTokens.access_token, newTokens.expiry_date, tokenRow.id]
    );
  });

  return client;
}

// Decode base64url Gmail message body
function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Extract plain text or HTML from message payload
function extractBody(payload) {
  let text = '';
  let html = '';

  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) text = decodeBody(part.body.data);
    if (part.mimeType === 'text/html'  && part.body?.data) html = decodeBody(part.body.data);
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return { text, html };
}

function getHeader(headers, name) {
  const h = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

// Strip quoted reply text
function stripQuoted(text) {
  const lines  = text.split('\n');
  const cutoff = lines.findIndex(l =>
    (l.startsWith('On ') && l.includes('wrote:')) ||
    l.trim().startsWith('-----Original Message-----') ||
    (l.trim().startsWith('From:') && lines.indexOf(l) > 5)
  );
  return cutoff > 0 ? lines.slice(0, cutoff).join('\n').trim() : text.trim();
}

// Get timestamp of most recent thread per brand for this workspace
async function getLastSyncTime(workspaceId, brandName) {
  const [rows] = await db.query(
    'SELECT MAX(created_at) as last FROM threads WHERE workspace_id = ? AND brand = ?',
    [workspaceId, brandName]
  );
  return rows[0]?.last || null;
}

// Build a set of email addresses that belong to "us" for a workspace
async function buildOurEmails(workspaceId) {
  const brands = await getBrandsByWorkspace(workspaceId);
  const brandEmails = brands.map(b => b.email.toLowerCase());

  // Also include all connected Gmail addresses
  const [tokenRows] = await db.query(
    'SELECT email FROM gmail_tokens WHERE workspace_id = ?', [workspaceId]
  );
  for (const tr of tokenRows) {
    if (tr.email) brandEmails.push(tr.email.toLowerCase());
  }

  // Collect domains from brand emails
  const domains = [...new Set(brandEmails.map(e => e.split('@')[1]).filter(Boolean))];

  return { emails: brandEmails, domains };
}

function isOurEmailFromSet(emailStr, { emails, domains }) {
  if (!emailStr) return false;
  const lower = emailStr.toLowerCase();
  if (emails.some(e => lower.includes(e))) return true;
  if (domains.some(d => lower.includes(`@${d}`))) return true;
  return false;
}

// ── Incremental sync per workspace ───────────────────────────
async function syncThreads(workspaceId, fullSync = false, targetBrandId = null) {
  let brands;
  if (targetBrandId) {
    // Sync a single brand only (used after admin approval)
    const allBrands = await getBrandsByWorkspace(workspaceId);
    brands = allBrands.filter(b => b.id === targetBrandId);
  } else {
    brands = await getBrandsByWorkspace(workspaceId);
    // Only sync approved brands with labels
    brands = brands.filter(b => (!b.brand_status || b.brand_status === 'approved') && b.label);
  }

  let newThreads     = 0;
  let updatedThreads = 0;
  let threadLimitReached = false;

  for (const brand of brands) {
    try {
      // Use brand-specific Gmail client if available, else workspace default
      let auth;
      if (brand.gmail_token_id) {
        auth = await getAuthenticatedClientForBrand(brand.id);
      } else {
        auth = await getAuthenticatedClient(workspaceId);
      }
      const gmail = google.gmail({ version: 'v1', auth });
      const lastSync = fullSync ? null : await getLastSyncTime(workspaceId, brand.name);

      let query = `label:${brand.label}`;
      if (lastSync) {
        const epochSeconds = Math.floor(new Date(lastSync).getTime() / 1000) - 300;
        query += ` after:${epochSeconds}`;
      }

      const allThreadIds = [];
      let pageToken      = undefined;
      const maxToFetch   = fullSync ? 500 : 20;

      do {
        const listRes = await gmail.users.threads.list({
          userId:     'me',
          q:          query,
          maxResults: Math.min(maxToFetch - allThreadIds.length, 100),
          ...(pageToken ? { pageToken } : {}),
        });

        const batch = listRes.data.threads || [];
        allThreadIds.push(...batch);
        pageToken = listRes.data.nextPageToken;
      } while (pageToken && allThreadIds.length < maxToFetch);

      if (!allThreadIds.length) continue;

      console.log(`📥 [ws:${workspaceId}] ${brand.name}: fetching ${allThreadIds.length} threads…`);

      // Check thread limit for non-pro plans before syncing new threads
      const [wsRow] = await db.query('SELECT plan FROM workspaces WHERE id = ?', [workspaceId]);
      const plan = wsRow[0]?.plan || 'trial';
      const threadLimit = PLAN_LIMITS[plan]?.threads_per_month;
      let limitReached = false;

      for (const t of allThreadIds) {
        const [existing] = await db.query(
          'SELECT id FROM threads WHERE gmail_thread_id = ? AND workspace_id = ?',
          [t.id, workspaceId]
        );
        const isNew = existing.length === 0;

        if (isNew && threadLimit !== Infinity) {
          const [countRow] = await db.query(
            `SELECT COUNT(*) as cnt FROM threads WHERE workspace_id = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
            [workspaceId]
          );
          if (countRow[0].cnt >= threadLimit) {
            limitReached = true;
            break;
          }
        }

        await processThread(gmail, t.id, brand, workspaceId);
        if (isNew) newThreads++;
        else updatedThreads++;
      }

      if (limitReached) {
        threadLimitReached = true;
        console.log(`⚠️ [ws:${workspaceId}] Thread limit reached (${threadLimit} threads/mo on ${plan} plan). Stopping sync.`);
        break;
      }

    } catch (err) {
      const isAuthError = /invalid.credentials|token.*expired|unauthorized|not authenticated/i.test(err.message);
      if (isAuthError) {
        console.error(`🔑 [ws:${workspaceId}] Gmail auth error for brand "${brand.name}" — token may be expired. User must re-connect Gmail. Details: ${err.message}`);
      } else {
        console.error(`[ws:${workspaceId}] Error syncing brand "${brand.name}":`, err.message);
      }
    }
  }

  const summary = `📬 [ws:${workspaceId}] Sync complete — ${newThreads} new, ${updatedThreads} updated`;
  console.log(summary);
  return { newThreads, updatedThreads, total: newThreads + updatedThreads, threadLimitReached };
}

async function processThread(gmail, gmailThreadId, brand, workspaceId) {
  const [existing] = await db.query(
    'SELECT id FROM threads WHERE gmail_thread_id = ? AND workspace_id = ?',
    [gmailThreadId, workspaceId]
  );

  const threadRes = await gmail.users.threads.get({
    userId: 'me', id: gmailThreadId, format: 'full',
  });

  const gmailThread = threadRes.data;
  const messages    = gmailThread.messages || [];
  if (!messages.length) return;

  const firstMsg  = messages[0];
  const headers   = firstMsg.payload?.headers || [];
  const subject   = getHeader(headers, 'Subject') || '(No subject)';
  const fromRaw   = getHeader(headers, 'From');
  const replyTo   = getHeader(headers, 'Reply-To');
  const sentAt    = new Date(parseInt(firstMsg.internalDate));

  const { text: rawText, html: rawHtml } = extractBody(firstMsg.payload);
  const rawBody = rawText || rawHtml.replace(/<[^>]+>/g, '');

  const parsed = parseShopifyEmail(fromRaw, replyTo, rawBody);

  let customerEmail, customerName, customerPhone, customerCountry;
  let orderNumber, issueCategory, subIssue, ticketId, isShopifyForm;
  let extraFields = null;

  if (parsed) {
    customerEmail   = parsed.customerEmail;
    customerName    = parsed.customerName;
    customerPhone   = parsed.customerPhone;
    customerCountry = parsed.customerCountry;
    orderNumber     = parsed.orderNumber;
    issueCategory   = parsed.issueCategory;
    subIssue        = parsed.subIssue;
    ticketId        = parsed.ticketId;
    isShopifyForm   = true;
    extraFields     = Object.keys(parsed.extraFields || {}).length ? parsed.extraFields : null;
  } else {
    const fromMatch = fromRaw.match(/^(.*?)\s*<(.+?)>$/) || [null, fromRaw, fromRaw];
    let rawName     = fromMatch[1]?.trim().replace(/"/g, '') || '';
    rawName         = rawName.replace(/\s*\(Shopify\)\s*/i, '').trim();
    customerName    = rawName || null;
    customerEmail   = fromMatch[2]?.trim() || fromRaw;
    isShopifyForm   = false;
  }

  // Build set of our emails for direction detection
  const ourEmailSet = await buildOurEmails(workspaceId);

  const lastMsg   = messages[messages.length - 1];
  const lastFrom  = getHeader(lastMsg.payload?.headers || [], 'From');
  const isUnread  = !isOurEmailFromSet(lastFrom, ourEmailSet);

  let threadId;

  if (existing.length) {
    threadId = existing[0].id;

    // If the latest message is from the customer (inbound), reopen the thread
    // so it reappears in the agent's "open" inbox filter.
    const reopenClause = isUnread
      ? ", status = CASE WHEN status IN ('in_progress','resolved') THEN 'open' ELSE status END, status_changed_at = CASE WHEN status IN ('in_progress','resolved') THEN NOW() ELSE status_changed_at END"
      : '';

    await db.query(
      `UPDATE threads SET
        is_unread=?, updated_at=NOW()${reopenClause},
        ticket_id=COALESCE(ticket_id, ?),
        order_number=COALESCE(order_number, ?),
        issue_category=COALESCE(issue_category, ?),
        sub_issue=COALESCE(sub_issue, ?),
        customer_phone=COALESCE(customer_phone, ?),
        customer_country=COALESCE(customer_country, ?)
       WHERE id=? AND workspace_id=?`,
      [isUnread ? 1 : 0, ticketId, orderNumber, issueCategory, subIssue,
       customerPhone, customerCountry, existing[0].id, workspaceId]
    );
  } else {
    const [result] = await db.query(
      `INSERT INTO threads
        (workspace_id, gmail_thread_id, subject, brand, brand_email, customer_email, customer_name,
         is_unread, is_shopify_form, ticket_id, order_number, issue_category,
         sub_issue, customer_phone, customer_country, extra_fields, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, gmailThreadId, subject, brand.name, brand.email, customerEmail, customerName,
       isUnread ? 1 : 0, isShopifyForm ? 1 : 0, ticketId || null, orderNumber || null,
       issueCategory || null, subIssue || null, customerPhone || null, customerCountry || null,
       extraFields ? JSON.stringify(extraFields) : null, sentAt]
    );
    threadId = result.insertId;

    // Upsert customer
    await db.query(
      `INSERT INTO customers (workspace_id, email, name, phone) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name  = IF(name  IS NULL OR name='',  VALUES(name),  name),
         phone = IF(phone IS NULL OR phone='', VALUES(phone), phone)`,
      [workspaceId, customerEmail, customerName || '', customerPhone || null]
    );
  }

  // Sync messages
  for (let i = 0; i < messages.length; i++) {
    const msg            = messages[i];
    const isFirstMessage = i === 0;

    const [msgExisting] = await db.query(
      'SELECT id FROM messages WHERE gmail_message_id = ? AND workspace_id = ?',
      [msg.id, workspaceId]
    );
    if (msgExisting.length) continue;

    const msgHeaders = msg.payload?.headers || [];
    const from       = getHeader(msgHeaders, 'From');
    const direction  = isOurEmailFromSet(from, ourEmailSet) ? 'outbound' : 'inbound';
    const { text, html } = extractBody(msg.payload);
    const rawMsgBody = text || html.replace(/<[^>]+>/g, '');
    const msgDate    = new Date(parseInt(msg.internalDate));

    let displayBody;
    if (isFirstMessage && direction === 'inbound') {
      const msgReplyTo = getHeader(msgHeaders, 'Reply-To');
      const msgParsed  = parseShopifyEmail(from, msgReplyTo, rawMsgBody);
      displayBody = msgParsed ? buildChatBody(msgParsed) : stripQuoted(rawMsgBody);
    } else {
      displayBody = stripQuoted(rawMsgBody);
    }

    await db.query(
      `INSERT IGNORE INTO messages (workspace_id, thread_id, gmail_message_id, direction, from_email, body, body_html, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, threadId, msg.id, direction, from, displayBody, html, msgDate]
    );

    // Store image attachments
    const [msgRow] = await db.query(
      'SELECT id FROM messages WHERE gmail_message_id = ? AND workspace_id = ?',
      [msg.id, workspaceId]
    );
    if (msgRow.length) {
      const parts = msg.payload?.parts || [];
      for (const part of parts) {
        const isImage      = part.mimeType?.startsWith('image/');
        const attachmentId = part.body?.attachmentId;
        const filename     = part.filename;
        if (isImage && attachmentId && filename) {
          await db.query(
            `INSERT IGNORE INTO attachments (workspace_id, message_id, gmail_message_id, attachment_id, filename, mime_type, size)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [workspaceId, msgRow[0].id, msg.id, attachmentId, filename, part.mimeType, part.body?.size || 0]
          );
        }
      }
    }
  }
}

async function sendReply(gmailThreadId, body, workspaceId, isNote = false, { bodyHtml, attachments } = {}) {
  const [threadRows] = await db.query(
    'SELECT * FROM threads WHERE gmail_thread_id = ? AND workspace_id = ?',
    [gmailThreadId, workspaceId]
  );
  if (!threadRows.length) throw new Error('Thread not found');
  const thread = threadRows[0];

  // Look up brand from DB
  const { getBrandByNameForWorkspace } = require('./brands');
  const brand = await getBrandByNameForWorkspace(workspaceId, thread.brand);
  if (!brand) throw new Error(`Brand "${thread.brand}" not found in workspace`);

  if (isNote) {
    await db.query(
      `INSERT INTO messages (workspace_id, thread_id, direction, from_email, body, is_note, sent_at)
       VALUES (?, ?, 'outbound', ?, ?, 1, NOW())`,
      [workspaceId, thread.id, brand.email, body]
    );
    return { success: true, note: true };
  }

  // Use brand-specific Gmail client if available
  let auth;
  if (brand.gmail_token_id) {
    auth = await getAuthenticatedClientForBrand(brand.id);
  } else {
    auth = await getAuthenticatedClient(workspaceId);
  }
  const gmail = google.gmail({ version: 'v1', auth });

  const to      = thread.customer_email;
  const subject = thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`;
  const boundary = `----=_Part_${Date.now().toString(36)}`;
  const mixedBoundary = `----=_Mixed_${Date.now().toString(36)}`;

  const hasHtml = bodyHtml && bodyHtml.trim();
  const hasAttachments = attachments && attachments.length > 0;

  let emailBody;

  if (!hasHtml && !hasAttachments) {
    // Plain text only (original behavior)
    emailBody = [
      `From: ${brand.name} Support <${brand.email}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${gmailThreadId}`,
      `References: ${gmailThreadId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');
  } else {
    // Build multipart email
    const headers = [
      `From: ${brand.name} Support <${brand.email}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${gmailThreadId}`,
      `References: ${gmailThreadId}`,
      'MIME-Version: 1.0',
    ];

    // Build the text/html alternative part
    const altPart = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      hasHtml ? bodyHtml : `<p>${body.replace(/\n/g, '<br>')}</p>`,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    if (hasAttachments) {
      headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
      const parts = [
        headers.join('\r\n'),
        '',
        `--${mixedBoundary}`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        altPart,
      ];

      for (const file of attachments) {
        const base64Data = file.buffer.toString('base64');
        parts.push(
          '',
          `--${mixedBoundary}`,
          `Content-Type: ${file.mimetype}; name="${file.originalname}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${file.originalname}"`,
          '',
          base64Data
        );
      }

      parts.push('', `--${mixedBoundary}--`);
      emailBody = parts.join('\r\n');
    } else {
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      emailBody = [headers.join('\r\n'), '', altPart].join('\r\n');
    }
  }

  const raw = Buffer.from(emailBody)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const sendRes = await gmail.users.messages.send({
    userId:      'me',
    requestBody: { raw, threadId: gmailThreadId },
  });

  // Insert message record
  const [msgResult] = await db.query(
    `INSERT INTO messages (workspace_id, thread_id, gmail_message_id, direction, from_email, body, sent_at)
     VALUES (?, ?, ?, 'outbound', ?, ?, NOW())`,
    [workspaceId, thread.id, sendRes.data.id, brand.email, body]
  );

  // Store outbound attachment metadata
  if (hasAttachments && msgResult.insertId) {
    for (const file of attachments) {
      await db.query(
        `INSERT INTO attachments (message_id, workspace_id, gmail_message_id, filename, mime_type, size, direction)
         VALUES (?, ?, ?, ?, ?, ?, 'outbound')`,
        [msgResult.insertId, workspaceId, sendRes.data.id, file.originalname, file.mimetype, file.size]
      );
    }
  }

  // Auto-advance: open → in_progress on first real reply
  if (thread.status === 'open') {
    const [msgCount] = await db.query(
      "SELECT COUNT(*) as cnt FROM messages WHERE thread_id=? AND direction='outbound' AND is_note=0",
      [thread.id]
    );
    if (msgCount[0].cnt === 1) {
      await db.query("UPDATE threads SET status='in_progress' WHERE id=? AND workspace_id=?", [thread.id, workspaceId]);

      const [firstMsg] = await db.query(
        'SELECT sent_at FROM messages WHERE thread_id=? AND direction="inbound" ORDER BY sent_at ASC LIMIT 1',
        [thread.id]
      );
      if (firstMsg.length) {
        const mins = Math.round((Date.now() - new Date(firstMsg[0].sent_at).getTime()) / 60000);
        await db.query('UPDATE threads SET first_response_minutes=? WHERE id=? AND workspace_id=?', [mins, thread.id, workspaceId]);
      }
    }
  }

  return { success: true, messageId: sendRes.data.id };
}

async function getLabels(workspaceIdOrTokenId, byTokenId = false) {
  let auth;
  if (byTokenId) {
    const [rows] = await db.query('SELECT * FROM gmail_tokens WHERE id = ?', [workspaceIdOrTokenId]);
    if (!rows[0]) throw new Error('Gmail token not found');
    auth = _buildClient(rows[0]);
  } else {
    auth = await getAuthenticatedClient(workspaceIdOrTokenId);
  }
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.labels.list({ userId: 'me' });
  return (res.data.labels || [])
    .filter(l => l.type === 'user')
    .map(l => ({ id: l.id, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { getAuthUrl, getAuthenticatedClient, getAuthenticatedClientForBrand, syncThreads, sendReply, createOAuthClient, getLabels };
