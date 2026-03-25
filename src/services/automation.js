const db = require('../config/db');
const { getSetting } = require('./settings');
const { sendReply }  = require('./gmail');
const { getBrandsByWorkspace } = require('./brands');

/**
 * Auto-acknowledgement — runs every minute via cron per workspace.
 */
async function runAutoAck(workspaceId) {
  const enabled = await getSetting(workspaceId, 'auto_ack_enabled', 'false');
  if (enabled !== 'true') return;

  const delayMins = parseInt(await getSetting(workspaceId, 'auto_ack_delay_minutes', '5'));

  const [threads] = await db.query(
    `SELECT t.* FROM threads t
     WHERE t.workspace_id = ?
       AND t.status = 'open'
       AND t.auto_ack_sent = 0
       AND t.created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.thread_id = t.id AND m.direction = 'outbound' AND m.is_note = 0
       )`,
    [workspaceId, delayMins]
  );

  if (!threads.length) return;

  const [tplRows] = await db.query(
    `SELECT * FROM templates
     WHERE workspace_id = ?
       AND (title LIKE '%Acknowledgement%' OR title LIKE '%acknowledgement%')
     LIMIT 1`,
    [workspaceId]
  );
  if (!tplRows.length) {
    console.log(`⚠ [ws:${workspaceId}] Auto-ack: no acknowledgement template found`);
    return;
  }

  const brands = await getBrandsByWorkspace(workspaceId);

  for (const thread of threads) {
    try {
      const brand = brands.find(b => b.name === thread.brand);
      if (!brand) continue;

      const firstName = thread.customer_name?.split(' ')[0] || 'there';
      const body = tplRows[0].body
        .replace(/\{\{customer_name\}\}/g, firstName)
        .replace(/\{\{brand\}\}/g,         brand.name)
        .replace(/\{\{order_id\}\}/g,      thread.order_number || '[order ID]')
        .replace(/\{\{ticket_id\}\}/g,     thread.ticket_id    || '[ticket ID]');

      await sendReply(thread.gmail_thread_id, body, workspaceId, false);
      await db.query('UPDATE threads SET auto_ack_sent = 1 WHERE id = ? AND workspace_id = ?', [thread.id, workspaceId]);

      console.log(`✅ [ws:${workspaceId}] Auto-ack sent for thread #${thread.id} (${thread.brand})`);
    } catch (err) {
      console.error(`⚠ [ws:${workspaceId}] Auto-ack failed for thread #${thread.id}:`, err.message);
    }
  }
}

/**
 * Auto-close stale resolved tickets — runs daily at midnight per workspace.
 */
async function runAutoClose(workspaceId) {
  const enabled = await getSetting(workspaceId, 'auto_close_enabled', 'false');
  if (enabled !== 'true') return;

  const days = parseInt(await getSetting(workspaceId, 'auto_close_days', '7'));

  const [threads] = await db.query(
    `SELECT t.id FROM threads t
     WHERE t.workspace_id = ?
       AND t.status = 'resolved'
       AND t.resolved_at IS NOT NULL
       AND t.resolved_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.thread_id = t.id
           AND m.direction = 'inbound'
           AND m.sent_at > t.resolved_at
       )`,
    [workspaceId, days]
  );

  if (!threads.length) return;

  for (const thread of threads) {
    await db.query(
      'UPDATE threads SET status = ? WHERE id = ? AND workspace_id = ?',
      ['resolved', thread.id, workspaceId]
    );
  }

  console.log(`🗄 [ws:${workspaceId}] Auto-close: archived ${threads.length} stale resolved threads`);
}

module.exports = { runAutoAck, runAutoClose };
