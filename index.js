import express from "express";
import crypto from "crypto";
import { URLSearchParams } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const { STORES, PORT = 3000 } = process.env;

function parseStores() {
  if (!STORES) {
    console.error("❌ STORES environment variable is not set");
    return {};
  }
  const map = {};
  for (const entry of STORES.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length < 3) {
      console.warn(`[Config] Skipping invalid store entry: ${entry}`);
      continue;
    }
    const [shop, clientId, clientSecret, webhookSecret = ""] = parts;
    map[shop.toLowerCase()] = { shop, clientId, clientSecret, webhookSecret, token: null, tokenExpiresAt: 0 };
    console.log(`[Config] Loaded store: ${shop}.myshopify.com`);
  }
  return map;
}

const stores = parseStores();

const UNIUNI_TRACKING_URL = (n) =>
  `https://www.uniuni.com/tracking/#tracking-detail?no=${n}`;

const UNIUNI_PATTERNS = [/^UU[A-Z0-9]{8,}/i, /^1UU\d{8,}/i, /^UUDA\d{8,}/i, /^UNI\d{8,}/i];

function isUniUni(trackingNumber, trackingCompany) {
  if (!trackingNumber) return false;
  if (trackingCompany) {
    const c = trackingCompany.toLowerCase();
    if (c.includes("uniuni") || c.includes("uni-uni")) return true;
  }
  return UNIUNI_PATTERNS.some((p) => p.test(trackingNumber));
}

function getStoreFromHeader(req) {
  const domain = req.headers["x-shopify-shop-domain"] || "";
  const subdomain = domain.replace(".myshopify.com", "").toLowerCase();
  return stores[subdomain] || null;
}

async function getAccessToken(store) {
  if (store.token && Date.now() < store.tokenExpiresAt - 60_000) return store.token;
  console.log(`[Auth] Fetching token for ${store.shop}...`);
  const response = await fetch(
    `https://${store.shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: store.clientId,
        client_secret: store.clientSecret,
      }),
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token request failed for ${store.shop} (${response.status}): ${error}`);
  }
  const { access_token, expires_in } = await response.json();
  store.token = access_token;
  store.tokenExpiresAt = Date.now() + expires_in * 1000;
  console.log(`[Auth] ✅ Token acquired for ${store.shop}`);
  return store.token;
}

function verifyWebhook(req, store) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac || !store.webhookSecret) return false;
  const hash = crypto
    .createHmac("sha256", store.webhookSecret)
    .update(req.rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
}

async function shopifyRequest(store, method, path, body = null) {
  const token = await getAccessToken(store);
  const url = `https://${store.shop}.myshopify.com/admin/api/2026-04${path}`;
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

async function patchTracking(store, fulfillmentId, trackingNumber) {
  console.log(`[UniUni] [${store.shop}] Patching ${fulfillmentId} → ${trackingNumber}`);
  const token = await getAccessToken(store);
  const response = await fetch(
    `https://${store.shop}.myshopify.com/admin/api/2026-04/fulfillments/${fulfillmentId}/update_tracking.json`,
    {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        fulfillment: {
          tracking_info: {
            number: trackingNumber,
            url: UNIUNI_TRACKING_URL(trackingNumber),
            company: "UniUni",
          },
          notify_customer: false,
        },
      }),
    }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  console.log(`[UniUni] [${store.shop}] ✅ Done`);
}

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "shipflow-uniuni-tracker",
    stores: Object.keys(stores).map(s => `${s}.myshopify.com`),
  });
});

app.post("/webhooks/fulfillment-created", async (req, res) => {
  res.status(200).send("ok");
  const store = getStoreFromHeader(req);
  if (!store) {
    console.warn(`[Webhook] Unknown store: ${req.headers["x-shopify-shop-domain"]}`);
    return;
  }
  if (!verifyWebhook(req, store)) {
    console.warn(`[Webhook] HMAC failed for ${store.shop}`);
    return;
  }
  const { id, tracking_number, tracking_company, tracking_url } = req.body;
  console.log(`[Webhook] [${store.shop}] Created: ${id} | ${tracking_number} | ${tracking_company}`);
  if (!isUniUni(tracking_number, tracking_company)) return;
  if (tracking_url && tracking_url.includes("uniuni.com")) return;
  try { await patchTracking(store, id, tracking_number); }
  catch (e) { console.error(`[Webhook] [${store.shop}] Error:`, e.message); }
});

app.post("/webhooks/fulfillment-updated", async (req, res) => {
  res.status(200).send("ok");
  const store = getStoreFromHeader(req);
  if (!store) return;
  if (!verifyWebhook(req, store)) return;
  const { id, tracking_number, tracking_company, tracking_url } = req.body;
  if (!isUniUni(tracking_number, tracking_company)) return;
  if (tracking_url && tracking_url.includes("uniuni.com")) return;
  try { await patchTracking(store, id, tracking_number); }
  catch (e) { console.error(`[Webhook] [${store.shop}] Error:`, e.message); }
});

app.post("/backfill", async (req, res) => {
  const { days = 7, dry_run = false, shop = null } = req.body || {};
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const targetStores = shop
    ? [stores[shop.toLowerCase()]].filter(Boolean)
    : Object.values(stores);

  if (targetStores.length === 0) return res.status(400).json({ error: "No matching stores found" });

  const allResults = {};

  for (const store of targetStores) {
    const results = { checked: 0, patched: 0, skipped: 0, errors: 0 };
    try {
      const { orders } = await shopifyRequest(store, "GET", `/orders.json?status=any&updated_at_min=${since}&limit=250`);
      for (const order of orders) {
        const { fulfillments = [] } = await shopifyRequest(store, "GET", `/orders/${order.id}/fulfillments.json`);
        for (const f of fulfillments) {
          results.checked++;
          if (!isUniUni(f.tracking_number, f.tracking_company)) { results.skipped++; continue; }
          if (f.tracking_url && f.tracking_url.includes("uniuni.com")) { results.skipped++; continue; }
          if (!dry_run) {
            try { await patchTracking(store, f.id, f.tracking_number); results.patched++; }
            catch { results.errors++; }
          } else {
            console.log(`[Backfill] DRY RUN [${store.shop}]: would patch ${f.tracking_number}`);
            results.patched++;
          }
        }
      }
    } catch (e) {
      results.error = e.message;
    }
    allResults[store.shop] = results;
  }

  res.json({ success: true, dry_run, results: allResults });
});

app.get("/debug/:shop/:orderName", async (req, res) => {
  const store = stores[req.params.shop.toLowerCase()];
  if (!store) return res.status(404).json({ error: "Store not found" });
  try {
    const { orders } = await shopifyRequest(store, "GET", `/orders.json?name=%23${req.params.orderName}&status=any`);
    if (!orders || orders.length === 0) return res.json({ error: "Order not found" });
    const { fulfillments } = await shopifyRequest(store, "GET", `/orders/${orders[0].id}/fulfillments.json`);
    res.json(fulfillments.map(f => ({
      id: f.id,
      tracking_number: f.tracking_number,
      tracking_company: f.tracking_company,
      tracking_url: f.tracking_url,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 ShipFlow UniUni Tracker (multi-store) on port ${PORT}`);
  console.log(`   Stores loaded: ${Object.keys(stores).length}`);
  Object.keys(stores).forEach(s => console.log(`   • ${s}.myshopify.com`));
  console.log();
});
