# UniUni Shopify Tracker

Auto-patches UniUni tracking URLs on Shopify fulfillments so customers get a real clickable tracking link instead of a dead plain-text number.

## How It Works

When a fulfillment is created or updated in Shopify with a UniUni tracking number, Shopify doesn't recognize UniUni as a carrier, so no tracking link is generated. This app:

1. Listens for `fulfillments/create` and `fulfillments/update` webhooks from Shopify
2. Detects if the tracking number belongs to UniUni (via regex pattern matching)
3. Calls the Shopify API to update the fulfillment with:
   - **Carrier**: `UniUni`
   - **Tracking URL**: `https://www.uniuni.com/track?trackingNumber=XXXXX`

The customer's "Track Your Order" link in their shipping email / order status page will now work correctly.

---

## Setup

### 1. Shopify Custom App

Go to **Shopify Admin → Apps → Develop Apps → Create App**

Give it a name like `UniUni Tracker`, then set these **Admin API scopes**:
- `read_orders`
- `write_fulfillments`
- `read_fulfillments`

Install the app and copy the **Admin API access token** (starts with `shpat_`).

---

### 2. Deploy to Railway

This app is a perfect fit for your existing Railway setup.

```bash
# In your Railway project, create a new service
# Point it to this repo / folder

# Set environment variables in Railway:
SHOPIFY_SHOP=your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxx
SHOPIFY_WEBHOOK_SECRET=  # leave blank for now, fill in after step 3
PORT=3000
```

Deploy and get your Railway URL (e.g. `https://uniuni-tracker.up.railway.app`).

---

### 3. Register Shopify Webhooks

Go to **Shopify Admin → Settings → Notifications → Webhooks** (bottom of page).

Create two webhooks:

| Event | URL |
|---|---|
| `Fulfillment creation` | `https://your-app.railway.app/webhooks/fulfillment-created` |
| `Fulfillment update` | `https://your-app.railway.app/webhooks/fulfillment-updated` |

After creating them, copy the **Webhook signing secret** and add it to your Railway env as `SHOPIFY_WEBHOOK_SECRET`.

---

### 4. Backfill Historical Orders (Optional)

If you have past UniUni fulfillments without proper tracking links, run a backfill:

```bash
# Dry run first — shows what would be patched without making changes
curl -X POST https://your-app.railway.app/backfill \
  -H "Content-Type: application/json" \
  -d '{"days": 30, "dry_run": true}'

# Real run
curl -X POST https://your-app.railway.app/backfill \
  -H "Content-Type: application/json" \
  -d '{"days": 30, "dry_run": false}'
```

---

## UniUni Tracking Number Patterns

The app currently detects these patterns (edit `UNIUNI_PATTERNS` in `index.js` to adjust):

- `UU` + 10+ digits
- `1UU` + 8+ digits  
- `UUDA` + 8+ digits

To verify your actual UniUni tracking number format, check a real tracking number from your middleware and compare. If it doesn't match, add the pattern to the array.

---

## Testing

```bash
# Health check
curl https://your-app.railway.app/

# Simulate a webhook (without HMAC — only works if you temporarily disable verification)
curl -X POST https://your-app.railway.app/webhooks/fulfillment-created \
  -H "Content-Type: application/json" \
  -d '{"id": 123, "order_id": 456, "tracking_number": "UU1234567890", "tracking_url": null}'
```

---

## Notes

- The app responds `200 OK` to Shopify immediately before processing, preventing retry storms
- `notify_customer: false` on the patch so customers don't get a duplicate shipping email
- Idempotent — if the UniUni URL is already set, it skips the update
