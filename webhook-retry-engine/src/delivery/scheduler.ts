import type { Db } from '../db.js';
import { claimDueEvents } from '../db.js';
import { deliverEvent, type DeliverDeps } from './worker.js';

// no setTimeout/setInterval in here on purpose - server calls this on a
// timer, tests just call it directly whenever they want, no waiting around
export async function processDueEvents(db: Db, deps: DeliverDeps, limit = 20): Promise<number> {
  const due = claimDueEvents(db, limit);
  for (const event of due) {
    await deliverEvent(db, event, deps);
  }
  return due.length;
}

export function startScheduler(db: Db, deps: DeliverDeps, intervalMs: number): () => void {
  const timer = setInterval(() => {
    processDueEvents(db, deps).catch((err) => {
      console.error('[scheduler] tick failed:', err);
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
