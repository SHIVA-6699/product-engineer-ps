import type { Db } from '../db.js';
import { finalizeAttempt, recordAttempt } from '../db.js';
import { decideDelivery, type RetryConfig, DEFAULT_RETRY_CONFIG } from './retryPolicy.js';
import type { EventRow } from '../types.js';

export interface DeliverDeps {
  webhookUrl: string;
  fetchImpl?: typeof fetch; // swap in a fake for tests, no real network
  retryConfig?: RetryConfig;
}

// Posts one already-claimed event, records what happened, updates its state.
// Only place in the codebase that actually makes an HTTP call.
export async function deliverEvent(db: Db, event: EventRow, deps: DeliverDeps): Promise<void> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const retryConfig = deps.retryConfig ?? DEFAULT_RETRY_CONFIG;
  const attemptNumber = event.attempt_count + 1;

  let decision;
  try {
    const res = await fetchFn(deps.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // receiver can use this to dedupe on their end if they see the same
        // eventId twice (which can happen, see README)
        'x-event-id': event.event_id,
        'x-attempt-number': String(attemptNumber),
      },
      body: JSON.stringify({
        eventId: event.event_id,
        type: event.type,
        occurredAt: event.occurred_at,
        payload: JSON.parse(event.payload),
      }),
    });

    decision = decideDelivery({ kind: 'response', status: res.status }, attemptNumber, retryConfig);
    recordAttempt(db, {
      eventRowId: event.id,
      attemptNumber,
      outcome: decision.outcome,
      statusCode: res.status,
      error: decision.outcome === 'failure' ? `HTTP ${res.status}` : null,
      retryable: decision.retryable,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    decision = decideDelivery({ kind: 'network_error', message }, attemptNumber, retryConfig);
    recordAttempt(db, {
      eventRowId: event.id,
      attemptNumber,
      outcome: 'failure',
      statusCode: null,
      error: message,
      retryable: decision.retryable,
    });
  }

  finalizeAttempt(db, {
    eventRowId: event.id,
    attemptCount: attemptNumber,
    status: decision.nextStatus,
    nextAttemptAt: decision.nextAttemptAt,
  });
}
