require('dotenv').config();
const db = require('./db');

const WS_SLUG     = 'shopify-review-workspace';
const BRAND_LABEL = 'shopify-test';
const BRAND_EMAIL = 'demo@branddesk.in';

// ── 5 demo threads covering key features ──────────────────────
const THREADS = [
  {
    key: 'demo_001',
    subject: 'Where is my order? It has been 5 days',
    status: 'open', priority: 'normal',
    customer_name: 'Priya Sharma', customer_email: 'priya.sharma.demo@example.com',
    customer_phone: '9876543210', order_number: '#1001',
    tags: ['shipping', 'tracking'], issue_category: 'Shipping', ticket_id: 'TKT-001',
    messages: [
      { dir: 'inbound',  from: 'priya.sharma.demo@example.com',
        body: "Hi, I placed order #1001 five days ago and haven't received any tracking update. Can you help me find out where my package is?",
        is_note: 0, hours_ago: 12 },
      { dir: 'outbound', from: BRAND_EMAIL,
        body: "Hi Priya, thanks for reaching out! Let me check the status of your order #1001 right away. I'll get back to you shortly with an update.",
        is_note: 0, hours_ago: 11 },
      { dir: 'inbound', from: null,
        body: 'Customer follow-up call received. She mentioned the package might have been left with a neighbor. Checking with courier.',
        is_note: 1, hours_ago: 10 },
    ],
  },
  {
    key: 'demo_002',
    subject: 'Damaged item received — requesting refund',
    status: 'in_progress', priority: 'normal',
    customer_name: 'Rahul Kumar', customer_email: 'rahul.kumar.demo@example.com',
    customer_phone: '9123456789', order_number: '#1002',
    tags: ['refund', 'damaged'], issue_category: 'Refund', ticket_id: 'TKT-002',
    messages: [
      { dir: 'inbound', from: 'rahul.kumar.demo@example.com',
        body: "I received my order #1002 today and the item is completely damaged. The packaging was torn and the product inside is broken. I have photos. Please process a full refund.",
        is_note: 0, hours_ago: 48 },
      { dir: 'outbound', from: BRAND_EMAIL,
        body: "Hi Rahul, I'm really sorry about the damaged item. Could you please share the photos so I can escalate this to our quality team and process your refund?",
        is_note: 0, hours_ago: 46 },
      { dir: 'inbound', from: 'rahul.kumar.demo@example.com',
        body: "I've sent the photos to your email. Please let me know the refund timeline.",
        is_note: 0, hours_ago: 44 },
      { dir: 'inbound', from: null,
        body: 'Customer has provided clear photos of damage. Product was crushed in transit. Approve full refund — no need to collect return. Escalate to logistics team for courier claim.',
        is_note: 1, hours_ago: 43 },
    ],
  },
  {
    key: 'demo_003',
    subject: 'Wrong size delivered — need urgent exchange',
    status: 'open', priority: 'urgent',
    customer_name: 'Anita Patel', customer_email: 'anita.patel.demo@example.com',
    customer_phone: '9988776655', order_number: '#1003',
    tags: ['exchange', 'wrong-item'], issue_category: 'Exchange', ticket_id: 'TKT-003',
    messages: [
      { dir: 'inbound', from: 'anita.patel.demo@example.com',
        body: "I ordered a Medium but received a Small (order #1003). The event I bought this for is this weekend. I urgently need an exchange. Please expedite.",
        is_note: 0, hours_ago: 6 },
      { dir: 'inbound', from: null,
        body: 'Warehouse confirmed wrong size was dispatched — system error in picking. Approve exchange without return wait. Ship correct size (Medium) via express. Mark as urgent.',
        is_note: 1, hours_ago: 5 },
    ],
  },
  {
    key: 'demo_004',
    subject: 'Order marked delivered but not received',
    status: 'open', priority: 'normal',
    customer_name: 'Vikram Singh', customer_email: 'vikram.singh.demo@example.com',
    customer_phone: '9700000001', order_number: '#1004',
    tags: ['missing', 'delivery'], issue_category: 'Shipping', ticket_id: 'TKT-004',
    messages: [
      { dir: 'inbound', from: 'vikram.singh.demo@example.com',
        body: "The tracking for order #1004 shows it was delivered yesterday, but I haven't received anything. I was home all day. This is very frustrating.",
        is_note: 0, hours_ago: 20 },
      { dir: 'outbound', from: BRAND_EMAIL,
        body: "Hi Vikram, I understand how frustrating this must be. I've raised an investigation with our courier partner. Please check with your building security or nearby neighbors in the meantime. We'll update you within 24 hours.",
        is_note: 0, hours_ago: 18 },
      { dir: 'inbound', from: null,
        body: 'Courier shows GPS coordinates of delivery — location does not match customer address. Likely a misdelivery. Initiate reship after courier confirms.',
        is_note: 1, hours_ago: 17 },
    ],
  },
  {
    key: 'demo_005',
    subject: 'Do you have this in stock?',
    status: 'resolved', priority: 'normal',
    customer_name: 'Meera Nair', customer_email: 'meera.nair.demo@example.com',
    customer_phone: null, order_number: null,
    tags: ['inquiry', 'stock'], issue_category: 'General', ticket_id: 'TKT-005',
    messages: [
      { dir: 'inbound', from: 'meera.nair.demo@example.com',
        body: "Hi, I'm looking for the Blue Floral Kurta Set in size L. I couldn't find it on your website. Is it available or coming back in stock?",
        is_note: 0, hours_ago: 72 },
      { dir: 'outbound', from: BRAND_EMAIL,
        body: "Hi Meera! The Blue Floral Kurta Set in L is currently out of stock, but we're expecting restocking in 7-10 days. I'll add your email to the waitlist and notify you as soon as it's available. Thank you for your interest!",
        is_note: 0, hours_ago: 70 },
      { dir: 'inbound', from: 'meera.nair.demo@example.com',
        body: "That's great, thank you! Looking forward to it.",
        is_note: 0, hours_ago: 68 },
    ],
  },
];

