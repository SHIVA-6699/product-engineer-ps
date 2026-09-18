export type EventStatus = 'pending' | 'delivering' | 'succeeded' | 'failed';
export type AttemptOutcome = 'success' | 'failure';

export interface IncomingEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: unknown;
}

export interface EventRow {
  id: number;
  event_id: string;
  type: string;
  occurred_at: string;
  payload: string;
  status: EventStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttemptRow {
  id: number;
  event_row_id: number;
  attempt_number: number;
  attempted_at: string;
  outcome: AttemptOutcome;
  status_code: number | null;
  error: string | null;
  retryable: 0 | 1;
}

export interface EventView {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: unknown;
  status: EventStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  attempts?: AttemptView[];
}

export interface AttemptView {
  attemptNumber: number;
  attemptedAt: string;
  outcome: AttemptOutcome;
  statusCode: number | null;
  error: string | null;
  retryable: boolean;
}
