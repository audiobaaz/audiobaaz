# Audiobaaz V1 — Launch Checklist

> The shortest path from where the codebase is today to a launchable
> V1 marketplace. Anything not on this list is explicitly **out of
> scope for V1** — defer until launch is complete.

**Last updated:** 2026-05-30 (post-PR-#3 merge; PR #4 open)

---

## The single question this document answers

> Can a seller list an IEM, can a buyer pay for it, can the seller
> ship it, can the buyer receive it, and can money be released safely
> to the seller?

Everything that does not directly move that flow forward is not V1.

---

## CURRENT PROJECT STATE — 2026-05-30

### MERGED on `dev`

- **Phase 1 schema substrate** (PR #2, merge commit `230d9ae`)
  - Migration 002: marketplace core (atomic `finalize_winning_payment` RPC, audit tables, enum amendments, drop `reserve_listing`)
  - Migration 003: refund lifecycle (`payments.refund_status` state machine + `initiate_refund` + `record_refund_outcome` RPCs)
  - Migration 004: `checkout_locks` table + acquire/release RPCs
  - Migration 005: invariant guards (immutability triggers + `listings.status` terminal-at-`sold`)
  - Migration 006: `listings.sold_order_id UUID UNIQUE NULL` — canonical ownership anchor (replaces `sold_offer_id` for ownership purposes; `sold_offer_id` retained as informational metadata only)
  - CI verification workflow (`.github/workflows/phase1-verification.yml`)
  - Acceptance scenarios A/B/C/D/E1/E2 + multi-connection stress harness at concurrency=100

- **Phase 2 payment routes** (PR #3, merge commit `7b294e9`)
  - `POST /api/payments/create` — acquires checkout lock, creates Razorpay order, inserts `payment_pending` order + `created` payment
  - `POST /api/payments/verify` — verifies signature, calls `finalize_winning_payment`, on `conflict` calls `initiate_refund`
  - `POST /api/payments/webhook` — verifies signature, upserts `webhook_events` for idempotency, dispatches `payment.captured` / `payment.failed` / `refund.processed` / `refund.failed` to RPCs
  - `src/lib/razorpay/client.ts` — lazy singleton (throws on first use, not at module load)
  - `src/lib/razorpay/helpers.ts` — timing-safe HMAC verifications

### OPEN

- **PR #4** — `feature/checkout-razorpay-wire → dev`
  - CheckoutForm wired: form → `POST /api/payments/create` → Razorpay modal → `POST /api/payments/verify` → redirect to `/orders/purchase/<order_id>`
  - `/api/checkout/mock` removed (file and directory)
  - Local `next build` GREEN; awaiting review/merge

### BLOCKED — until merge + real-world validation

- **Real Razorpay test transaction never executed.** The architecture is
  verified at the database layer (Phase 1 acceptance + stress) and the
  application layer (build-green, RPC contracts honoured), but no real
  Razorpay test capture has flowed through the system end-to-end.
- **Webhook delivery semantics not exercised.** Razorpay's webhook URL
  needs to be configured in the dashboard pointing at
  `https://dev.audiobaaz.com/api/payments/webhook`.
- **Razorpay env vars not yet on Vercel** for `dev` and `production`:
  `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

---

## Ownership model — canonical reminder

The lifetime ownership anchor is **`listings.sold_order_id`** (added in
migration 006 after PR #2 CI Scenario A surfaced that `sold_offer_id`
does not constrain direct buy-now captures).

- **`sold_order_id`** — UUID UNIQUE NULL. Set once inside
  `finalize_winning_payment` at the moment of `escrow_held`, immutable
  thereafter. The lifetime invariant lives here.
- **`sold_offer_id`** — UUID UNIQUE NULL. Informational metadata.
  Populated only when the order is offer-backed. Retained for forensic
  queries ("which negotiation became this sale?") but **NOT the
  ownership signal**.

Any documentation, comment, or code path that reads `sold_offer_id` as
the ownership signal must be corrected. Migration 006 is the canonical
reference.

---

## NEXT ENGINEERING TASK — Razorpay validation (NOT shipping)

Before any meaningful shipping work begins, run a real Razorpay
test-mode transaction on `dev.audiobaaz.com` and validate every
integration point:

| Check | Expected behaviour |
|-------|-------------------|
| **Payment creation** | Form submit → `POST /api/payments/create` returns `{ razorpay_order_id, razorpay_key_id, amount, currency, order_id }`. Order row exists at `payment_pending`. Payment row exists at `created`. checkout_lock acquired. |
| **Razorpay modal opens** | `window.Razorpay` loads via `next/script`. Modal opens with the returned key + order_id. Buyer can complete a test card payment (4111 1111 1111 1111). |
| **Verify route** | `POST /api/payments/verify` verifies signature, calls `finalize_winning_payment`, returns `{ result: 'winner' }`. Browser redirects to `/orders/purchase/<order_id>`. |
| **Webhook route** | Razorpay's `payment.captured` webhook fires ~1–5s later. Handler verifies signature, upserts `webhook_events`, calls `finalize_winning_payment` which returns `noop` (already captured). `webhook_events.status = 'processed'`. |
| **Escrow held transition** | `orders.status = 'escrow_held'`, `escrow_held_at` set. `listings.status = 'sold'`, `sold_order_id` set, `sold_at` set. `payments.status = 'captured'`. |
| **Audit rows** | One `order_events` row with `event_name='payment_captured'`. Zero duplicate rows on webhook replay. |
| **Webhook events** | One `webhook_events` row keyed on `(razorpay, payment.captured:<entity_id>)`. Replay returns `{ replay: true }`. |
| **Race-loser refund path** | Hard to trigger deliberately in test; architecture verified at concurrency=100 in Phase 1 CI. Spot-check by running two concurrent /create calls for the same listing in dev tools. Loser's order should be `cancelled`, `payments.refund_status` should be `pending`. |
| **Payment failure path** | Test with Razorpay's failure-simulation card. `payments.status = 'failed'`, `orders.status = 'payment_failed'`. Listing untouched (Decision 6). Buyer can retry. |
| **Checkout-lock contention** | Two browser tabs hit `/create` for the same listing back-to-back. First wins; second returns 409 CHECKOUT_BUSY. After 5-min TTL, re-attempt succeeds. |

Until those checks pass, **everything else is premature**.

---

## NEXT BRANCH EXPECTED TO RECEIVE WORK

`feature/checkout-razorpay-wire` — until PR #4 merges. After merge,
post-validation work continues on a fresh branch off `dev`.

---

## DO NOT START YET

Reason: the transaction engine has not been validated end-to-end with
real Razorpay traffic. Until that succeeds, the following work is
premature and risks rebuilding on an unverified foundation:

- **AI features** — recommendations, dispute analysis, fraud detection, anything ML-driven
- **Merchant gamification** — V2 distributed verifier scope; not V1
- **Reputation systems** — beyond the `seller_score` / `buyer_score` columns already in schema
- **Recommendation systems** — homepage personalisation, "similar listings", anything algorithmic
- **Dynamic pricing** — auto-adjust asking price, surge pricing, market-rate tracking
- **Seller leaderboards** — top-sellers, badges, public rankings
- **Escrow staking concepts** — anything that holds seller capital before a sale
- **Advanced dispute automation** — auto-resolve based on evidence patterns, ML-graded outcomes
- **Payout automation** — Razorpay Route / Razorpay Payouts API. V1 is manual UPI by admin

If a stakeholder asks for one of these before V1 launches, the answer
is "after launch, not before." Launch first; optimise after data.

---

## Order of work — launch-critical sequence

### Step 1 — Merge PR #4

CheckoutForm + mock removal. Awaiting review.

### Step 2 — Configure Razorpay credentials

Vercel (`dev` + `production` envs):
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`

Razorpay dashboard:
- Webhook URL → `https://dev.audiobaaz.com/api/payments/webhook` (and eventually production)
- Webhook events enabled: `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`

### Step 3 — Run real Razorpay test purchase

Per the validation matrix in "NEXT ENGINEERING TASK" above. Document
results. If anything fails, that's the next bug to fix.

### Step 4 — Validate `escrow_held` lifecycle

After a successful test capture, walk the order through the full
lifecycle:
- `escrow_held → seller_confirmed` (when seller acts)
- `→ shipped → delivered` (manual today; Shiprocket-driven later)
- `→ inspection` (auto via `set_inspection_window` trigger on `delivered`)
- `→ completed` (manual via dev advance-order tooling, or after inspection window)

### Step 5 — Validate webhook replay path

Trigger replay manually (Razorpay dashboard supports re-firing events):
- Re-fire a `payment.captured` event for a captured payment
- Confirm `webhook_events` returns `replay: true`
- Confirm zero new `order_events` rows
- Confirm `payments` / `orders` / `listings` byte-for-byte unchanged

### Step 6 — Validate payment failure path

Use Razorpay's test card for failures.
- `payments.status = 'failed'`
- `orders.status = 'payment_failed'`
- Buyer can retry (form re-submit)

### Step 7 — Validate concurrent-buyer race path

Either (a) two browser tabs hitting `/create` near-simultaneously, or
(b) write a Node script that hits `/create` twice in parallel for the
same listing. Confirm:
- Exactly one buyer reaches `escrow_held`
- Other buyer's order is `cancelled`
- `payments.refund_status = 'pending'` for the loser
- Buyer-facing message reads "another buyer completed payment first"

### Step 8 — Build order timeline UI

Order detail page already exists (`/orders/purchase/[orderId]`). Verify
it correctly renders the post-Razorpay states. Add any missing copy.

### Step 9 — Build shipping abstraction

**Important:** lack of Shiprocket credentials is NOT currently blocking
development. Use a provider abstraction so shipping work can proceed
with a mock implementation while real Shiprocket credentials are
acquired separately.

```
ShippingProvider
  createShipment(order: Order): Promise<ShipmentResult>
  getTracking(awb: string): Promise<TrackingResult>

implementations:
  MockShippingProvider     — synthetic AWBs, fake tracking, no external calls
  ShiprocketProvider       — real Shiprocket integration; swap in when ready
```

The mock implementation must allow:
- Seller shipment flow (UI works end-to-end)
- Order timeline updates (`seller_confirmed → shipped`)
- Shipment lifecycle visibility (admin panel, buyer order page)
- Telegram notifications (using fake AWB codes)

Shiprocket later becomes a **provider swap**, not an architecture
rewrite. The audit's §5.9 keep-list (`src/lib/shiprocket/{client,helpers}.ts`)
becomes the body of `ShiprocketProvider` when those credentials land.

### Step 10 — Build seller shipment flow

Seller dashboard order detail gains a "Create shipment" button that
calls the shipping provider. Updates `orders.status` to
`seller_confirmed` then `shipped`. Stores `tracking_number`,
`courier_name`, `shiprocket_order_id`, `shiprocket_shipment_id`.
Telegrams the buyer with tracking info.

### Step 11 — Build admin operations

- Wire admin dispute resolution to call `initiate_refund(...)` on
  buyer-favourable verdicts (`full_refund` / `partial_refund`).
- Admin payouts page gains a real UPI reference text input at trigger
  time. Route writes `payout_reference`, `payout_at`,
  `payout_status='paid'`. Telegram the seller.

### Step 12 — Closed beta

Once Steps 1–11 are validated end-to-end, run a small invite-only
beta with 5–10 real listings + 5–10 real buyers. Watch the audit
tables. Fix anything that surfaces. Then open V1 launch.

---

## Out of scope for V1 — defer until after launch

These are recorded so they don't sneak back into the priority list.

- Counter-offers (locked product decision: not happening)
- Auto-accept threshold logic
- Watchlist + saved searches (UI exists in spec, not built)
- Ratings post-delivery widget
- Merchant / curator network (V2 distributed verifier scope)
- Razorpay Route / Payouts API integration
- Shiprocket inbound webhook (V1 is pull-side tracking)
- Multi-connection stress at production-scale concurrency
- Refund queue worker (V1 uses synchronous in-handler refund)
- Real-time order status push to buyer (Telegram covers V1)
- Analytics dashboards
- Referral / invite system
- AI-anything (see "DO NOT START YET" above)
- VPS migration off Vercel / Supabase
- Mobile apps
- Anything in the V2 scope from CLAUDE.md

---

## Cross-references

- Architecture (locked) — `docs/context/payments-shipping.md`
- Audit (authoritative on Phase 2 disposition) — `docs/reviews/payments-session-zero.md`
- Verification runbook — `supabase/tests/RUNBOOK.md`
- CI workflow — `.github/workflows/phase1-verification.yml`
- Buyer flow status — `docs/context/buyer-flow.md`
- Seller flow status — `docs/context/seller-flow.md`
- Admin panel status — `docs/context/admin-panel.md`
- Deployment + domains — `docs/DEPLOYMENT.md`
