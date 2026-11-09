import express from "express";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import * as paypal from "./paypalClient.js";
import { loadDeals, saveChanged } from "./db.js";
   import { verifyDeliverable, improveCriteria } from "./verifier.js";

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

// Time windows in minutes. Override in the environment if you want faster demos.
const minutes = (name, fallback) => {
  const n = Number(process.env[name]);
  return (n > 0 ? n : fallback) * 60 * 1000;
};
const DELIVERY_WINDOW = minutes("DELIVERY_WINDOW_MIN", 60); // freelancer must deliver
const FIX_WINDOW = minutes("FIX_WINDOW_MIN", 30);           // time to fix after a fail or change request
const REVIEW_WINDOW = minutes("REVIEW_WINDOW_MIN", 10);     // buyer's time to react after an AI pass
const MAX_CHANGE_ROUNDS = 2;
const MAX_DEALS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;       // per file
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;    // all files on the server

// Platform fee kept by ProofPay when the payment is released. Set PLATFORM_FEE_PERCENT=0 for no fee.
const feeSetting = Number(process.env.PLATFORM_FEE_PERCENT ?? 5);
const FEE_PERCENT = Number.isFinite(feeSetting) ? Math.min(Math.max(feeSetting, 0), 20) : 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.use(express.json({ limit: "7mb" })); // two 2 MB files become about 5.4 MB as base64
app.use(express.static("public"));
// After every API request, save any deals that changed, so a restart does not lose them.
app.use((req, res, next) => { res.on("finish", () => saveChanged(deals)); next(); });

const deals = new Map(); // working copy in memory; saved to the database when DATABASE_URL is set
await loadDeals(deals);

const fail = (status, message) => Object.assign(new Error(message), { status });

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e.details || e);
    res.status(e.status || 500).json({ error: e.message });
  }
};

function getDeal(id) {
  const deal = deals.get(String(id));
  if (!deal) throw fail(404, "Deal not found");
  return deal;
}

