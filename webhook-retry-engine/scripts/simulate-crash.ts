// Run this ONLY while the server (npm run dev) is stopped, since it opens
// the same sqlite file directly. Inserts an event and manually flips it to
// 'delivering', as if the server had claimed it and then died before
// finishing the HTTP call. Restarting the server after this should print
// the "[startup] recovered 1 event(s)..." line, on purpose, every time,
// instead of hoping the timing lines up for real.

import { createDb, insertEventIdempotent } from '../src/db.js';

const dbPath = process.env.DB_PATH ?? './data.sqlite';
const db = createDb(dbPath);

const eventId = `evt_crash_demo_${Date.now()}`;
const { row } = insertEventIdempotent(db, {
  eventId,
  type: 'incident.created',
  occurredAt: new Date().toISOString(),
  payloadJson: JSON.stringify({ note: 'simulated crash victim' }),
});

db.prepare(`UPDATE events SET status = 'delivering' WHERE id = ?`).run(row.id);

console.log(`Marked ${eventId} as stuck in 'delivering'.`);
console.log('Now run: npm run dev');
console.log('The startup log should show it being recovered back to pending.');

db.close();
