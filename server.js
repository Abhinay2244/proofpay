import express from "express";
import { randomUUID } from "node:crypto";
import * as paypal from "./paypalClient.js";

const PORT = 3000;
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

function requireStatus(deal, status) {
  if (deal.status !== status) throw fail(409, `Deal is "${deal.status}", expected "${status}"`);
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
  };
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
  }
  res.redirect(`/?deal=${deal.id}`);
}));

app.post("/api/deals/:id/release", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  requireStatus(deal, "funds_held");
  await paypal.captureAuthorization(deal.authorizationId);
  deal.status = "released";
  res.json(deal);
}));

app.post("/api/deals/:id/refund", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  requireStatus(deal, "funds_held");
  await paypal.voidAuthorization(deal.authorizationId);
  deal.status = "refunded";
  res.json(deal);
}));

app.listen(PORT, () => console.log(`ProofPay running at ${BASE_URL}`));