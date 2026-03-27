require('dotenv').config();
const db = require('./db');

const USER_EMAIL = 'shopify-reviewer@branddesk.in';
const WS_SLUG    = 'shopify-review-workspace';

async function cleanup() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[ws]]   = await conn.query('SELECT id FROM workspaces WHERE slug = ?', [WS_SLUG]);
    const [[user]] = await conn.query('SELECT id FROM users WHERE email = ?', [USER_EMAIL.toLowerCase()]);

    if (ws) {
      // Delete thread messages first (FK dependency), then threads
      const [threads] = await conn.query('SELECT id FROM threads WHERE workspace_id = ?', [ws.id]);
      for (const { id } of threads) {
        await conn.query('DELETE FROM messages WHERE thread_id = ?', [id]);
      }
      await conn.query('DELETE FROM threads           WHERE workspace_id = ?', [ws.id]);
      await conn.query('DELETE FROM customers         WHERE workspace_id = ?', [ws.id]);
      await conn.query('DELETE FROM brands            WHERE workspace_id = ?', [ws.id]);
      await conn.query('DELETE FROM settings          WHERE workspace_id = ?', [ws.id]);
      await conn.query('DELETE FROM workspace_members WHERE workspace_id = ?', [ws.id]);
      await conn.query('DELETE FROM workspaces        WHERE id = ?',           [ws.id]);
      console.log(`Deleted workspace: ${WS_SLUG} (id=${ws.id})`);
    } else {
      console.log('Workspace not found — already cleaned up.');
    }

    if (user) {
      await conn.query('DELETE FROM users WHERE id = ?', [user.id]);
      console.log(`Deleted user: ${USER_EMAIL} (id=${user.id})`);
    } else {
      console.log('User not found — already cleaned up.');
    }

    await conn.commit();
    console.log('\nShopify reviewer test account removed successfully.\n');

  } catch (err) {
    await conn.rollback();
    console.error('Cleanup failed:', err.message);
    process.exit(1);
  } finally {
    conn.release();
  }
  process.exit(0);
}

cleanup();
