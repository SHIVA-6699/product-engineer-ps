# Product Engineering Challenge Submission

## Candidate

- Name: Pilla Veera Durga Siva Krishna
- Email: pillashivakrishna6@gmail.com
- GitHub: SHIVA-6699
- Selected problem: Problem 2, Webhook Retry Engine
- Demo video: https://www.loom.com/share/62471cec79024b01b6bc9659851faaaf

Note: I forked the repository and selected Problem 2 (Webhook Retry Engine) when that was the live version of the challenge. I noticed afterward that the upstream repository was substantially updated with a new set of problems, and problem 2 is no longer part of that new structure. This submission is built against the version of the brief that was live when I started, flagging this for transparency rather than leaving it unmentioned.

## Run the project

Needs Node 22.5+ (uses the built-in node:sqlite module, no native build tools, no external db).

```
npm install

# terminal 1
npm run receiver

# terminal 2
npm run dev
```

No env vars required for the default demo. Full command list and every configurable env var is in README.md.

To trigger the successful scenario: submit an event to POST http://localhost:4000/events while the receiver is on its default success mode, then GET /events/:eventId to see it succeeded.

To trigger the failure/recovery scenario: POST http://localhost:4100/mode with `{"mode":"flaky","flakyFailCount":2}`, submit a new event, watch GET /events/:eventId show two failed attempts then a successful one. For terminal failure, set `{"mode":"fail"}` instead and watch it stop after 5 attempts with status failed.

## Run the tests

```
npm test
```

## Architecture and data flow

Four pieces, each testable on its own:

1. Ingestion (src/app.ts, POST /events). Validates with zod, inserts into sqlite through a function that relies on a UNIQUE constraint on event_id (ON CONFLICT DO NOTHING). A duplicate submission gets back the existing row, no second job gets scheduled. Idempotency is a db constraint, not a check-then-insert in app code.
2. Scheduler (src/delivery/scheduler.ts). processDueEvents() finds every event that's pending with next_attempt_at in the past, claims it (flips to delivering) inside a transaction, hands it to the worker. Server calls this on a setInterval, tests call it directly, so nothing in the test suite waits on a real clock.
3. Delivery worker (src/delivery/worker.ts). The only place that makes an http call. Posts the event with an X-Event-Id header so the receiver has something to dedupe on, classifies the response through the retry policy, writes an attempt row, updates state.
4. Retry policy (src/delivery/retryPolicy.ts). Pure function, no I/O. Given an outcome and how many attempts happened, decides retryable vs terminal, works out the backoff delay, and enforces the attempt limit. Fully testable without a db or network.

Storage (src/db.ts) is the only thing that touches sqlite, everything else goes through it.

Flow for one event: POST /events inserts a pending row, the scheduler claims it when due (delivering), the worker posts it and writes an attempts row, the retry policy decides succeeded / back to pending with a new next_attempt_at / terminal failed.

## Technology choices

TypeScript + Express. Small and explicit, nothing to explain away, fits a 6-8 hour exercise.

