import express from "express";
import { randomUUID } from "node:crypto";
import * as paypal from "./paypalClient.js";
import { verifyDeliverable } from "./verifier.js";

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const app = express();
app.use(express.json());
app.use(express.static("public"));

const deals = new Map(); // in memory for now, resets when the server restarts

const fail = (status, message) => Object.assign(new Error(message), { status });

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e.details || e);
    res.status(e.status || 500).json({ error: e.message, details: e.details });
  }
};

function getDeal(id) {
  const deal = deals.get(id);
  if (!deal) throw fail(404, "Deal not found");
  return deal;
}

function requireStatus(deal, ...allowed) {
  if (!allowed.includes(deal.status)) {
    throw fail(409, `Deal is "${deal.status}", expected ${allowed.map((s) => `"${s}"`).join(" or ")}`);
  }
}

function log(deal, text) {
  deal.events.push({ time: new Date().toISOString(), text });
}

app.post("/api/deals", wrap(async (req, res) => {
  const { title, amount, criteria } = req.body;
  if (!title || !/^\d+(\.\d{1,2})?$/.test(String(amount)) || Number(amount) <= 0) {
    throw fail(400, "Need a title and a valid amount like 10.00");
  }
  const deal = {
    id: randomUUID(),
    title,
    amount: String(amount),
    criteria: criteria || [],
    status: "awaiting_payment",
    createdAt: new Date().toISOString(),
    events: [],
  };
  log(deal, "Deal created");
  deals.set(deal.id, deal);
  res.json(deal);
}));

app.get("/api/deals/:id", wrap(async (req, res) => res.json(getDeal(req.params.id))));

app.post("/api/deals/:id/pay", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  requireStatus(deal, "awaiting_payment");
  const order = await paypal.createAuthorizeOrder({
    amount: deal.amount,
    description: deal.title.slice(0, 120),
    returnUrl: `${BASE_URL}/paypal/return?deal=${deal.id}`,
    cancelUrl: `${BASE_URL}/?deal=${deal.id}`,
  });
  deal.orderId = order.id;
  res.json({ approveUrl: order.approveUrl });
}));

// PayPal sends the buyer back here after approval. We hold the funds now.
app.get("/paypal/return", wrap(async (req, res) => {
  const deal = getDeal(req.query.deal);
  if (deal.status === "awaiting_payment") {
    deal.authorizationId = await paypal.authorizeOrder(deal.orderId);
    deal.status = "funds_held";
    log(deal, `Buyer paid $${deal.amount}. Funds held by PayPal`);
  }
  res.redirect(`/?deal=${deal.id}`);
}));

// Freelancer submits work. The AI checks it. The buyer still decides.
app.post("/api/deals/:id/deliver", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  requireStatus(deal, "funds_held", "delivered");
  const deliverable = String(req.body.deliverable || "").trim();
  if (!deliverable) throw fail(400, "Deliverable is empty");
  if (deliverable.length > 8000) throw fail(400, "Deliverable is too long (max 8000 characters)");
  if (!deal.criteria.length) throw fail(400, "This deal has no acceptance criteria");

  deal.deliverable = deliverable;
  deal.verification = await verifyDeliverable({
    title: deal.title,
    criteria: deal.criteria,
    deliverable,
  });
  deal.status = "delivered";
  log(deal, `Work submitted. AI verdict: ${deal.verification.verdict}`);
  res.json(deal);
}));

app.post("/api/deals/:id/release", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  requireStatus(deal, "delivered");
  await paypal.captureAuthorization(deal.authorizationId);
  deal.status = "released";
  log(deal, "Buyer approved. Payment released to the freelancer");
  res.json(deal);
}));

app.post("/api/deals/:id/refund", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  requireStatus(deal, "funds_held", "delivered");
  await paypal.voidAuthorization(deal.authorizationId);
  deal.status = "refunded";
  log(deal, "Held funds released back to the buyer");
  res.json(deal);
}));

app.listen(PORT, () => console.log(`ProofPay running at ${BASE_URL}`));