// ── Seed customers ────────────────────────────────────────────
const CUSTOMERS = [
  { email: 'priya.sharma.demo@example.com',  name: 'Priya Sharma',  phone: '9876543210', location: 'Mumbai' },
  { email: 'rahul.kumar.demo@example.com',   name: 'Rahul Kumar',   phone: '9123456789', location: 'Delhi' },
  { email: 'anita.patel.demo@example.com',   name: 'Anita Patel',   phone: '9988776655', location: 'Ahmedabad' },
  { email: 'vikram.singh.demo@example.com',  name: 'Vikram Singh',  phone: '9700000001', location: 'Bangalore' },
  { email: 'meera.nair.demo@example.com',    name: 'Meera Nair',    phone: null,          location: 'Kochi' },
];

async function seedDemoThreads() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Look up workspace and brand from the test-account seed
    const [[ws]] = await conn.query('SELECT id FROM workspaces WHERE slug = ?', [WS_SLUG]);
    if (!ws) { console.error('Workspace not found. Run  npm run db:seed:shopify-test  first.'); process.exit(1); }

    const [[brand]] = await conn.query(
      'SELECT id, label FROM brands WHERE workspace_id = ? AND label = ?', [ws.id, BRAND_LABEL]
    );
    if (!brand) { console.error('Brand not found. Run  npm run db:seed:shopify-test  first.'); process.exit(1); }

    // Seed customers
    for (const c of CUSTOMERS) {
      await conn.query(
        `INSERT INTO customers (workspace_id, email, name, phone, location)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone), location = VALUES(location)`,
        [ws.id, c.email, c.name, c.phone, c.location]
      );
    }

    // Seed threads and their messages
    for (const t of THREADS) {
      const gmailThreadId = `demo_${t.key}_${ws.id}`;

      // Calculate last_message_at from the most recent message
      const minHoursAgo = Math.min(...t.messages.filter(m => !m.is_note).map(m => m.hours_ago));
      const lastMessageAt = new Date(Date.now() - minHoursAgo * 3600 * 1000);

      await conn.query(
        `INSERT INTO threads
           (workspace_id, gmail_thread_id, subject, brand, brand_email, status, priority,
            customer_email, customer_name, customer_phone, is_unread, tags, ticket_id,
            order_number, issue_category, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE subject = VALUES(subject), status = VALUES(status)`,
        [
          ws.id, gmailThreadId, t.subject, brand.label, BRAND_EMAIL,
          t.status, t.priority, t.customer_email, t.customer_name,
          t.customer_phone || null, JSON.stringify(t.tags), t.ticket_id,
          t.order_number || null, t.issue_category, lastMessageAt,
        ]
      );

      const [[thread]] = await conn.query(
        'SELECT id FROM threads WHERE gmail_thread_id = ?', [gmailThreadId]
      );

      // Seed messages for this thread
      for (let i = 0; i < t.messages.length; i++) {
        const m = t.messages[i];
        const gmailMsgId = `demo_${t.key}_msg${i}_${ws.id}`;
        const sentAt = new Date(Date.now() - m.hours_ago * 3600 * 1000);

        await conn.query(
          `INSERT IGNORE INTO messages
             (thread_id, gmail_message_id, direction, from_email, body, body_html, is_note, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            thread.id, gmailMsgId,
            m.is_note ? 'inbound' : m.dir,
            m.from || 'agent@branddesk.in',
            m.body,
            `<p>${m.body.replace(/\n/g, '</p><p>')}</p>`,
            m.is_note ? 1 : 0,
            sentAt,
          ]
        );
      }
    }

    await conn.commit();

    console.log('\n5 demo threads seeded successfully.\n');
    console.log('Thread overview:');
    THREADS.forEach(t => {
      const flag = t.priority === 'urgent' ? ' [URGENT]' : '';
      console.log(`  [${t.status.toUpperCase().padEnd(11)}] ${t.ticket_id}${flag} — ${t.subject}`);
    });
    console.log('');

  } catch (err) {
    await conn.rollback();
    console.error('Failed to seed demo threads:', err.message);
    process.exit(1);
  } finally {
    conn.release();
  }
  process.exit(0);
}

seedDemoThreads();
