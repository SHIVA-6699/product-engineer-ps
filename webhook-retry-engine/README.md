# Webhook Retry Engine

Small backend service that takes an event, delivers it to a configured webhook endpoint, retries temporary failures with a bounded exponential backoff, keeps a full attempt history, and handles repeated submissions of the same eventId without creating duplicate jobs.

Built for the Caygnus Product Engineering Challenge, Problem 2. DESIGN.md has the full design and requirement checklist, SUBMISSION.md has the actual write-up for the challenge.

## Requirements

Node.js 22.5 or newer. Uses the built-in `node:sqlite` module so there's no native build step and no external database to set up.

## Setup

```bash
npm install
```

No env vars needed to run the default demo, everything has a working default.

## Running it (two terminals)

Terminal 1, the test webhook receiver (a controllable stand-in for a real external system):

```bash
npm run receiver
```

Starts on http://localhost:4100. Returns success by default. Control it live:

```bash
# always fail (for the exhaustion scenario)
curl -X POST http://localhost:4100/mode -H "content-type: application/json" -d '{"mode":"fail"}'

# fail twice then succeed (for the retry-then-success scenario)
curl -X POST http://localhost:4100/mode -H "content-type: application/json" -d '{"mode":"flaky","flakyFailCount":2}'

# back to always succeeding
curl -X POST http://localhost:4100/mode -H "content-type: application/json" -d '{"mode":"success"}'

# see everything it's received
curl http://localhost:4100/received
```

Terminal 2, the retry engine:

```bash
npm run dev
```

Starts on http://localhost:4000, delivers to http://localhost:4100/webhook by default, checks for due deliveries every 500ms.

## Trying the scenarios

Easiest way: with both terminals from above still running, open a third terminal and run

```bash
npm run demo
```

It walks through all four required scenarios in order (success, retry-then-success, exhaustion, idempotent resubmission), printing a labeled result after each one. Takes about 20 seconds.

Or do it by hand with curl if you want to poke around yourself:

Submit an event:

```bash
curl -X POST http://localhost:4000/events \
  -H "content-type: application/json" \
  -d '{"eventId":"evt_1","type":"incident.created","occurredAt":"2026-09-15T10:00:00Z","payload":{"incidentId":"inc_1","severity":"high"}}'
```

Check its state and attempt history:

```bash
curl http://localhost:4000/events/evt_1
```

List everything:

```bash
curl http://localhost:4000/events
```

Successful delivery (AC1): receiver on default success mode, submit an event, it becomes succeeded with one attempt within one scheduler tick.

Temporary failure then retry (AC2): set the receiver to flaky mode, submit a new event, poll GET /events/:eventId, you'll see the failed attempts followed by a successful one.

Bounded failure (AC3): set the receiver to fail mode, submit a new event, wait. After 5 attempts (default RETRY_MAX_ATTEMPTS) it stops and shows status failed. It won't try again after that.

Idempotent ingestion (AC4): submit the same eventId again, even with a different payload. You get the original event back, status 200 not 201, attempt history doesn't grow a second job's worth.

Crash recovery: hitting the exact moment a real crash happens mid-delivery is timing-dependent, so there's a script that forces it deterministically instead of hoping a manual ctrl+c lines up. Stop the server, run `npm run simulate-crash` (it directly marks a fresh event as stuck in 'delivering', simulating the process having died right after claiming it), then run `npm run dev` again. The startup log prints how many events it recovered back to pending, every time. (You can still do it the manual way too, stop the server for real while an event happens to be mid-delivery and restart it, but the script is the reliable way to see it.)

## Configuration

All optional, defaults shown:

| Env var | Default | What it does |
|---|---|---|
| PORT | 4000 | http port for the retry engine |
| DB_PATH | ./data.sqlite | sqlite file path |
| WEBHOOK_URL | http://localhost:4100/webhook | where events get delivered |
| SCHEDULER_INTERVAL_MS | 500 | how often it checks for due deliveries |
| RETRY_MAX_ATTEMPTS | 5 | max attempts before marking an event permanently failed |
| RETRY_BASE_DELAY_MS | 500 | base backoff delay, doubles each attempt |
| RETRY_MAX_DELAY_MS | 30000 | backoff cap |
| RECEIVER_PORT | 4100 | port for the test receiver |
| MODE | success | test receiver's starting mode, success/fail/flaky |
| FLAKY_FAIL_COUNT | 2 | in flaky mode, how many times a given eventId fails before it succeeds |

## Tests

```bash
npm test
```

19 tests across 4 files. pure retry-policy logic, delivery/retry/exhaustion against an in-memory db with a fake http transport (no real network calls, no real waiting), the ingestion api over real http, crash recovery. none of them depend on a paid service or real sleep timing.