function log(deal, text) {
  deal.events.push({ time: new Date().toISOString(), text });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// The secret key in the link decides who you are.
function auth(req, deal, ...allowed) {
  const key = req.get("x-deal-key") || "";
  const role = key && safeEqual(key, deal.buyerKey) ? "buyer"
    : key && safeEqual(key, deal.freelancerKey) ? "freelancer" : null;
  if (!role) throw fail(403, "This link is not valid for this deal");
  if (allowed.length && !allowed.includes(role)) throw fail(403, `Only the ${allowed.join(" or ")} can do this`);
  return role;
}

// One money action at a time per deal.
async function withLock(deal, fn) {
  if (deal.busy) throw fail(409, "Another action is in progress. Try again in a moment.");
  deal.busy = true;
  try {
    return await fn();
  } finally {
    deal.busy = false;
  }
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw fail(400, "Enter the PayPal email where you want to be paid");
  return email;
}

/* ---------------- Money ---------------- */

const toCents = (amount) => Math.round(Number(amount) * 100);
const fromCents = (cents) => (cents / 100).toFixed(2);

// Pays the freelancer. Never throws: a failure is recorded so the payout can be retried.
async function sendPayoutFor(deal) {
  const gross = toCents(deal.amount);
  const fee = Math.round((gross * FEE_PERCENT) / 100);
  const net = gross - fee;
  deal.payoutAttempts = (deal.payoutAttempts || 0) + 1;
  deal.payout = { status: "sending", gross: fromCents(gross), fee: fromCents(fee), net: fromCents(net), checks: 0, error: "" };
  try {
    const r = await paypal.sendPayout({
      batchId: `proofpay-${deal.id}-${deal.payoutAttempts}`,
      email: deal.payoutEmail,
      amount: fromCents(net),
      note: `ProofPay: ${deal.title}`.slice(0, 160),
      itemId: `${deal.id}-${deal.payoutAttempts}`,
    });
    deal.payout.batchId = r.batchId;
    deal.payout.status = "pending";
    log(deal, `Payout of $${deal.payout.net} sent to the freelancer (platform fee $${deal.payout.fee})`);
  } catch (e) {
    console.error("Payout failed", e.details || e);
    deal.payout.status = "failed";
    deal.payout.error = String(e.message || "Payout failed").slice(0, 200);
    log(deal, "Payout to the freelancer failed. The payment is captured, so the payout can be retried");
  }
}

// Capture the held payment, then pay the freelancer.
async function settleRelease(deal, message) {
  await paypal.captureAuthorization(deal.authorizationId);
  deal.status = "released";
  deal.deadlineAt = null;
  deal.autoReleaseAt = null;
  log(deal, message);
  await sendPayoutFor(deal);
}

/* ---------------- Files ---------------- */

const fileBytes = (deal) => (deal.reviewFile?.size || 0) + (deal.finalFile?.size || 0);
const totalBytes = () => { let n = 0; for (const d of deals.values()) n += fileBytes(d); return n; };

// Look at the first bytes, so a renamed file cannot pretend to be an image.
function sniff(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length > 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

function parseFile(input, kind) {
  if (!input) return null;
  const name = String(input.name || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "file";
  const data = Buffer.from(String(input.data || ""), "base64");
  if (!data.length) throw fail(400, "The file is empty");
  if (data.length > MAX_FILE_BYTES) throw fail(400, "Each file must be 2 MB or smaller");
  if (kind === "final") return { name, mime: "application/octet-stream", size: data.length, data };
  const sniffed = sniff(data);
  if (sniffed) return { name, mime: sniffed, size: data.length, data };
  if (data.includes(0)) throw fail(400, "The review file must be an image (PNG, JPG, WEBP), a PDF or a text file");
  return { name, mime: "text/plain", size: data.length, data };
}

// Returns null when a refund is allowed, otherwise the reason it is locked.
function refundBlockedReason(deal) {
  if (!["funds_held", "changes_requested", "delivered"].includes(deal.status)) return "This deal is already finished.";
  if (deal.status === "delivered" && deal.verification?.verdict === "pass") {
    return "Refund is locked because the AI says the work meets every criterion. You can release the payment or request changes.";
  }
  if (!deal.deadlineAt || Date.now() < deal.deadlineAt) {
    return "Refund unlocks only if the freelancer misses the deadline.";
  }
  return null;
}

function viewFor(deal, role) {
  const unlocked = role === "freelancer" || deal.status === "released";
  const view = {
    id: deal.id,
    role,
    title: deal.title,
    amount: deal.amount,
    feePercent: FEE_PERCENT,
    criteria: deal.criteria,
    status: deal.status,
    events: deal.events,
    reviewCopy: deal.reviewCopy || "",
    reviewFile: deal.reviewFile ? { name: deal.reviewFile.name, mime: deal.reviewFile.mime, size: deal.reviewFile.size } : null,
    verification: deal.verification || null,
    hasFinalWork: Boolean(deal.finalWork || deal.finalFile),
    changeNote: deal.changeNote || "",
    changeRequests: deal.changeRequests,
    maxChangeRounds: MAX_CHANGE_ROUNDS,
    deadlineAt: deal.deadlineAt,
    autoReleaseAt: deal.autoReleaseAt,
    now: Date.now(),
    refundBlockedReason: refundBlockedReason(deal),
    payout: deal.payout
      ? { status: deal.payout.status, gross: deal.payout.gross, fee: deal.payout.fee, net: deal.payout.net, error: deal.payout.error }
      : null,
  };
  // The final files stay locked for the buyer until the payment is released.
  if (unlocked) {
    view.finalWork = deal.finalWork || "";
    view.finalFile = deal.finalFile ? { name: deal.finalFile.name, size: deal.finalFile.size } : null;
  }
  if (role === "freelancer") view.payoutEmail = deal.payoutEmail || "";
  if (role === "buyer") {
    view.freelancerLink = `${BASE_URL}/?deal=${deal.id}&key=${deal.freelancerKey}`;
    view.buyerLink = `${BASE_URL}/?deal=${deal.id}&key=${deal.buyerKey}`;
  }
  return view;
}

/* ---------------- Routes ---------------- */

app.post("/api/deals", wrap(async (req, res) => {
  if (deals.size >= MAX_DEALS) throw fail(503, "The demo is full right now. Please try again later.");
  const title = String(req.body.title || "").trim();
  const amount = String(req.body.amount || "").trim();
  const criteria = Array.isArray(req.body.criteria)
    ? req.body.criteria.map((c) => String(c).trim()).filter(Boolean)
    : [];
  if (!title || title.length > 120) throw fail(400, "Enter a job title (up to 120 characters)");
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > 1000) {
    throw fail(400, "Enter a valid amount between 0.01 and 1000, like 10.00");
  }
  if (criteria.length < 1 || criteria.length > 8) throw fail(400, "Add between 1 and 8 acceptance criteria");
  if (criteria.some((c) => c.length > 300)) throw fail(400, "Each criterion must be under 300 characters");

  const deal = {
    id: randomUUID(),
    buyerKey: randomBytes(16).toString("hex"),
    freelancerKey: randomBytes(16).toString("hex"),
    title,
    amount,
    criteria,
    status: "awaiting_payment",
    createdAt: new Date().toISOString(),
    events: [],
    changeRequests: 0,
    changeNote: "",
    deadlineAt: null,
    autoReleaseAt: null,
  };
  log(deal, "Deal created");
  deals.set(deal.id, deal);
  res.json({ id: deal.id, buyerKey: deal.buyerKey });
}));

app.get("/api/deals/:id", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  const role = auth(req, deal);
  res.json(viewFor(deal, role));
}));

