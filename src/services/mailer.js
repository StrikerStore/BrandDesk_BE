const nodemailer = require('nodemailer');

// Singleton transporter — created once, reused for all emails
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) return null;

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return _transporter;
}

/**
 * Wraps content in a branded HTML template.
 */
function wrapHtml(content) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:28px 32px;">
      <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">BrandDesk</h1>
    </div>
    <!-- Body -->
    <div style="padding:32px;">
      ${content}
    </div>
    <!-- Footer -->
    <div style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">
        BrandDesk &mdash; <a href="https://branddesk.in" style="color:#6366f1;text-decoration:none;">branddesk.in</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Send an admin notification email (to NOTIFICATION_EMAIL).
 * Non-blocking — callers should use .catch() to avoid unhandled rejections.
 */
async function sendAdminNotification({ subject, html }) {
  const transporter = getTransporter();
  const to = process.env.NOTIFICATION_EMAIL;
  const from = process.env.SMTP_USER;

  if (!transporter || !to) {
    console.log(`[mailer] Skipped admin notification (SMTP not configured): ${subject}`);
    return;
  }

  await transporter.sendMail({
    from: `"BrandDesk" <${from}>`,
    to,
    subject,
    html: wrapHtml(html),
  });
}

/**
 * Send an email to a user (from branddesk@plexzuu.com → user).
 * Non-blocking — callers should use .catch() to avoid unhandled rejections.
 */
async function sendUserEmail({ to, subject, html }) {
  const transporter = getTransporter();
  const from = process.env.SMTP_USER;

  if (!transporter || !to) {
    console.log(`[mailer] Skipped user email (SMTP not configured): ${subject}`);
    return;
  }

  await transporter.sendMail({
    from: `"BrandDesk" <${from}>`,
    to,
    subject,
    html: wrapHtml(html),
  });
}

module.exports = { sendAdminNotification, sendUserEmail };
