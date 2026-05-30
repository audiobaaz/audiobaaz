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

## NEXT ENGINEERING TASK — Checkout failure investigation (observe before architect)

Real Razorpay credentials are not in our control today. **Before
designing any abstraction or simulation layer**, observe what the
existing CheckoutForm actually does when a buyer clicks "Pay" on
`dev.audiobaaz.com` against the current credential-less state.

Nobody on the project actually knows the answer right now. The
possibilities branch into very different engineering problems:

- `/api/payments/create` fails immediately with a clean 500 + a
  useful body — the buyer sees a helpful error, no DB writes happen.
- A `payment_pending` order row is created *before* the Razorpay
  call fails, leaving an orphan in the table.
- A `checkout_locks` row is acquired and never released, blocking
  re-attempts until TTL expires.
- The UI hangs on a silent spinner.
- The UI shows an unhelpful error and strands the buyer.
- The route crashes (uncaught exception) because `RAZORPAY_KEY_ID`
  is missing.

Each of those needs a different fix. Building a `PaymentProvider`
abstraction before knowing which one exists is premature.

### The investigation (target: under one hour)

Branch off `dev` after PR #4 merges:

```
feature/payment-validation
```

Goal: **observe, document, decide**. Do not architect. Do not
abstract. Do not optimise. Do not refactor. Just run the flow and
write down what happens.

Run a real buyer journey on `dev.audiobaaz.com` and capture:

| Surface | What to record |
|---------|----------------|
| **API response** | `/api/payments/create` status code, response body, headers |
| **Browser console** | Errors, warnings, unhandled promise rejections |
| **Network tab** | Full request/response chain — does Razorpay's `checkout.js` even get a chance to load? |
| **CheckoutForm UI** | What does the buyer actually see — error message, hung spinner, redirect, blank page? |
| **`orders` table** | Did a `payment_pending` row get inserted? With what `id`? Does it stay forever? |
| **`payments` table** | Did a `created` row get inserted? Tied to the order? |
| **`checkout_locks` table** | Was a lock acquired? When does it expire? Does re-attempting from the same buyer succeed or 409? |
| **`order_events` table** | Any rows? Any silent failures upstream of the Razorpay call? |
| **Server logs** | Vercel logs for the failed request — full stack trace |

Deliverable: a short markdown report (e.g.
`docs/reviews/checkout-failure-investigation.md`) listing exactly
what was observed and exactly which of the six branches above
matches reality.

### Decision tree (what comes next is gated on the report)

The next engineering task is determined by the investigation, not
chosen ahead of it. Three plausible outcomes:

**Outcome A — Failure is clean and contained.**
`/api/payments/create` fails fast with a useful error, no orphan
DB rows, no leaked locks, helpful UI message. In this case a
**very small** dev path is probably enough — for example, a feature
flag inside the existing `src/lib/razorpay/client.ts` that returns
a synthetic order when `ENABLE_DEV_PAYMENT_SIMULATION=true` and
`NODE_ENV !== 'production'`. No `PaymentProvider` interface, no
factory, no refactor of merged code. Lifecycle scenarios A–E
follow.

**Outcome B — Failure leaves DB state behind.**
Orphan orders, leaked locks, silent failures upstream of the
Razorpay call. In this case the first task is fixing the
error-handling in the existing routes (rollback on failure, emit
`order_events` on failure paths, release the lock on error
exit). Only after the routes are well-behaved does the dev path
get added.

**Outcome C — Failure is severe enough that simulation is
unhelpful.** The route crashes before the buyer can complete any
meaningful flow. In that case the priority shifts to acquiring
real Razorpay test credentials sooner — investing in simulation
buys nothing if the simulator can't get past the same crash point.

Whichever path the report points to, it will be more grounded than
designing the abstraction in advance.

### What is NOT being decided yet

- Whether `PaymentProvider` is the right abstraction. It might be.
  It might not. Right now there is exactly one provider in the
  codebase (Razorpay) and the only reason for a second is missing
  credentials. A simpler env-flag path inside the existing
  implementation may turn out to be enough.
- Whether `/api/dev/payments/webhook-replay` is needed.
  Webhook-replay validation matters, but only after the create +
  verify path is observably correct. Don't build it until that
  gate is passed.
- The shape of the lifecycle test harness. Scenarios A–E are
  recorded above as the *target* of validation; the *mechanism*
  that drives them depends on the investigation outcome.

### Lifecycle validation matrix (target — mechanism TBD post-investigation)

These are the runtime assertions the marketplace must prove,
regardless of which simulation/abstraction path the investigation
points to.

