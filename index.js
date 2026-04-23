import express from "express";
import crypto from "crypto";
import { URLSearchParams } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const {
  SHOPIFY_SHOP,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_WEBHOOK_SECRET,
  PORT = 3000,
} = process.env;

const UNIUNI_TRACKING_URL = (n) =>
  `https://www.uniuni.com/tracking/#tracking-detail?no=${n}`;

const UNIUNI_PATTERNS = [
  /^UU[A-Z0-9]{8,}/i,
  /^1UU\d{8,}/i,
  /^UUDA\d{8,}/i,
  /^UNI\d{8,}/i,
];

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  console.log("[Auth] Fetching new Shopify access token...");
  const response = await fetch(
    `https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token request failed (${response.status}): ${error}`);
  }
  const { access_token, expires_in } = await response.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  console.log(`[Auth] ✅ Token acquired`);
  return cachedToken;
}

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

function verifyWebhook(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac || !SHOPIFY_WEBHOOK_SECRET) return false;
  const hash = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(req.rawBody).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
}

function isUniUni(trackingNumber, trackingCompany) {
  if (!trackingNumber) return false;
  if (trackingCompany) {
    const c = trackingCompany.toLowerCase();
    if (c.includes("uniuni") || c.includes("uni-uni")) return true;
  }
  return UNIUNI_PATTERNS.some((p) => p.test(trackingNumber));
}

async function shopifyRequest(method, path, body = null) {
  const token = await getAccessToken();
  const url = `https://${SHOPIFY_SHOP}.myshopify.com/admin/api/2025-01${path}`;
  const options = {
    method,
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function patchTracking(fulfillmentId, trackingNumber) {
  console.log(`[UniUni] Patching ${fulfillmentId} → ${trackingNumber}`);
  await shopifyRequest("POST", `/fulfillments/${fulfillmentId}/update_tracking.json`, {
    fulfillment: {
      tracking_info: {
        number: trackingNumber,
        url: UNIUNI_TRACKING_URL(trackingNumber),
        company: "UniUni",
      },
      notify_customer: false,
    },
  });
  console.log(`[UniUni] ✅ Done`);
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "shipflow-uniuni-tracker", shop: SHOPIFY_SHOP });
});

app.post("/webhooks/fulfillment-created", async (req, res) => {
  res.status(200).send("ok");
  if (!verifyWebhook(req)) return;
  const { id, tracking_number, tracking_company, tracking_url } = req.body;
  console.log(`[Webhook] Created: ${id} | ${tracking_number} | ${tracking_company}`);
  if (!isUniUni(tracking_number, tracking_company)) return;
  if (tracking_url && tracking_url.includes("uniuni.com")) return;
  try { await patchTracking(id, tracking_number); } catch (e) { console.error(e.message); }
});

app.post("/webhooks/fulfillment-updated", async (req, res) => {
  res.status(200).send("ok");
  if (!verifyWebhook(req)) return;
  const { id, tracking_number, tracking_company, tracking_url } = req.body;
  if (!isUniUni(tracking_number, tracking_company)) return;
  if (tracking_url && tracking_url.includes("uniuni.com")) return;
  try { await patchTracking(id, tracking_number); } catch (e) { console.error(e.message); }
});

app.post("/backfill", async (req, res) => {
  const { days = 7, dry_run = false } = req.body || {};
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { orders } = await shopifyRequest("GET", `/orders.json?status=any&updated_at_min=${since}&limit=250`);
    const results = { checked: 0, patched: 0, skipped: 0, errors: 0 };
    for (const order of orders) {
      const { fulfillments = [] } = await shopifyRequest("GET", `/orders/${order.id}/fulfillments.json`);
      for (const f of fulfillments) {
        results.checked++;
        if (!isUniUni(f.tracking_number, f.tracking_company)) { results.skipped++; continue; }
        if (f.tracking_url && f.tracking_url.includes("uniuni.com")) { results.skipped++; continue; }
        if (!dry_run) {
          try { await patchTracking(f.id, f.tracking_number); results.patched++; }
          catch { results.errors++; }
        } else { results.patched++; }
      }
    }
    res.json({ success: true, dry_run, ...results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 ShipFlow UniUni Tracker on port ${PORT} | ${SHOPIFY_SHOP}.myshopify.com`);
});
