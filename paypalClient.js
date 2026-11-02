const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;

async function getToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Could not log in to PayPal. Check the Client ID and Secret.");
  return data.access_token;
}

async function request(method, path, body) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
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
  const order = await request("POST", "/v2/checkout/orders", {
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
  const r = await request("POST", `/v2/checkout/orders/${orderId}/authorize`);
  return r.purchase_units[0].payments.authorizations[0].id;
}

export const captureAuthorization = (authId) => request("POST", `/v2/payments/authorizations/${authId}/capture`);
export const voidAuthorization = (authId) => request("POST", `/v2/payments/authorizations/${authId}/void`);

// Pays the freelancer from the merchant account.
export async function sendPayout({ batchId, email, amount, note, itemId }) {
  const r = await request("POST", "/v1/payments/payouts", {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: "You were paid through ProofPay",
      email_message: "The buyer approved your work and the payment was released.",
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: email,
        amount: { value: amount, currency: "USD" },
        note,
        sender_item_id: itemId,
      },
    ],
  });
  return { batchId: r.batch_header.payout_batch_id };
}

export async function getPayout(batchId) {
  const r = await request("GET", `/v1/payments/payouts/${batchId}?page_size=5`);
  const item = r.items && r.items[0];
  return {
    batchStatus: r.batch_header && r.batch_header.batch_status,
    itemStatus: item && item.transaction_status,
    error: item && item.errors && item.errors.message,
  };
}