// Download or view a file. The review file is open to both sides. The final file is locked for the buyer.
app.get("/api/deals/:id/files/:kind", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  const role = auth(req, deal);
  const kind = req.params.kind;
  if (kind !== "review" && kind !== "final") throw fail(404, "File not found");
  if (kind === "final" && role !== "freelancer" && deal.status !== "released") {
    throw fail(403, "The final files unlock when the payment is released");
  }
  const f = kind === "review" ? deal.reviewFile : deal.finalFile;
  if (!f) throw fail(404, "There is no file here yet");
  res.set({
    "Content-Type": f.mime,
    "Content-Disposition": `${kind === "review" ? "inline" : "attachment"}; filename="${f.name}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
  });
  res.send(f.data);
}));

// Buyer starts the PayPal payment. The key in the return link proves it is the buyer coming back.
app.post("/api/deals/:id/pay", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  auth(req, deal, "buyer");
  const order = await withLock(deal, async () => {
    if (deal.status !== "awaiting_payment") throw fail(409, "This deal is already paid");
    const o = await paypal.createAuthorizeOrder({
      amount: deal.amount,
      description: deal.title.slice(0, 120),
      returnUrl: `${BASE_URL}/paypal/return?deal=${deal.id}&k=${deal.buyerKey}`,
      cancelUrl: `${BASE_URL}/?deal=${deal.id}&key=${deal.buyerKey}&notice=payment_cancelled`,
    });
    deal.orderId = o.id;
    return o;
  });
  res.json({ approveUrl: order.approveUrl });
}));

// PayPal sends the buyer back here after approval. We place the hold now.
app.get("/paypal/return", async (req, res) => {
  const deal = deals.get(String(req.query.deal || ""));
  if (!deal) return res.redirect("/?notice=deal_not_found");
  if (!safeEqual(String(req.query.k || ""), deal.buyerKey)) return res.redirect("/?notice=bad_link");
  const back = `/?deal=${deal.id}&key=${deal.buyerKey}`;
  try {
    await withLock(deal, async () => {
      if (deal.status === "awaiting_payment" && deal.orderId) {
        deal.authorizationId = await paypal.authorizeOrder(deal.orderId);
        deal.status = "funds_held";
        deal.deadlineAt = Date.now() + DELIVERY_WINDOW;
        log(deal, `Buyer paid $${deal.amount}. Funds held by PayPal`);
      }
    });
    res.redirect(back);
  } catch (e) {
    console.error(e.details || e);
    res.redirect(e.status === 409 ? back : `${back}&notice=payment_failed`);
  }
});

// Freelancer submits a review copy (testable by the buyer) and an optional locked final delivery.
app.post("/api/deals/:id/deliver", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  auth(req, deal, "freelancer");
  await withLock(deal, async () => {
    const canSubmit = ["funds_held", "changes_requested"].includes(deal.status)
      || (deal.status === "delivered" && deal.verification?.verdict === "fail");
    if (!canSubmit) {
      throw fail(409, deal.status === "delivered"
        ? "The AI already passed this work. Wait for the buyer's decision."
        : `Work can't be submitted while the deal is "${deal.status}"`);
    }
    const payoutEmail = cleanEmail(req.body.payoutEmail || deal.payoutEmail);
    const reviewText = String(req.body.reviewCopy || "").trim();
    const finalText = String(req.body.finalWork || "").trim();
    if (reviewText.length > 8000) throw fail(400, "The review text is too long (max 8000 characters)");
    if (finalText.length > 20000) throw fail(400, "The final text is too long (max 20000 characters)");

    // A new file replaces the old one. If no new file is sent, the old one stays.
    const reviewFile = parseFile(req.body.reviewFile, "review") || deal.reviewFile || null;
    const finalFile = parseFile(req.body.finalFile, "final") || deal.finalFile || null;
    if (!reviewText && !reviewFile) throw fail(400, "Add review text or a review file");

    const others = totalBytes() - fileBytes(deal);
    if (others + (reviewFile?.size || 0) + (finalFile?.size || 0) > MAX_TOTAL_BYTES) {
      throw fail(503, "The demo storage is full right now. Please try again later.");
    }

    let deliverable = reviewText;
    let attach = null;
    if (reviewFile && reviewFile.mime === "text/plain") {
      deliverable += `\n\n[Attached text file: ${reviewFile.name}]\n${reviewFile.data.toString("utf8").slice(0, 8000)}`;
    } else if (reviewFile) {
      attach = { mime: reviewFile.mime, base64: reviewFile.data.toString("base64") };
    }
    if (!deliverable.trim()) deliverable = "(No text was written. See the attached file.)";

    const checks = [...deal.criteria];
    if (deal.changeNote) checks.push(`Addresses the buyer's change request: ${deal.changeNote}`);

    const verification = await verifyDeliverable({
      title: deal.title,
      criteria: checks,
      deliverable,
      file: attach,
    });

    deal.payoutEmail = payoutEmail;
    deal.reviewCopy = reviewText;
    deal.reviewFile = reviewFile;
    deal.finalWork = finalText;
    deal.finalFile = finalFile;
    deal.verification = verification;
    deal.status = "delivered";
    if (verification.verdict === "pass") {
      deal.autoReleaseAt = Date.now() + REVIEW_WINDOW;
      deal.deadlineAt = null;
    } else {
      deal.deadlineAt = Date.now() + FIX_WINDOW;
      deal.autoReleaseAt = null;
    }
    log(deal, `Work submitted. AI verdict: ${verification.verdict}`);
  });
  res.json(viewFor(deal, "freelancer"));
}));

