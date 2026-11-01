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

async function call(path, body = {}) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) { console.error("ERROR", JSON.stringify(data, null, 2)); process.exit(1); }
  return data;
}

const [cmd, id] = process.argv.slice(2);

if (cmd === "create") {
  const order = await call("/v2/checkout/orders", {
    intent: "AUTHORIZE",
    purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }],
  });
  console.log("ORDER ID:", order.id);
  const link = order.links.find(l => l.rel === "approve" || l.rel === "payer-action");
  console.log("OPEN THIS LINK:", link ? link.href : `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`);
}

if (cmd === "authorize") {
  const r = await call(`/v2/checkout/orders/${id}/authorize`);
  const auth = r.purchase_units[0].payments.authorizations[0];
  console.log("AUTHORIZATION ID:", auth.id, "STATUS:", auth.status);
}

if (cmd === "capture") {
  const r = await call(`/v2/payments/authorizations/${id}/capture`);
  console.log("CAPTURE STATUS:", r.status);
}

if (cmd === "void") {
  await call(`/v2/payments/authorizations/${id}/void`);
  console.log("VOIDED");
}