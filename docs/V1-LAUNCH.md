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

### BLOCKED — until merge + lifecycle validation

- **No real Razorpay test transaction has been executed end-to-end.**
  Razorpay test/production credentials are not currently available
  to the project. The architecture is verified at the database
  layer (Phase 1 acceptance + stress at concurrency=100) and at the
  application layer (build-green, RPC contracts honoured), but no
  capture has flowed through `https://api.razorpay.com`.
- **This is no longer a launch blocker.** The next milestone is
  *marketplace lifecycle validation* using a dev-only synthetic
  payment path that exercises every line of the real route except
  the outbound HTTP call to Razorpay (see "NEXT ENGINEERING TASK"
  below). Real Razorpay validation becomes a swap-in once credentials
  are available.
- **Razorpay env vars** (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`) are not yet on Vercel for `dev` or
  `production`. They land when credentials do; no blocker today.

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

## NEXT ENGINEERING TASK — Marketplace lifecycle validation (no Razorpay dependency)

Real Razorpay credentials are not in our control today. The project
should not block on them. Validation proceeds in three small steps,
in this order:

1. **Verify CheckoutForm against the current credential-less state.**
   Before building any abstraction or simulator, learn what
   `feature/checkout-razorpay-wire` actually does today when the
   buyer clicks "Pay". Without credentials, `/api/payments/create`
   will reach the Razorpay client and fail. The questions worth
   answering empirically:
   - Does `/api/payments/create` fail with a clear error response,
     or a 500 with no useful body?
   - Does the buyer see a useful error in the UI, or a silent
     spinner?
   - Does a partially-created order get left at `payment_pending`?
     Does its `checkout_locks` row leak? Does the TTL clean it up?
   - Does the form recover, or does the buyer have to refresh?
   These answers shape what surface the abstraction needs to
   protect against. Skipping this step means designing the
   abstraction without knowing what it has to absorb.

2. **Introduce a `PaymentProvider` abstraction** that mirrors the
   `ShippingProvider` shape:

   ```ts
   // src/lib/payments/provider.ts
   export interface PaymentProvider {
     createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
     verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
   }
   ```

   Two implementations:
   - `RazorpayPaymentProvider` — wraps the existing
     `src/lib/razorpay/{client,helpers}.ts`. The body of the
     interface methods is the code already merged in PR #3; this
     is a refactor, not a rewrite. `/api/payments/{create,verify}`
     route handlers call the provider instead of the Razorpay
     client directly.
   - `DevPaymentProvider` — selected when
     `PAYMENT_PROVIDER=dev` (gated additionally by
     `NODE_ENV !== 'production'`). `createOrder` returns a
     synthetic `{ razorpay_order_id: 'dev_order_<uuid>', ... }`
     without an outbound HTTP call. `verifyPayment` returns a
     synthetic `{ payment_id: 'dev_payment_<uuid>',
     signature: '<computed-with-dev-key-secret>' }` that the
     existing signature-verification helper can validate using
     the dev secret.

   This is the cleanest shape: provider selection is a runtime/config
   concern; the routes don't branch on `NODE_ENV`; the verify-path
   signature verification stays untouched (it just verifies against
   whichever secret matches the active provider).

3. **Webhook simulation** — webhooks are inbound, not provider-driven,
   so the same abstraction doesn't fit. A small dev-only endpoint
   `POST /api/dev/payments/webhook-replay` re-signs and re-posts a
   captured/failed/refund payload to the **real**
   `/api/payments/webhook` route. Same hard gate
   (`NODE_ENV !== 'production'` AND `ENABLE_DEV_PAYMENT_SIMULATION`).
   This validates idempotency, replay handling, and `webhook_events`
   semantics without Razorpay.

### Lifecycle validation matrix (against the `dev` provider)

| # | Scenario | Expected DB outcome |
|---|----------|---------------------|
| **A** | Single buyer, single listing, complete checkout | `listings.status='sold'`, `listings.sold_order_id` set; `orders.status='escrow_held'`; `payments.status='captured'`; one `order_events` row |
| **B** | Buyer abandons checkout (closes tab between create and verify) | `orders.status='payment_pending'`; `checkout_locks` row exists, expires after TTL; listing remains `approved` (Decision 6) |
| **C** | Two buyers race for same listing — concurrent `/create` calls, then `/verify` for both | Exactly one winner reaches `escrow_held`; loser's `payments.refund_status='processing'`; loser's `orders.status='cancelled'`; one `order_events` row per transition; zero ownership corruption |
| **D** | Webhook replay — same `payment.captured` payload re-posted via `/api/dev/payments/webhook-replay` | First call processes; second returns `{replay: true}`; `webhook_events` shows exactly one row with `status='processed'` |
| **E** | Payment failure path — synthesise a `payment.failed` event via the dev webhook replay | `orders.status='payment_failed'` (recoverable); listing untouched; buyer can re-enter `/buy/checkout/[listingId]` and retry |

Scenario C is the most important runtime test in the platform. Phase
1 proved it in pure SQL at concurrency=100 (CI green); the synthetic
path re-proves it across the full HTTP/route/RPC/DB stack the buyer
actually traverses.

### Future — real Razorpay validation (when credentials land)

Once Razorpay test/production credentials are available, set
`PAYMENT_PROVIDER=razorpay` and re-run scenarios A–E against real
test-mode transactions. Same database assertions, same audit
assertions; the only thing that changes is which provider is loaded.

| Check | Expected behaviour |
|-------|-------------------|
| **Payment creation** | `POST /api/payments/create` returns `{ razorpay_order_id, razorpay_key_id, amount, currency, order_id }`. Order at `payment_pending`. Payment at `created`. Lock acquired. |
| **Razorpay modal opens** | `window.Razorpay` loads via `next/script`. Test card `4111 1111 1111 1111` completes successfully. |
| **Verify route** | Signature verifies, `finalize_winning_payment` runs, browser redirects. |
| **Webhook idempotency** | Razorpay's `payment.captured` lands within ~5s; handler returns `noop` (already captured). Replay returns `{replay: true}`. |
| **Failure card** | Razorpay's failure-simulation card → `payments.status='failed'`, `orders.status='payment_failed'`, listing untouched. |
| **Lock contention** | Two tabs hit `/create` for same listing back-to-back: first wins, second returns 409 CHECKOUT_BUSY. Re-attempt succeeds after 5-min TTL. |

---

## NEXT BRANCH EXPECTED TO RECEIVE WORK

`feature/checkout-razorpay-wire` — until PR #4 merges. After merge,
post-validation work continues on a fresh branch off `dev`.

---

## DO NOT START YET

Reason: marketplace lifecycle validation has not been completed
end-to-end yet, even with the synthetic-payment path. Until that
succeeds, the following work is premature and risks rebuilding on
an unverified foundation:

- **AI features** — recommendations, dispute analysis, fraud detection, anything ML-driven
- **Merchant gamification** — V2 distributed verifier scope; not V1
- **Reputation systems** — beyond the `seller_score` / `buyer_score` columns already in schema
- **Recommendation systems** — homepage personalisation, "similar listings", anything algorithmic
- **Dynamic pricing** — auto-adjust asking price, surge pricing, market-rate tracking
- **Seller leaderboards** — top-sellers, badges, public rankings
- **Escrow staking concepts** — anything that holds seller capital before a sale
- **Advanced dispute automation** — auto-resolve based on evidence patterns, ML-graded outcomes
- **Payout automation** — Razorpay Route / Razorpay Payouts API. V1 is manual UPI by admin
- **Real Razorpay integration work** — gated on credential availability, not on engineering capacity. The synthetic-payment path covers everything except the outbound HTTP call until credentials land.
- **Real Shiprocket integration work** — gated on credential availability. The `ShippingProvider` abstraction with `MockShippingProvider` covers all surrounding work.

If a stakeholder asks for one of these before V1 launches, the answer
is "after launch, not before." Launch first; optimise after data.

---

## Order of work — launch-critical sequence

### Step 1 — Merge PR #4

CheckoutForm + mock removal. Awaiting review.

### Step 2 — Verify CheckoutForm against the credential-less state

Before adding any abstraction, observe what the buyer sees today on
`dev.audiobaaz.com` when `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`
are absent:

- Click "Pay" on `/buy/checkout/[listingId]` and watch:
  - `POST /api/payments/create` response (status, body)
  - browser-side error path in CheckoutForm
  - whether an `orders` row exists at `payment_pending`
  - whether a `checkout_locks` row was acquired and what its TTL is
  - whether the form recovers or strands the buyer
- Document the findings on the branch that introduces the abstraction.
  These observations shape what the abstraction has to absorb.

### Step 3 — Update context files post-merge

Re-sync `CLAUDE.md`, `docs/V1-LAUNCH.md`, and the four `docs/context/*`
files to reflect the new `dev` tip after PR #4 lands. Same pattern as
the post-PR-#3 sync.

### Step 4 — Introduce the `PaymentProvider` abstraction

```ts
// src/lib/payments/provider.ts
export interface PaymentProvider {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>;
}
```

Two implementations:
- `RazorpayPaymentProvider` — refactor of the existing
  `src/lib/razorpay/{client,helpers}.ts`. The route handlers
  (`/api/payments/{create,verify}`) call the provider, not the
  Razorpay client directly. No behaviour change versus PR #3.
- `DevPaymentProvider` — selected when `PAYMENT_PROVIDER=dev`
  (gated additionally by `NODE_ENV !== 'production'`). `createOrder`
  returns `{ razorpay_order_id: 'dev_order_<uuid>', ... }` synchronously.
  `verifyPayment` returns a `{ payment_id, signature }` pair signed
  with the dev key secret so the existing signature-verification
  helper accepts it without modification.

Provider selection happens in a tiny factory:
`getPaymentProvider()` reads `process.env.PAYMENT_PROVIDER` and
returns the appropriate instance. Routes never branch on `NODE_ENV`.

Webhook simulation lives separately: `POST /api/dev/payments/webhook-replay`
re-signs and re-posts a captured/failed/refund payload to the
**real** `/api/payments/webhook`, gated by
`NODE_ENV !== 'production'` AND `ENABLE_DEV_PAYMENT_SIMULATION`.

### Step 5 — Run lifecycle scenarios A–E

Per the matrix in "NEXT ENGINEERING TASK". Run them with
`PAYMENT_PROVIDER=dev` on `dev.audiobaaz.com`. Document outcomes.
Scenario C is the most important runtime assertion; if it does not
produce exactly one winner and exactly one initiated refund, that is
the next bug.

### Step 6 — Build buyer + seller order timeline UI

Driven by `orders.status` + `order_events`. Needs no Razorpay and no
Shiprocket — both data sources are populated by Step 5.

```
Order Created → Payment Captured → Escrow Held → Seller Shipped
   → Delivered → Inspection Window → Escrow Released
```

Without a timeline, debugging means digging through Supabase tables
constantly. Build it before shipping work begins.

The order detail pages (`/orders/purchase/[orderId]` for buyers,
seller dashboard order detail for sellers) already render some of
this; verify post-Razorpay states render correctly and add any
missing copy.

### Step 7 — Build the `ShippingProvider` abstraction + `MockShippingProvider`

Same pattern as `PaymentProvider`. Lack of Shiprocket credentials is
**not** blocking development.

```ts
// src/lib/shipping/provider.ts
export interface ShippingProvider {
  createShipment(input: CreateShipmentInput): Promise<ShipmentRecord>;
  getTracking(awb: string): Promise<TrackingSnapshot>;
}
```

- `MockShippingProvider` returns synthesised AWBs (`TEST123456`,
  courier=`Manual`, status=`created`) and advances tracking states
  via a dev-only endpoint.
- All caller code uses the interface, never a concrete provider.
- `ShiprocketProvider` is added later as a provider swap once
  credentials land. No caller-side code changes when it does.

### Step 8 — Build seller shipment flow on top of the mock provider

Seller dashboard order detail gains a "Create shipment" button that
calls the shipping provider. Updates `orders.status` to
`seller_confirmed → shipped`. Stores `tracking_number`,
`courier_name`, `shiprocket_order_id`, `shiprocket_shipment_id`
(populated from the mock until Shiprocket lands). Telegrams the
buyer with tracking info.

### Step 9 — Build admin operations on the validated lifecycle

- Wire admin dispute resolution to call `initiate_refund(...)` on
  buyer-favourable verdicts (`full_refund` / `partial_refund`).
- Admin payouts page: real UPI reference text input at trigger time.
  Route writes `payout_reference`, `payout_at`,
  `payout_status='paid'`. Telegram the seller.

### Step 10 — Real Razorpay (when credentials arrive)

Configure on Vercel (`dev` + `production`):
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `PAYMENT_PROVIDER=razorpay`

Razorpay dashboard:
- Webhook URL → `https://dev.audiobaaz.com/api/payments/webhook` (then production)
- Events: `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`

Re-run scenarios A–E against real test-mode transactions. Same DB
assertions, same audit assertions. Only the active provider changes.

### Step 11 — Real Shiprocket (when credentials arrive)

Build `ShiprocketProvider` as the concrete implementation behind the
existing interface. No changes to the seller shipment flow, the
order timeline, the buyer tracking page, or notifications. The
audit's §5.9 keep-list (`src/lib/shiprocket/{client,helpers}.ts`)
becomes the body of `ShiprocketProvider`.

### Step 12 — Closed beta

Once Steps 1–11 have shipped, run a small invite-only beta with
5–10 real listings + 5–10 real buyers. Watch the audit tables. Fix
anything that surfaces. Then open V1 launch.

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
