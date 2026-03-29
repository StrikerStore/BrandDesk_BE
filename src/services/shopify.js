const axios = require('axios');
const db = require('../config/db');
const { decrypt } = require('../utils/encryption');

const API_VERSION = '2024-01';

// ── Normalize shop domain ──────────────────────────────────────────
function normalizeShopDomain(input) {
  if (!input) return null;
  let shop = input.trim().toLowerCase();
  // Strip protocol
  shop = shop.replace(/^https?:\/\//, '');
  // Strip trailing slashes/paths
  shop = shop.split('/')[0];
  // Add .myshopify.com if not present
  if (!shop.includes('.myshopify.com')) {
    shop = `${shop}.myshopify.com`;
  }
  return shop;
}

// ── Create Shopify API client ──────────────────────────────────────
function createClient(shopDomain, accessToken) {
  const shop = normalizeShopDomain(shopDomain);
  return axios.create({
    baseURL: `https://${shop}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });
}

// ── Map Shopify financial_status to payment type ───────────────────
function mapPaymentType(financialStatus) {
  if (['paid', 'partially_refunded', 'refunded'].includes(financialStatus)) return 'Prepaid';
  if (['pending', 'authorized', 'partially_paid'].includes(financialStatus)) return 'COD';
  return financialStatus || 'Unknown';
}

// ── Map Shopify fulfillment status ─────────────────────────────────
function mapShipmentStatus(fulfillmentStatus, shipmentStatus) {
  if (shipmentStatus) {
    const statusMap = {
      delivered: 'Delivered',
      in_transit: 'In Transit',
      out_for_delivery: 'Out for Delivery',
      attempted_delivery: 'Attempted Delivery',
      confirmed: 'Confirmed',
      label_printed: 'Label Printed',
      label_purchased: 'Label Purchased',
      ready_for_pickup: 'Ready for Pickup',
      failure: 'Failed',
    };
    return statusMap[shipmentStatus] || shipmentStatus;
  }
  if (fulfillmentStatus === 'fulfilled') return 'Shipped';
  if (fulfillmentStatus === 'partial') return 'Partially Shipped';
  return 'Unfulfilled';
}

// ── Format address from Shopify address object ─────────────────────
function formatAddress(addr) {
  if (!addr) return null;
  const parts = [addr.address1, addr.address2, addr.city, addr.province, addr.zip, addr.country].filter(Boolean);
  return parts.join(', ');
}

// ── Fetch customer by email from Shopify ───────────────────────────
async function fetchCustomerByEmail(shop, token, email) {
  try {
    const client = createClient(shop, token);
    const { data } = await client.get('/customers/search.json', {
      params: { query: `email:${email}` },
    });

    const customers = data.customers || [];
    const c = customers.find(c => c.email?.toLowerCase() === email.toLowerCase());
    if (!c) return null;

    const addr = c.default_address || c.addresses?.[0];
    return {
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || null,
      email: c.email,
      phone: c.phone || addr?.phone || null,
      address: formatAddress(addr),
      orders_count: c.orders_count || 0,
      total_spent: parseFloat(c.total_spent) || 0,
    };
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      throw new Error('SHOPIFY_AUTH_INVALID');
    }
    console.error('Shopify fetchCustomerByEmail error:', err.message);
    return null;
  }
}

// ── Fetch single order by order number ─────────────────────────────
// Returns normalized shape matching GET /api/orders/:orderId
async function fetchOrderById(shop, token, orderNumber) {
  try {
    const client = createClient(shop, token);
    const cleanId = orderNumber.replace(/^#/, '').trim();

    const { data } = await client.get('/orders.json', {
      params: { name: cleanId, status: 'any', limit: 5 },
    });

    const orders = data.orders || [];
    if (orders.length === 0) return null;

    const mainOrder = orders[0];

    // Fetch fulfillments for tracking
    let fulfillments = [];
    try {
      const { data: fData } = await client.get(`/orders/${mainOrder.id}/fulfillments.json`);
      fulfillments = fData.fulfillments || [];
    } catch { /* ignore fulfillment fetch errors */ }

    // Build tracking map: line_item_id → fulfillment
    const trackingByItem = {};
    for (const f of fulfillments) {
      for (const li of (f.line_items || [])) {
        trackingByItem[li.id] = f;
      }
    }

    // Customer info from order
    const shipping = mainOrder.shipping_address || {};
    const customer = {
      name: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim() || mainOrder.customer?.first_name || '',
      email: mainOrder.email || mainOrder.customer?.email || '',
      phone: shipping.phone || mainOrder.customer?.phone || '',
      shipping_name: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
      shipping_address: formatAddress(shipping),
      shipping_city: shipping.city || '',
      shipping_state: shipping.province || '',
      shipping_country: shipping.country || '',
      shipping_zipcode: shipping.zip || '',
    };

    // Build order line items
    const orderItems = mainOrder.line_items.map(li => {
      const f = trackingByItem[li.id] || fulfillments[0] || null;
      return {
        order_id: cleanId,
        is_split: false,
        unique_id: String(li.id),
        order_date: mainOrder.created_at,
        product: li.title || '',
        product_code: li.sku || '',
        size: li.variant_title || '',
        quantity: li.quantity || 1,
        selling_price: parseFloat(li.price) || 0,
        order_total: parseFloat(mainOrder.total_price) || 0,
        payment_type: mapPaymentType(mainOrder.financial_status),
        collectable: mainOrder.financial_status === 'pending' ? parseFloat(mainOrder.total_price) : 0,
        account_code: '',
        tracking: f ? {
          awb: f.tracking_number || null,
          carrier: f.tracking_company || null,
          status: mapShipmentStatus(mainOrder.fulfillment_status, f.shipment_status),
          label_url: null,
          tracking_url: f.tracking_url || null,
          handover_at: f.created_at || null,
          is_handed_over: !!f.tracking_number,
        } : null,
      };
    });

    return {
      order_id: cleanId,
      customer,
      orders: orderItems,
      total_items: orderItems.reduce((sum, o) => sum + o.quantity, 0),
      has_splits: false,
      split_count: 0,
    };
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      throw new Error('SHOPIFY_AUTH_INVALID');
    }
    console.error('Shopify fetchOrderById error:', err.message);
    return null;
  }
}

// ── Fetch orders by customer email ─────────────────────────────────
// Returns normalized shape matching GET /api/orders/customer/:email
async function fetchOrdersByEmail(shop, token, email) {
  try {
    const client = createClient(shop, token);

    const { data } = await client.get('/orders.json', {
      params: { email, status: 'any', limit: 20 },
    });

    const orders = data.orders || [];

    return orders.map(o => {
      // Get first fulfillment for tracking info
      const f = o.fulfillments?.[0] || null;
      return {
        order_id: (o.name || '').replace(/^#/, ''),
        customer_name: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : '',
        order_date: o.created_at,
        order_total: parseFloat(o.total_price) || 0,
        payment_type: mapPaymentType(o.financial_status),
        account_code: '',
        current_shipment_status: mapShipmentStatus(o.fulfillment_status, f?.shipment_status),
        carrier_name: f?.tracking_company || null,
        awb: f?.tracking_number || null,
        tracking_url: f?.tracking_url || null,
      };
    });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      throw new Error('SHOPIFY_AUTH_INVALID');
    }
    console.error('Shopify fetchOrdersByEmail error:', err.message);
    return [];
  }
}

// ── Resolve data source for a workspace + brand ────────────────────
async function resolveDataSource(workspaceId, brandLabel) {
  if (!brandLabel) {
    return { source: 'none' };
  }

  const [brands] = await db.query(
    'SELECT shopify_store, shopify_token FROM brands WHERE workspace_id = ? AND label = ? AND is_active = 1',
    [workspaceId, brandLabel]
  );

  if (brands[0]?.shopify_token && brands[0]?.shopify_store) {
    return {
      source: 'shopify',
      shop: normalizeShopDomain(brands[0].shopify_store),
      token: decrypt(brands[0].shopify_token),
    };
  }

  return { source: 'none' };
}

module.exports = {
  normalizeShopDomain,
  fetchCustomerByEmail,
  fetchOrderById,
  fetchOrdersByEmail,
  resolveDataSource,
};
