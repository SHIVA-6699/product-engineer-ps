// node:sqlite is loaded via require, not a static import. Vite/Vitest
// choke on the "node:sqlite" specifier since it's still experimental and
// not in their builtin list. require() just hands it to Node directly.
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { AttemptRow, EventRow, EventStatus, AttemptOutcome } from './types.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_row_id INTEGER NOT NULL REFERENCES events(id),
  attempt_number INTEGER NOT NULL,
  attempted_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status_code INTEGER,
  error TEXT,
  retryable INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_status_next ON events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_attempts_event ON attempts(event_row_id, attempt_number);
`;

export type Db = DatabaseSyncType;

// Using node:sqlite instead of better-sqlite3 - better-sqlite3 needs a
// native build step and node-gyp kept failing on my machine (no VS build
// tools installed). node:sqlite ships with Node so nobody has to install
// anything. It's still marked experimental but works fine for this.
export function createDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

const nowIso = () => new Date().toISOString();

// Insert a new event, or if this event_id already exists just return what's
// there. The UNIQUE constraint + ON CONFLICT does the dedup work - no need
// to check-then-insert in JS, which would have a race window.
export function insertEventIdempotent(
  db: Db,
  input: { eventId: string; type: string; occurredAt: string; payloadJson: string },
): { row: EventRow; created: boolean } {
  const ts = nowIso();
  const insert = db.prepare(`
    INSERT INTO events (event_id, type, occurred_at, payload, status, attempt_count, next_attempt_at, created_at, updated_at)
    VALUES (@eventId, @type, @occurredAt, @payload, 'pending', 0, @ts, @ts, @ts)
    ON CONFLICT(event_id) DO NOTHING
  `);
  const result = insert.run({
    eventId: input.eventId,
    type: input.type,
    occurredAt: input.occurredAt,
    payload: input.payloadJson,
    ts,
  });
  const row = getEventByEventId(db, input.eventId)!;
  return { row, created: Number(result.changes) > 0 };
}

export function getEventByEventId(db: Db, eventId: string): EventRow | undefined {
  return db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId) as unknown as EventRow | undefined;
}

export function listEvents(db: Db): EventRow[] {
  return db.prepare('SELECT * FROM events ORDER BY created_at DESC').all() as unknown as EventRow[];
}

export function getAttemptsForEvent(db: Db, eventRowId: number): AttemptRow[] {
  return db
    .prepare('SELECT * FROM attempts WHERE event_row_id = ? ORDER BY attempt_number ASC')
    .all(eventRowId) as unknown as AttemptRow[];
}

// Grab everything pending that's due, flip it to 'delivering' in the same
// transaction as the read. Keeps it so two calls to this can't grab the
// same row twice.
export function claimDueEvents(db: Db, limit: number): EventRow[] {
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    const due = db
      .prepare(`SELECT * FROM events WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?`)
      .all(now, limit) as unknown as EventRow[];
    if (due.length > 0) {
      const mark = db.prepare(`UPDATE events SET status = 'delivering', updated_at = ? WHERE id = ?`);
      for (const row of due) mark.run(now, row.id);
    }
    db.exec('COMMIT');
    return due.map((r) => ({ ...r, status: 'delivering' as EventStatus }));
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function recordAttempt(
  db: Db,
  args: {
    eventRowId: number;
    attemptNumber: number;
    outcome: AttemptOutcome;
    statusCode: number | null;
    error: string | null;
    retryable: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO attempts (event_row_id, attempt_number, attempted_at, outcome, status_code, error, retryable)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.eventRowId,
    args.attemptNumber,
    nowIso(),
    args.outcome,
    args.statusCode,
    args.error,
    args.retryable ? 1 : 0,
  );
}

export function finalizeAttempt(
  db: Db,
  args: { eventRowId: number; attemptCount: number; status: EventStatus; nextAttemptAt: string | null },
): void {
  db.prepare(
    `UPDATE events SET status = ?, attempt_count = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
  ).run(args.status, args.attemptCount, args.nextAttemptAt, nowIso(), args.eventRowId);
}

// If a row is stuck on 'delivering' that means the process died mid-attempt
// last time. We don't know if the request actually went through, so just
// put it back in the queue and let it retry rather than losing it.
export function recoverStuckDeliveries(db: Db): number {
  const now = nowIso();
  const result = db
    .prepare(`UPDATE events SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'delivering'`)
    .run(now, now);
  return Number(result.changes);
}