app.post("/api/deals/:id/request-changes", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  auth(req, deal, "buyer");
  await withLock(deal, async () => {
    if (deal.status !== "delivered") throw fail(409, "There is no delivered work to review yet");
    if (deal.changeRequests >= MAX_CHANGE_ROUNDS) throw fail(409, "No change rounds are left");
    const note = String(req.body.note || "").trim();
    if (note.length < 3 || note.length > 500) throw fail(400, "Describe the change you need (3 to 500 characters)");
    deal.changeRequests += 1;
    deal.changeNote = note;
    deal.status = "changes_requested";
    deal.deadlineAt = Date.now() + FIX_WINDOW;
    deal.autoReleaseAt = null;
    log(deal, `Buyer requested changes (round ${deal.changeRequests} of ${MAX_CHANGE_ROUNDS}): ${note}`);
  });
  res.json(viewFor(deal, "buyer"));
}));

app.post("/api/deals/:id/release", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  auth(req, deal, "buyer");
  await withLock(deal, async () => {
    if (deal.status !== "delivered") throw fail(409, "There is no delivered work to release payment for");
    await settleRelease(deal, "Buyer approved. Payment released and final files unlocked");
  });
  res.json(viewFor(deal, "buyer"));
}));

// Retry a failed payout. The freelancer can also correct their PayPal email.
app.post("/api/deals/:id/retry-payout", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  const role = auth(req, deal);
  await withLock(deal, async () => {
    if (deal.status !== "released" || deal.payout?.status !== "failed") throw fail(409, "There is no failed payout to retry");
    if (role === "freelancer" && req.body.email) deal.payoutEmail = cleanEmail(req.body.email);
    await sendPayoutFor(deal);
  });
  res.json(viewFor(deal, role));
}));