| # | Scenario | Expected DB outcome |
|---|----------|---------------------|
| **A** | Single buyer, single listing, complete checkout | `listings.status='sold'`, `listings.sold_order_id` set; `orders.status='escrow_held'`; `payments.status='captured'`; one `order_events` row |
| **B** | Buyer abandons checkout (closes tab between create and verify) | `orders.status='payment_pending'`; `checkout_locks` row exists, expires after TTL; listing remains `approved` (Decision 6) |
| **C** | Two buyers race for same listing — concurrent `/create` calls, then `/verify` for both | Exactly one winner reaches `escrow_held`; loser's `payments.refund_status='processing'`; loser's `orders.status='cancelled'`; one `order_events` row per transition; zero ownership corruption |
| **D** | Webhook replay — same `payment.captured` payload re-posted | First call processes; second returns `{replay: true}`; `webhook_events` shows exactly one row with `status='processed'` |
| **E** | Payment failure path — synthesise a `payment.failed` event | `orders.status='payment_failed'` (recoverable); listing untouched; buyer can re-enter `/buy/checkout/[listingId]` and retry |

Scenario C is the most important runtime test in the platform. Phase
1 proved it in pure SQL at concurrency=100 (CI green); the runtime
path re-proves it across the full HTTP/route/RPC/DB stack the buyer
actually traverses.

### Future — real Razorpay validation (when credentials land)

Once Razorpay test/production credentials are available, re-run
scenarios A–E against real test-mode transactions. Same database
assertions, same audit assertions; the only thing that changes is
whether the captured-payment event came from Razorpay or a synthetic
source.

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

### Step 2 — Checkout failure investigation (target: under 1h)

Branch off `dev` after Step 1 lands:

```
feature/payment-validation
```

Goal: **observe, document, decide**. No code changes. Run a real
buyer journey on `dev.audiobaaz.com` and capture the eight surfaces
listed in "NEXT ENGINEERING TASK" above.

Deliverable:
`docs/reviews/checkout-failure-investigation.md` — a short report
that names exactly which of the six failure modes matches reality
and recommends one of Outcomes A / B / C below.

Anything beyond Step 2 is gated on what this report says. The cost
of being wrong about Step 3 is days of building abstractions around
assumptions; the cost of running Step 2 is roughly an hour.

### Step 3 — Update context files post-merge

Re-sync `CLAUDE.md`, `docs/V1-LAUNCH.md`, and the four
`docs/context/*` files to reflect the new `dev` tip after PR #4
merges. This is a doc-only step that runs in parallel with Step 2.

### Step 4 — Decide based on the investigation

Three plausible branches; the report points at exactly one.

**Outcome A — Failure is clean and contained.** Add a small env-flag
short-circuit inside `src/lib/razorpay/client.ts`:
`ENABLE_DEV_PAYMENT_SIMULATION=true` (and `NODE_ENV !== 'production'`)
makes `createOrder` and `verifyPayment` return synthetic results
without an outbound HTTP call. **No `PaymentProvider` interface, no
factory, no refactor of merged code.** Lifecycle scenarios A–E follow
in Step 5.

**Outcome B — Failure leaves DB state behind.** Fix the error-handling
in the existing routes first: rollback partial inserts on Razorpay
failure, release the checkout lock on error exit, emit `order_events`
on failure paths. Then add the env-flag short-circuit per Outcome A.
Then run the lifecycle scenarios.

**Outcome C — Failure is severe (uncaught crash, route-level fault).**
Simulation buys nothing if it can't get past the same crash point.
Pivot the plan: prioritise acquiring real Razorpay test credentials
sooner. Continue building unrelated work (order timeline UI,
`ShippingProvider` abstraction, mock shipping) while credentials
are obtained.

The `PaymentProvider` interface is **not** the default outcome — it
becomes the right shape only if the codebase grows a second
non-Razorpay provider (e.g. a different gateway in V2). For now,
"single env-flag short-circuit inside the Razorpay client" is the
working assumption unless the report says otherwise.

### Step 5 — Run lifecycle scenarios A–E

Per the matrix in "NEXT ENGINEERING TASK". Run them on
`dev.audiobaaz.com` against whichever simulation/credential setup
came out of Step 4. Document outcomes. Scenario C is the most
important runtime assertion; if it does not produce exactly one
winner and exactly one initiated refund, that is the next bug.

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

The shipping abstraction case is stronger than the payment case
because there are **two known providers in the V1 plan**: the mock
that lets us build the seller flow today, and `ShiprocketProvider`
when credentials land. The interface is justified by concrete need,
not anticipation.

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
- Unset (or leave false) `ENABLE_DEV_PAYMENT_SIMULATION`

Razorpay dashboard:
- Webhook URL → `https://dev.audiobaaz.com/api/payments/webhook` (then production)
- Events: `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`

Re-run scenarios A–E against real test-mode transactions. Same DB
assertions, same audit assertions.

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
