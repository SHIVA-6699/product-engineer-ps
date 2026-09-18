import express, { type Express } from 'express';
import { z } from 'zod';
import type { Db } from './db.js';
import { getAttemptsForEvent, getEventByEventId, insertEventIdempotent, listEvents } from './db.js';
import type { AttemptRow, EventRow, EventView } from './types.js';

const IncomingEventSchema = z.object({
  eventId: z.string().min(1),
  type: z.string().min(1),
  occurredAt: z.string().min(1),
  payload: z.unknown(),
});

function toEventView(row: EventRow, attempts?: AttemptRow[]): EventView {
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload),
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(attempts
      ? {
          attempts: attempts.map((a) => ({
            attemptNumber: a.attempt_number,
            attemptedAt: a.attempted_at,
            outcome: a.outcome,
            statusCode: a.status_code,
            error: a.error,
            retryable: a.retryable === 1,
          })),
        }
      : {}),
  };
}

// separate from server.ts on purpose so tests can spin this up against an
// in-memory db without actually starting a server / scheduler / anything
export function createApp(db: Db): Express {
  const app = express();
  app.use(express.json());

  app.post('/events', (req, res) => {
    const parsed = IncomingEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid event', details: parsed.error.flatten() });
    }
    const input = parsed.data;
    const { row, created } = insertEventIdempotent(db, {
      eventId: input.eventId,
      type: input.type,
      occurredAt: input.occurredAt,
      payloadJson: JSON.stringify(input.payload ?? null),
    });
    // 201 for new, 200 if we already had this eventId - no second job gets created
    res.status(created ? 201 : 200).json(toEventView(row));
  });

  app.get('/events', (_req, res) => {
    res.json(listEvents(db).map((row) => toEventView(row)));
  });

  app.get('/events/:eventId', (req, res) => {
    const row = getEventByEventId(db, req.params.eventId);
    if (!row) return res.status(404).json({ error: 'not found' });
    const attempts = getAttemptsForEvent(db, row.id);
    res.json(toEventView(row, attempts));
  });

  // catches bad JSON bodies - without this express just dumps a stack trace
  // html page back to the caller, found that while poking at it manually
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: 'invalid request body' });
  });

  return app;
}
