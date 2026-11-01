const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;

async function getToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  return (await res.json()).access_token;
}

async function api(path, body) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.message || "PayPal error");
    err.details = data;
    throw err;
  }
  return data;
}

export async function createAuthorizeOrder({ amount, description, returnUrl, cancelUrl }) {
  const order = await api("/v2/checkout/orders", {
    intent: "AUTHORIZE",
    purchase_units: [{ description, amount: { currency_code: "USD", value: amount } }],
    payment_source: {
      paypal: {
        experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: "PAY_NOW" },
      },
    },
  });
  const link = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  return { id: order.id, approveUrl: link.href };
}

export async function authorizeOrder(orderId) {
  const r = await api(`/v2/checkout/orders/${orderId}/authorize`);
  return r.purchase_units[0].payments.authorizations[0].id;
}

export const captureAuthorization = (authId) => api(`/v2/payments/authorizations/${authId}/capture`);
export const voidAuthorization = (authId) => api(`/v2/payments/authorizations/${authId}/void`);