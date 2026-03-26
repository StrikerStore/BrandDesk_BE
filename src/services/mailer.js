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

/**
 * Send a payment receipt / tax invoice to the user.
 */
async function sendPaymentReceipt({ to, invoice }) {
  const {
    invoice_number, created_at, plan_name, billing_cycle,
    base_amount, gst_amount, amount, coupon_code, coupon_discount,
    customer_gst, txn_id, payu_mihpayid, payment_method,
    company_name, company_address, gst_number,
  } = invoice;

  const date = new Date(created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const planLabel = `${(plan_name || '').charAt(0).toUpperCase() + (plan_name || '').slice(1)} (${billing_cycle})`;

  let couponRow = '';
  if (coupon_code && coupon_discount > 0) {
    couponRow = `<tr><td style="padding:8px 0;color:#374151;">Coupon (${coupon_code})</td><td style="padding:8px 0;text-align:right;color:#16a34a;">-₹${parseFloat(coupon_discount).toLocaleString('en-IN')}</td></tr>`;
  }

  let customerGstRow = '';
  if (customer_gst) {
    customerGstRow = `<p style="margin:4px 0;font-size:12px;color:#6b7280;">Customer GSTIN: ${customer_gst}</p>`;
  }

  const html = `
    <div style="font-size:14px;color:#111827;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;">
        <div>
          <h2 style="margin:0 0 4px;font-size:18px;font-weight:700;">Tax Invoice</h2>
          <p style="margin:0;font-size:12px;color:#6b7280;">${invoice_number}</p>
          <p style="margin:0;font-size:12px;color:#6b7280;">Date: ${date}</p>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;margin-bottom:20px;gap:20px;">
        <div style="flex:1;">
          <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;">From</p>
          <p style="margin:0;font-weight:600;">${company_name || 'BrandDesk'}</p>
          ${gst_number ? `<p style="margin:2px 0;font-size:12px;color:#6b7280;">GSTIN: ${gst_number}</p>` : ''}
          ${company_address ? `<p style="margin:2px 0;font-size:12px;color:#6b7280;">${company_address}</p>` : ''}
        </div>
        <div style="flex:1;">
          <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;">Bill To</p>
          <p style="margin:0;font-weight:600;">${to}</p>
          ${customerGstRow}
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <thead>
          <tr style="border-bottom:2px solid #e5e7eb;">
            <th style="padding:8px 0;text-align:left;font-size:12px;font-weight:600;color:#6b7280;">Description</th>
            <th style="padding:8px 0;text-align:right;font-size:12px;font-weight:600;color:#6b7280;">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style="padding:8px 0;color:#374151;">BrandDesk ${planLabel}</td><td style="padding:8px 0;text-align:right;">₹${parseFloat(coupon_discount > 0 ? (parseFloat(base_amount) + parseFloat(coupon_discount)) : base_amount).toLocaleString('en-IN')}</td></tr>
          ${couponRow}
          <tr><td style="padding:8px 0;color:#374151;">Subtotal</td><td style="padding:8px 0;text-align:right;">₹${parseFloat(base_amount).toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:8px 0;color:#374151;">GST (${invoice.gst_percent || 18}%)</td><td style="padding:8px 0;text-align:right;">₹${parseFloat(gst_amount).toLocaleString('en-IN')}</td></tr>
          <tr style="border-top:2px solid #111827;font-weight:700;font-size:16px;">
            <td style="padding:12px 0;">Total</td>
            <td style="padding:12px 0;text-align:right;">₹${parseFloat(amount).toLocaleString('en-IN')}</td>
          </tr>
        </tbody>
      </table>

      <div style="background:#f9fafb;border-radius:8px;padding:12px 16px;font-size:12px;color:#6b7280;">
        <p style="margin:0 0 4px;"><strong>Transaction ID:</strong> ${txn_id}</p>
        ${payu_mihpayid ? `<p style="margin:0 0 4px;"><strong>PayU Reference:</strong> ${payu_mihpayid}</p>` : ''}
        ${payment_method ? `<p style="margin:0;"><strong>Payment Method:</strong> ${payment_method}</p>` : ''}
      </div>
    </div>
  `;

  await sendUserEmail({ to, subject: `BrandDesk Invoice ${invoice_number}`, html });
}

module.exports = { sendAdminNotification, sendUserEmail, sendPaymentReceipt };