app.post("/api/deals/:id/refund", wrap(async (req, res) => {
  const deal = getDeal(req.params.id);
  auth(req, deal, "buyer");
  await withLock(deal, async () => {
    const reason = refundBlockedReason(deal);
    if (reason) throw fail(409, reason);
    await paypal.voidAuthorization(deal.authorizationId);
    deal.status = "refunded";
    deal.deadlineAt = null;
    deal.autoReleaseAt = null;
    log(deal, "Held money returned to the buyer");
  });
  res.json(viewFor(deal, "buyer"));
}));

   // AI helper: flags vague criteria and suggests checkable rewrites (rate limited).
   let helpCalls = [];
   app.post("/api/criteria-help", wrap(async (req, res) => {
     const now = Date.now();
     helpCalls = helpCalls.filter((t) => now - t < 60000);
     if (helpCalls.length >= 20) throw fail(429, "Too many requests right now. Try again in a minute.");
     helpCalls.push(now);
     const title = String(req.body.title || "").trim().slice(0, 120);
     const criteria = Array.isArray(req.body.criteria)
       ? req.body.criteria.map((c) => String(c).trim()).filter(Boolean).slice(0, 8)
       : [];
     if (!criteria.length) throw fail(400, "Write at least one criterion first");
     if (criteria.some((c) => c.length > 300)) throw fail(400, "Each criterion must be under 300 characters");
     res.json({ items: await improveCriteria({ title, criteria }) });
   }));
// Errors that happen before a route runs, such as a request body that is too large.
app.use((err, req, res, next) => {
  const tooLarge = err.type === "entity.too.large";
  res.status(tooLarge ? 413 : err.status || 400).json({
    error: tooLarge ? "The files are too large. Each file must be 2 MB or smaller." : "Bad request",
  });
});

/* ---------------- Automatic rules (checked every 15 seconds) ---------------- */

setInterval(async () => {
  const now = Date.now();
  for (const deal of deals.values()) {
    if (deal.busy || deal.sweepFailed) continue;
    const verdict = deal.verification?.verdict;
    const missedDeadline = deal.deadlineAt && now > deal.deadlineAt
      && (["funds_held", "changes_requested"].includes(deal.status)
        || (deal.status === "delivered" && verdict === "fail"));
    const reviewEnded = deal.status === "delivered" && verdict === "pass"
      && deal.autoReleaseAt && now > deal.autoReleaseAt;
    if (!missedDeadline && !reviewEnded) continue;
    try {
      await withLock(deal, async () => {
        if (missedDeadline) {
          await paypal.voidAuthorization(deal.authorizationId);
          deal.status = "refunded";
          deal.deadlineAt = null;
          deal.autoReleaseAt = null;
          log(deal, "Deadline passed without approved work. Held money returned to the buyer");
        } else {
          await settleRelease(deal, "Review window ended with no objection. Payment auto-released to the freelancer");
        }
      });
    } catch (e) {
      console.error("Automatic settlement failed", e.details || e);
      deal.sweepFailed = true;
      log(deal, "Automatic settlement failed");
    }
  }
}, 15000);

// Follow payouts until PayPal says whether the money arrived.
setInterval(async () => {
  for (const deal of deals.values()) {
    const p = deal.payout;
    if (!p || p.status !== "pending" || deal.busy || deal.polling || p.checks > 180) continue;
    deal.polling = true;
    try {
      p.checks += 1;
      const r = await paypal.getPayout(p.batchId);
      const item = r.itemStatus;
      if (item === "SUCCESS") {
        p.status = "paid";
        log(deal, `Freelancer paid $${p.net}`);
      } else if (["FAILED", "RETURNED", "BLOCKED", "DENIED", "REFUNDED", "UNCLAIMED", "ONHOLD"].includes(item) || r.batchStatus === "DENIED") {
        p.status = "failed";
        p.error = r.error || (item === "UNCLAIMED" ? "That email has no PayPal account yet" : `PayPal status: ${item || r.batchStatus}`);
        log(deal, "Payout failed. Check the PayPal email and retry");
      }
    } catch (e) {
      console.error("Could not check the payout", e.details || e);
    } finally {
      deal.polling = false;
    }
  }
}, 10000);

setInterval(() => saveChanged(deals), 3000); // also saves changes made by the timers above
const shutdown = async () => { await saveChanged(deals); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, () => console.log(`ProofPay running at ${BASE_URL}`));