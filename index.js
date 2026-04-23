import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// ─── Config ───────────────────────────────────────────────────────────────────
const {
  SHOPIFY_SHOP,           // e.g. your-store.myshopify.com
  SHOPIFY_ACCESS_TOKEN,   // Admin API token (read_orders + write_fulfillments)
  SHOPIFY_WEBHOOK_SECRET, // Webhook signing secret
  PORT = 3000,
} = process.env;

// UniUni tracking URL pattern
const UNIUNI_TRACKING_URL = (trackingNumber) =>
  `https://www.uniuni.com/track?trackingNumber=${trackingNumber}`;

// UniUni tracking number patterns (adjust if needed)
const UNIUNI_PATTERNS = [
  /^UU\d{10,}/i,         // UU + digits
  /^1UU\d{8,}/i,         // 1UU prefix
  /^UUDA\d{8,}/i,        // UUDA prefix
  /^[A-Z]{2}\d{9}[A-Z]{2}$/i, // Standard postal format sometimes used
];

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf; // needed for HMAC verification
  },
}));

// ─── Webhook HMAC Verification ────────────────────────────────────────────────
function verifyWebhook(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac || !SHOPIFY_WEBHOOK_SECRET) return false;
  const hash = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isUniUniTracking(trackingNumber) {
  if (!trackingNumber) return false;
  return UNIUNI_PATTERNS.some((pattern) => pattern.test(trackingNumber));
}

async function shopifyRequest(method, path, body = null) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01${path}`;
  const options = {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function patchFulfillmentTracking(fulfillmentId, orderId, trackingNumber) {
  console.log(`[UniUni] Patching fulfillment ${fulfillmentId} with tracking ${trackingNumber}`);
  
  // Shopify Admin API v2024-01 uses fulfillment update endpoint
  const payload = {
    fulfillment: {
      tracking_info: {
        number: trackingNumber,
        url: UNIUNI_TRACKING_URL(trackingNumber),
        company: "UniUni",
      },
      notify_customer: false, // Don't re-notify, they already got the email
    },
  };

  try {
    const result = await shopifyRequest(
      "POST",
      `/fulfillments/${fulfillmentId}/update_tracking.json`,
      payload
    );
    console.log(`[UniUni] ✅ Successfully updated tracking URL for fulfillment ${fulfillmentId}`);
    return result;
  } catch (err) {
    console.error(`[UniUni] ❌ Failed to update tracking:`, err.message);
    throw err;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "uniuni-shopify-tracker" });
});

// ── Fulfillment Created Webhook ────────────────────────────────────────────────
// Register this at: https://your-store.myshopify.com/admin/settings/notifications
// Topic: fulfillments/create
// URL: https://your-app.railway.app/webhooks/fulfillment-created
app.post("/webhooks/fulfillment-created", async (req, res) => {
  // Always respond 200 first to avoid Shopify retries
  res.status(200).send("ok");

  if (!verifyWebhook(req)) {
    console.warn("[Webhook] HMAC verification failed — ignoring");
    return;
  }

  const fulfillment = req.body;
  const { id: fulfillmentId, order_id, tracking_number, tracking_company } = fulfillment;

  console.log(`[Webhook] Fulfillment created: ${fulfillmentId} | Tracking: ${tracking_number} | Company: ${tracking_company}`);

  // Only process if tracking number looks like UniUni
  if (!isUniUniTracking(tracking_number)) {
    console.log(`[Webhook] Tracking number ${tracking_number} does not match UniUni — skipping`);
    return;
  }

  // Only patch if the tracking URL isn't already set correctly
  const existingUrl = fulfillment.tracking_url || "";
  if (existingUrl.includes("uniuni.com")) {
    console.log(`[Webhook] UniUni URL already set — skipping`);
    return;
  }

  try {
    await patchFulfillmentTracking(fulfillmentId, order_id, tracking_number);
  } catch (err) {
    console.error("[Webhook] Error patching fulfillment:", err.message);
  }
});

// ── Fulfillment Updated Webhook ────────────────────────────────────────────────
// Topic: fulfillments/update
// Catches cases where tracking is added after fulfillment creation
app.post("/webhooks/fulfillment-updated", async (req, res) => {
  res.status(200).send("ok");

  if (!verifyWebhook(req)) {
    console.warn("[Webhook] HMAC verification failed — ignoring");
    return;
  }

  const fulfillment = req.body;
  const { id: fulfillmentId, order_id, tracking_number, tracking_url } = fulfillment;

  if (!isUniUniTracking(tracking_number)) return;
  if (tracking_url && tracking_url.includes("uniuni.com")) return; // already fixed

  console.log(`[Webhook] Fulfillment updated with UniUni tracking: ${tracking_number}`);

  try {
    await patchFulfillmentTracking(fulfillmentId, order_id, tracking_number);
  } catch (err) {
    console.error("[Webhook] Error patching fulfillment:", err.message);
  }
});

// ── Manual Backfill Endpoint ───────────────────────────────────────────────────
// POST /backfill with { "days": 7 } to fix historical fulfillments
app.post("/backfill", async (req, res) => {
  const { days = 7, dry_run = false } = req.body || {};
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[Backfill] Starting backfill for last ${days} days (dry_run: ${dry_run})`);

  try {
    // Fetch recent orders with fulfillments
    const { orders } = await shopifyRequest(
      "GET",
      `/orders.json?status=any&updated_at_min=${since}&limit=250`
    );

    const results = { checked: 0, patched: 0, skipped: 0, errors: 0 };

    for (const order of orders) {
      const { fulfillments = [] } = await shopifyRequest(
        "GET",
        `/orders/${order.id}/fulfillments.json`
      ).then((d) => d);

      for (const f of fulfillments) {
        results.checked++;
        const { id, tracking_number, tracking_url } = f;

        if (!isUniUniTracking(tracking_number)) {
          results.skipped++;
          continue;
        }

        if (tracking_url && tracking_url.includes("uniuni.com")) {
          console.log(`[Backfill] ${tracking_number} already correct — skipping`);
          results.skipped++;
          continue;
        }

        console.log(`[Backfill] ${dry_run ? "[DRY RUN] Would patch" : "Patching"}: ${tracking_number}`);

        if (!dry_run) {
          try {
            await patchFulfillmentTracking(id, order.id, tracking_number);
            results.patched++;
          } catch {
            results.errors++;
          }
        } else {
          results.patched++;
        }
      }
    }

    res.json({ success: true, ...results });
  } catch (err) {
    console.error("[Backfill] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 UniUni Shopify Tracker running on port ${PORT}`);
  console.log(`   Shop: ${SHOPIFY_SHOP}`);
  console.log(`   Webhook endpoints:`);
  console.log(`     POST /webhooks/fulfillment-created`);
  console.log(`     POST /webhooks/fulfillment-updated`);
  console.log(`     POST /backfill  (manual fix)\n`);
});
