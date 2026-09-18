import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db.js';
import { createDb, getAttemptsForEvent, getEventByEventId, insertEventIdempotent } from '../src/db.js';
import { processDueEvents } from '../src/delivery/scheduler.js';
import type { DeliverDeps } from '../src/delivery/worker.js';

let db: Db; // fresh in-memory db per test, no leftover file

beforeEach(() => {
  db = createDb(':memory:');
});

function seedEvent(eventId: string) {
  return insertEventIdempotent(db, {
    eventId,
    type: 'incident.created',
    occurredAt: '2026-09-15T10:00:00Z',
    payloadJson: JSON.stringify({ incidentId: 'inc_1', severity: 'high' }),
  }).row;
}

// lets a test script exactly what fetch should return on each call, no real network
function fakeFetch(script: Array<number | 'network_error'>): typeof fetch {
  let call = 0;
  return (async () => {
    const next = script[Math.min(call, script.length - 1)];
    call++;
    if (next === 'network_error') throw new Error('simulated network error');
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
}

const baseDeps = (fetchImpl: typeof fetch): DeliverDeps => ({
  webhookUrl: 'http://fake.local/webhook',
  fetchImpl,
  retryConfig: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }, // no real waiting needed in tests
});

describe('AC1: successful delivery', () => {
  it('delivers, marks succeeded, and records one successful attempt', async () => {
    seedEvent('evt_success');
    const deps = baseDeps(fakeFetch([200]));

    const processed = await processDueEvents(db, deps);
    expect(processed).toBe(1);

    const row = getEventByEventId(db, 'evt_success')!;
    expect(row.status).toBe('succeeded');
    expect(row.attempt_count).toBe(1);

    const attempts = getAttemptsForEvent(db, row.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe('success');
    expect(attempts[0].status_code).toBe(200);
  });
});

describe('AC2: temporary failure followed by a successful retry', () => {
  it('records the failed attempt, retries, and eventually succeeds', async () => {
    seedEvent('evt_flaky');
    const deps = baseDeps(fakeFetch([503, 200]));

    await processDueEvents(db, deps); // attempt 1: fails, retryable, rescheduled
    let row = getEventByEventId(db, 'evt_flaky')!;
    expect(row.status).toBe('pending');
    expect(row.attempt_count).toBe(1);

    await processDueEvents(db, deps); // attempt 2: succeeds
    row = getEventByEventId(db, 'evt_flaky')!;
    expect(row.status).toBe('succeeded');
    expect(row.attempt_count).toBe(2);

    const attempts = getAttemptsForEvent(db, row.id);
    expect(attempts.map((a) => [a.outcome, a.status_code])).toEqual([
      ['failure', 503],
      ['success', 200],
    ]);
  });
});

describe('AC3: bounded failure, attempts stop at the configured limit', () => {
  it('stops retrying once maxAttempts is reached and leaves a visible terminal state', async () => {
    seedEvent('evt_always_fails');
    const deps = baseDeps(fakeFetch([500])); // every call fails

    // maxAttempts = 3 in baseDeps, drive it past that and confirm it stops there.
    for (let i = 0; i < 5; i++) {
      await processDueEvents(db, deps);
    }

    const row = getEventByEventId(db, 'evt_always_fails')!;
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(3); // never exceeds maxAttempts

    const attempts = getAttemptsForEvent(db, row.id);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.outcome === 'failure')).toBe(true);

    // calling again shouldn't create a 4th attempt, it's already terminal.
    await processDueEvents(db, deps);
    expect(getAttemptsForEvent(db, row.id)).toHaveLength(3);
  });

  it('a non-retryable status (e.g. 400) fails immediately without using up retries', async () => {
    seedEvent('evt_bad_request');
    const deps = baseDeps(fakeFetch([400]));

    await processDueEvents(db, deps);

    const row = getEventByEventId(db, 'evt_bad_request')!;
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(1); // did not retry a request that will never succeed
  });
});

describe('AC4: idempotent ingestion', () => {
  it('a repeated eventId returns the existing event and never creates a second delivery job', async () => {
    const first = seedEvent('evt_dup');
    const second = insertEventIdempotent(db, {
      eventId: 'evt_dup',
      type: 'incident.created',
      occurredAt: '2026-09-15T10:00:00Z',
      payloadJson: JSON.stringify({ different: 'payload' }), // even a different payload
    });

    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.id);

    // Only one row exists, and delivering it produces exactly one job's worth of attempts.
    const deps = baseDeps(fakeFetch([200]));
    await processDueEvents(db, deps);
    expect(getAttemptsForEvent(db, first.id)).toHaveLength(1);
  });
});
