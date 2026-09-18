# System Design Notes - Webhook Retry Engine

## Why this one

Looked at the scorecard weights: architecture 25%, failure handling 15%. That's 40% of the score in two areas this problem is basically built around (explicit states, retry classification, crash recovery), so went with problem 2.

## Data model (SQLite, 2 tables)

events
- id
- event_id (caller supplied, UNIQUE)
- type
- occurred_at
- payload (json text)
- status: pending -> delivering -> succeeded | failed
- attempt_count
- next_attempt_at
- created_at, updated_at

attempts
- id
- event_row_id (fk)
- attempt_number
- attempted_at
- outcome: success | failure
- status_code
- error
- retryable (0/1)

## Components

1. Ingestion (POST /events) - zod validation, insert with a UNIQUE constraint on event_id. Duplicate submission hits the conflict, returns the existing row, no second job created. This is atomic at the db level, no check-then-insert race in app code.
2. Scheduler - processDueEvents(), a plain function that grabs everything pending and due, claims it (flips to delivering) inside a transaction. Server runs this on a setInterval. Tests call it directly, no real sleeping.
3. Delivery worker - actually does the fetch, sends an X-Event-Id header so the receiver has something to dedupe on, classifies the result, writes an attempt row, updates next state.
4. Retry policy - pure function, no I/O. retryable: network error, timeout, 5xx, 429. terminal: any other 4xx or 3xx. Exponential backoff, capped, bounded attempts.
5. Read API - GET /events, GET /events/:eventId.
6. Test receiver - small express app, can be told to always succeed, always fail, or fail N times then succeed. Used for both the demo and the tests.

## State machine

pending -> delivering -> succeeded
pending -> delivering -> pending (retryable failure, scheduled later)
pending -> delivering -> failed (terminal, or ran out of retries)

## Crash recovery

If a row is stuck on delivering when the server starts up, that means the process died mid attempt last time. Can't know if the http call actually landed or not, so it goes back to pending and gets retried. Documented as at-least-once rather than pretending it's exactly-once.

## Success / retry policy

- 2xx = success, done.
- 5xx, 429, network error, timeout = retryable, gets scheduled again.
- any other 4xx, or 3xx = terminal, no retry, this request isn't going to succeed no matter how many times we send it.
- max attempts and base backoff are both env vars so tests/demo can run fast instead of waiting real minutes.

## Requirement checklist (went through the brief line by line)

| Requirement | How it's handled |
|---|---|
| Accept + retain before/during scheduling | row inserted before scheduling happens |
| Deliver to one configurable endpoint | WEBHOOK_URL env |
| Record each attempt (time, number, outcome) | attempts table |
| Documented success policy | 2xx = success |
| Bounded retry policy | max attempts + capped backoff |
| Expose state + history via API | GET /events, GET /events/:eventId |
| Idempotent re-ingestion (AC4) | UNIQUE on event_id, returns existing row |
| AC1 successful delivery | done |
| AC2 temp failure + retry | done |
| AC3 bounded failure | done, terminal failed state |
| AC5 inspectable ordered history | done |
| retryable classification (must document) | listed above |
| retry limit/backoff (must document) | listed above |
| delivery guarantee (must document) | at-least-once |
| concurrent duplicate handling (must document) | db unique constraint |
| what's retained per attempt (must document) | time, attempt#, status, error, retryable flag |
| tests can't depend on sleep timing | processDueEvents() called directly in tests |
| receiver dedupe guidance (must document) | X-Event-Id header on every delivery |
| separation: ingestion/scheduling/delivery/storage | 4 separate modules |
| survives process failure | recovery of stuck delivering rows on startup |

## Deliberately not building

Auth, multi-tenancy, management dashboard, multiple subscriber endpoints, distributed queue, load testing, billing/quotas, secrets management. Request signing/manual replay/endpoint health checks are called out as optional in the brief, skipped them to spend the time on the required behavior instead.

## Questions the brief wants answered in SUBMISSION.md

- What could still cause a receiver to observe a duplicate delivery? We time out waiting for a response after the receiver already processed it, our retry lands again.
- How would you operate this with many workers? Move claiming to Postgres with SELECT FOR UPDATE SKIP LOCKED instead of single-process sqlite polling.
- How would you prevent one failing endpoint from consuming all capacity? Per-endpoint concurrency cap / circuit breaker. Only one endpoint exists in this exercise so this is a forward looking answer.
- What metrics/alerts in production? delivery success rate, attempts-to-success distribution, terminal failure rate, oldest pending age.