node:sqlite (Node's built-in module) instead of a native sqlite driver or postgres. Honest trade-off here: better-sqlite3 is more mature but needs a native compiler toolchain, which failed outright on my machine (no Visual Studio C++ workload) and could just as easily fail the same way for the reviewer, which works against the "setup in ~10 minutes" goal. node:sqlite ships with Node itself, zero native build step, zero extra service to run, at the cost of it still being labeled experimental. For an exercise this size, removing a real setup-failure risk seemed worth it.

Zod for request validation, small and typed, readable errors without extra glue code.

No queue library, no redis, no postgres. A distributed production system is explicitly out of scope, a single sqlite file with an in-process interval loop is the simplest thing that actually shows the required state machine, retry classification, and crash recovery.

## Important decisions

1. Retryable classification is narrow on purpose, not "retry everything." 5xx, 429, network/timeout errors retry. Any other 4xx and any 3xx are terminal. Retrying a 400 or 404 forever burns attempts on a request that's never going to succeed, the policy treats "server having a bad day" differently from "this request is wrong."
2. Idempotency lives at the db constraint, not a pre-check. insertEventIdempotent relies on event_id UNIQUE + ON CONFLICT DO NOTHING, so two concurrent submissions of the same eventId resolve to exactly one row with no race window for a second request to sneak into.
3. Claiming due events happens in its own transaction, separate from actually delivering them. claimDueEvents flips pending to delivering and commits before any http call happens. A crash during the delivery attempt leaves the row in a clear delivering state that startup recovery can find and safely requeue, instead of it being ambiguous whether it was ever claimed.
4. node:sqlite gets imported through createRequire, not a static import. Vite/Vitest didn't recognize this newer Node builtin as a valid esm specifier and failed to load it in tests. createRequire makes it a plain runtime require that Node resolves itself, sidesteps the tooling gap without switching test runners.

## Decisions the brief specifically asks about

- Which responses/errors are retryable: 5xx, 429, network/connection errors including timeouts. Terminal: any other 4xx, and 3xx.
- Retry limit and backoff policy: 5 attempts by default (RETRY_MAX_ATTEMPTS), exponential backoff starting at 500ms doubling each attempt (RETRY_BASE_DELAY_MS), capped at 30s (RETRY_MAX_DELAY_MS). All three are env configurable, which is how tests run them near-instant without real sleeping.
- Delivery guarantee: at-least-once. See assumptions below.
- Concurrent duplicate submissions: a UNIQUE constraint on event_id with ON CONFLICT DO NOTHING, the database is what collapses two simultaneous identical requests to one row, not application logic.
- What's retained from an attempt: attempt number, timestamp, outcome, status code if any, error message if any, whether it was classified retryable. One row per attempt in the attempts table, queryable in order via GET /events/:eventId.

## Assumptions and limitations

Delivery is at-least-once, not exactly-once. A receiver can see the same eventId more than once, for example if we time out waiting for a response after the receiver already processed it and our retry lands again. This is documented rather than hidden, receivers should dedupe on the X-Event-Id header sent with every attempt.

Single configured endpoint, single in-process scheduler. Multiple subscriber endpoints and a distributed queue are explicitly out of scope, see production/scale below for what changes if that constraint goes away.

No request signing, manual replay endpoint, or endpoint health checks. All three are called out as optional in the brief, judged the required delivery/retry/idempotency behavior as the better use of the time.

3xx responses are treated as terminal failures, not followed as redirects. A webhook receiver returning a redirect isn't a documented success case here, following one silently felt riskier than surfacing it as a failure.

node:sqlite is still labeled experimental by Node. It worked correctly and consistently through building and testing this (Node 22-24), but wouldn't carry that exact choice into a real production deployment without checking its status at the time, see below.

## Production and scale

Move claiming to Postgres with SELECT ... FOR UPDATE SKIP LOCKED so multiple worker processes can pull from the same queue without duplicate claims. The current single-process BEGIN/claim/COMMIT pattern only works because there's exactly one process touching the sqlite file.

Per-endpoint concurrency limits or a circuit breaker so one slow or failing endpoint can't eat delivery capacity meant for every other endpoint once multiple subscribers exist (out of scope here since the brief specifies one endpoint).

Metrics and alerts: delivery success rate, attempts-to-success distribution, terminal failure rate, oldest pending event age (a rising number there usually means the scheduler or a downstream dependency is stuck).

Revisit node:sqlite's experimental status, or move to a managed Postgres instance, once this needs to run outside a single trusted machine.

Idempotency keys need a ttl/archival policy eventually, right now every event_id is remembered forever. At real volume that needs a retention policy so the table doesn't grow unbounded while still guaranteeing idempotency long enough to matter.

## AI usage

Used Claude Code as a pair-programming tool while building this: drafting the initial module structure and test cases, catching that better-sqlite3's native build was going to fail here and proposing node:sqlite instead, and helping trace and fix a Vite/Vitest module resolution issue with that built-in. Every scenario in this doc was re-checked by actually running the server and test receiver and hitting them with curl, not just trusting the automated test output. I can walk through and modify any part of this codebase.

## Credibility note

I work on Zestfindz, a live multi-seller e-commerce platform with real orders, payments, and courier integration (Delhivery for shipping, Cashfree for payments/payouts).

Problem: a seller gets a 3-item order but only has 2 items in stock, ships those 2, and the customer still gets charged the full 3-item amount because the courier collects whatever amount is printed on the shipping label at the door. On COD orders this is a real trust problem, especially on a new platform where customers already have some fear of being scammed. My team lead asked me to find a solution.

My contribution: I checked our own live Delhivery integration and tested their actual API directly, and I looked into how the big players (Flipkart/Ekart) handle this. The finding was that no courier anywhere lets you change the collectable amount once a shipment is out for delivery, that's an industry-wide constraint, not something specific to us or something Delhivery is being difficult about. So trying to "fix" it by changing the courier's behavior was a dead end. Instead I designed a workaround at the platform layer: let the courier collect the full amount as printed (since that's unavoidable), then trigger an instant refund straight to the customer's UPI id for the missing item's value the moment support is notified, using our existing Cashfree payout infrastructure rather than the slow standard bank-refund path. Customer ends up paying the correct amount either way, just through two transactions instead of one, and gets their money back in minutes instead of days.

The hard call was resisting the urge to keep pushing on "can we somehow make the courier change the amount", verifying the actual constraint with real API testing instead of assuming, and accepting that the fix belongs on our side, not theirs.

This connects directly to what's in this submission: our payment flow already relies on idempotency (a stable transaction/event id per order, so a retried or duplicate request never creates a second charge or a second payout) and on documented retry/reconciliation behavior for the logistics and payment webhooks feeding order status, which is the same category of problem this challenge asks about.

This is internal company work, no public link, happy to walk through the actual code and the live courier API responses I tested.
