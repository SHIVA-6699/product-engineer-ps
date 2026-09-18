// All the retry/backoff logic lives here as plain functions, no I/O.
// Easy to unit test without spinning up a db or a server.

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

// 2xx = success, nothing else counts
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

// 5xx and 429 get retried (server having a bad day / asking us to slow down).
// Everything else 4xx is terminal - the request is bad, retrying it won't help.
// 3xx also terminal, we're not going to follow redirects here.
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

// doubles every attempt, capped at maxDelayMs
export function computeBackoffMs(attemptNumber: number, config: RetryConfig): number {
  const exp = config.baseDelayMs * Math.pow(2, attemptNumber - 1);
  return Math.min(exp, config.maxDelayMs);
}

export type AttemptOutcomeInput =
  | { kind: 'response'; status: number }
  | { kind: 'network_error'; message: string };

export interface DeliveryDecision {
  outcome: 'success' | 'failure';
  retryable: boolean;
  nextStatus: 'succeeded' | 'pending' | 'failed';
  nextAttemptAt: string | null;
}

// figures out what happens next after one attempt - succeed, retry later, or give up
export function decideDelivery(
  input: AttemptOutcomeInput,
  attemptNumber: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  now: Date = new Date(),
): DeliveryDecision {
  if (input.kind === 'response' && isSuccessStatus(input.status)) {
    return { outcome: 'success', retryable: false, nextStatus: 'succeeded', nextAttemptAt: null };
  }

  const retryable = input.kind === 'network_error' ? true : isRetryableStatus(input.status);

  if (!retryable) {
    return { outcome: 'failure', retryable: false, nextStatus: 'failed', nextAttemptAt: null };
  }

  if (attemptNumber >= config.maxAttempts) {
    return { outcome: 'failure', retryable: true, nextStatus: 'failed', nextAttemptAt: null };
  }

  const delayMs = computeBackoffMs(attemptNumber, config);
  const nextAttemptAt = new Date(now.getTime() + delayMs).toISOString();
  return { outcome: 'failure', retryable: true, nextStatus: 'pending', nextAttemptAt };
}

export function loadRetryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RetryConfig {
  return {
    maxAttempts: Number(env.RETRY_MAX_ATTEMPTS ?? DEFAULT_RETRY_CONFIG.maxAttempts),
    baseDelayMs: Number(env.RETRY_BASE_DELAY_MS ?? DEFAULT_RETRY_CONFIG.baseDelayMs),
    maxDelayMs: Number(env.RETRY_MAX_DELAY_MS ?? DEFAULT_RETRY_CONFIG.maxDelayMs),
  };
}
