/**
 * Parses Shopify contact form emails into structured ticket data.
 *
 * Works generically with any Shopify store's contact form — no hardcoded
 * brand names or ticket prefixes. Standard fields (Name, Email, Phone,
 * Country Code, Order Number, Issue Category, Sub Issue, Body, Ticket)
 * are mapped to dedicated columns. Any additional custom fields are
 * returned in `extraFields` for storage in the threads.extra_fields column.
 *
 * Expected email body format (any Shopify contact form):
 *   You received a new message from your online store's contact form.
 *   Country Code: IN
 *   Order Number: #1234
 *   Name: Customer Name
 *   Email: customer@example.com
 *   Phone: 9876543210
 *   Issue Category: Shipping
 *   Sub Issue: Delayed
 *   Body: Where is my order?
 *   Ticket: STORE-20260101-12345
 */

/**
 * Parse a single-line field value from the email body.
 * Handles "FieldName:\nValue" and "FieldName: Value" patterns.
 */
function extractField(body, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`${escaped}:\\s*\\n([^\\n]+)`, 'i'),
    new RegExp(`${escaped}:\\s+([^\\n]+)`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]?.trim()) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Extract the Body field which may span multiple lines.
 * Stops at the next known field label or end of string.
 */
function extractBodyField(emailBody) {
  const bodyMatch = emailBody.match(
    /Body:\s*\n?([\s\S]*?)(?:\nTicket:|\nOrder Number:|\nName:|\nEmail:|\nPhone:|$)/i
  );
  if (bodyMatch && bodyMatch[1]?.trim()) return bodyMatch[1].trim();

  // Fallback: everything after "Body:"
  const simpleMatch = emailBody.match(/Body:\s*(.+)/is);
  return simpleMatch?.[1]?.trim() || null;
}

/**
 * Generic Key:Value extractor for any Shopify contact form.
 * Returns ALL fields found in the email body as a plain object,
 * regardless of custom field names a merchant may have added.
 * Values are single-line only (multi-line Body is handled separately).
 */
function extractAllFields(emailBody) {
  const fields = {};
  const linePattern = /^([A-Za-z][A-Za-z0-9 _\-]+):\s*(.+)$/gm;
  let match;
  while ((match = linePattern.exec(emailBody)) !== null) {
    const key   = match[1].trim();
    const value = match[2].trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

/**
 * Determine if this email is a Shopify contact form notification.
 */
function isShopifyContactForm(fromEmail, body) {
  const isFromShopify =
    fromEmail?.toLowerCase().includes('mailer@shopify.com') ||
    fromEmail?.toLowerCase().includes('@shopify.com');
  const hasFormPattern = body?.includes('received a new message from your online store');
  return isFromShopify || hasFormPattern;
}

/**
 * Main parser — takes raw email data and returns structured ticket info.
 * All known fields map to dedicated properties; unknown custom fields go
 * into `extraFields` for storage in the threads.extra_fields JSON column.
 *
 * @param {string} fromEmail - The From header value
 * @param {string} replyTo   - The Reply-To header value
 * @param {string} rawBody   - The plain text email body
 * @returns {object|null}
 */
function parseShopifyEmail(fromEmail, replyTo, rawBody) {
  if (!rawBody) return null;
  if (!isShopifyContactForm(fromEmail, rawBody)) return null;

  // Extract real customer email from Reply-To header
  let customerEmail = null;
  if (replyTo) {
    const replyMatch = replyTo.match(/<(.+?)>/) || replyTo.match(/([^\s<>]+@[^\s<>]+)/);
    customerEmail = replyMatch?.[1]?.trim() || replyTo.trim();
  }

  // Extract standard known fields
  const name          = extractField(rawBody, 'Name');
  const emailInBody   = extractField(rawBody, 'Email');
  const phone         = extractField(rawBody, 'Phone');
  const countryCode   = extractField(rawBody, 'Country Code');
  const orderNumber   = extractField(rawBody, 'Order Number');
  const issueCategory = extractField(rawBody, 'Issue Category');
  const subIssue      = extractField(rawBody, 'Sub Issue');
  const ticketId      = extractField(rawBody, 'Ticket');
  const messageBody   = extractBodyField(rawBody);

  // Use email from body as fallback for customer email
  const resolvedEmail = customerEmail || emailInBody || null;

  // Extract ALL fields generically — standard fields will overlap but
  // merchants may have custom fields (e.g. "Preferred Language", "Product Size")
  const allFields = extractAllFields(rawBody);

  // Build extraFields: anything not in the standard set
  const STANDARD_KEYS = new Set([
    'name', 'email', 'phone', 'country code', 'order number',
    'issue category', 'sub issue', 'ticket', 'body',
  ]);
  const extraFields = {};
  for (const [k, v] of Object.entries(allFields)) {
    if (!STANDARD_KEYS.has(k.toLowerCase())) {
      extraFields[k] = v;
    }
  }

  return {
    isShopifyForm:   true,
    customerEmail:   resolvedEmail,
    customerName:    name,
    customerPhone:   phone,
    customerCountry: countryCode,
    orderNumber,
    issueCategory,
    subIssue,
    messageBody,      // Actual customer message — used as chat bubble text
    ticketId,
    extraFields,      // Any custom form fields beyond the standard set
  };
}

/**
 * Build a clean display body for the chat view.
 * Shows key metadata as emoji-prefixed header lines, then the customer message.
 * Also renders any extra custom fields below the standard ones.
 */
function buildChatBody(parsed) {
  if (!parsed?.isShopifyForm) return null;

  const lines = [];

  if (parsed.ticketId)       lines.push(`🎫 Ticket: ${parsed.ticketId}`);
  if (parsed.orderNumber)    lines.push(`📦 Order: ${parsed.orderNumber}`);
  if (parsed.issueCategory)  lines.push(`🏷 Issue: ${parsed.issueCategory}`);
  if (parsed.subIssue && parsed.subIssue !== parsed.issueCategory) {
    lines.push(`   └ ${parsed.subIssue}`);
  }
  if (parsed.customerPhone)   lines.push(`📞 Phone: ${parsed.customerPhone}`);
  if (parsed.customerCountry) lines.push(`🌍 Country: ${parsed.customerCountry}`);

  // Render any custom merchant-specific fields
  if (parsed.extraFields && Object.keys(parsed.extraFields).length > 0) {
    for (const [k, v] of Object.entries(parsed.extraFields)) {
      lines.push(`📋 ${k}: ${v}`);
    }
  }

  lines.push('');
  lines.push(parsed.messageBody || '(No message body)');

  return lines.join('\n');
}

module.exports = { parseShopifyEmail, buildChatBody, isShopifyContactForm, extractAllFields };
