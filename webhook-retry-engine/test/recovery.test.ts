import { describe, it, expect } from 'vitest';
import { claimDueEvents, createDb, getEventByEventId, insertEventIdempotent, recoverStuckDeliveries } from '../src/db.js';

describe('crash recovery', () => {
  it('an event stuck in "delivering" (process died mid-attempt) is put back to pending on startup, not lost', () => {
    const db = createDb(':memory:');
    insertEventIdempotent(db, {
      eventId: 'evt_crash',
      type: 'incident.created',
      occurredAt: '2026-09-15T10:00:00Z',
      payloadJson: '{}',
    });

    // Simulate the process dying mid-delivery: the event was claimed
    // ('delivering') but the worker never got to record an outcome.
    claimDueEvents(db, 10);
    expect(getEventByEventId(db, 'evt_crash')!.status).toBe('delivering');

    const recovered = recoverStuckDeliveries(db);
    expect(recovered).toBe(1);

    const row = getEventByEventId(db, 'evt_crash')!;
    expect(row.status).toBe('pending');
    expect(row.next_attempt_at).not.toBeNull();
  });

  it('does not touch events that are already pending, succeeded, or failed', () => {
    const db = createDb(':memory:');
    insertEventIdempotent(db, {
      eventId: 'evt_untouched',
      type: 'incident.created',
      occurredAt: '2026-09-15T10:00:00Z',
      payloadJson: '{}',
    });

    const recovered = recoverStuckDeliveries(db);
    expect(recovered).toBe(0);
    expect(getEventByEventId(db, 'evt_untouched')!.status).toBe('pending');
  });
});
