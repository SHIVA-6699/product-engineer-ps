import { describe, it, expect } from 'vitest';
import { computeBackoffMs, decideDelivery, isRetryableStatus, isSuccessStatus } from '../src/delivery/retryPolicy.js';

const config = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

describe('isSuccessStatus / isRetryableStatus', () => {
  it('treats 2xx as success', () => {
    expect(isSuccessStatus(200)).toBe(true);
    expect(isSuccessStatus(299)).toBe(true);
    expect(isSuccessStatus(300)).toBe(false);
  });

  it('treats 5xx and 429 as retryable, other 4xx as terminal', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('doubles each attempt and caps at maxDelayMs', () => {
    expect(computeBackoffMs(1, config)).toBe(100);
    expect(computeBackoffMs(2, config)).toBe(200);
    expect(computeBackoffMs(3, config)).toBe(400);
    expect(computeBackoffMs(10, config)).toBe(1000); // capped
  });
});

describe('decideDelivery', () => {
  it('success path: 2xx response terminates as succeeded', () => {
    const decision = decideDelivery({ kind: 'response', status: 200 }, 1, config);
    expect(decision).toEqual({ outcome: 'success', retryable: false, nextStatus: 'succeeded', nextAttemptAt: null });
  });

  it('retryable failure schedules the next attempt while under the limit', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const decision = decideDelivery({ kind: 'response', status: 503 }, 1, config, now);
    expect(decision.outcome).toBe('failure');
    expect(decision.retryable).toBe(true);
    expect(decision.nextStatus).toBe('pending');
    expect(decision.nextAttemptAt).toBe('2026-01-01T00:00:00.100Z');
  });

  it('terminal (non-retryable) failure never schedules a retry, even on attempt 1', () => {
    const decision = decideDelivery({ kind: 'response', status: 400 }, 1, config);
    expect(decision).toEqual({ outcome: 'failure', retryable: false, nextStatus: 'failed', nextAttemptAt: null });
  });

  it('a retryable failure at the attempt limit becomes terminal failed, not another retry', () => {
    const decision = decideDelivery({ kind: 'response', status: 500 }, config.maxAttempts, config);
    expect(decision.nextStatus).toBe('failed');
    expect(decision.nextAttemptAt).toBeNull();
  });

  it('network errors are always retryable', () => {
    const decision = decideDelivery({ kind: 'network_error', message: 'ECONNREFUSED' }, 1, config);
    expect(decision.retryable).toBe(true);
    expect(decision.nextStatus).toBe('pending');
  });
});
