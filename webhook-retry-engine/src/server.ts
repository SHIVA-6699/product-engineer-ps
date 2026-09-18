import { createApp } from './app.js';
import { createDb, recoverStuckDeliveries } from './db.js';
import { startScheduler } from './delivery/scheduler.js';
import { loadRetryConfigFromEnv } from './delivery/retryPolicy.js';

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.DB_PATH ?? './data.sqlite';
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? 'http://localhost:4100/webhook';
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 500);

const db = createDb(DB_PATH);

const recovered = recoverStuckDeliveries(db);
if (recovered > 0) {
  console.log(`[startup] recovered ${recovered} event(s) stuck in 'delivering' from a previous crash`);
}

const app = createApp(db);
const stopScheduler = startScheduler(db, { webhookUrl: WEBHOOK_URL, retryConfig: loadRetryConfigFromEnv() }, SCHEDULER_INTERVAL_MS);

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] delivering to WEBHOOK_URL=${WEBHOOK_URL}`);
});

function shutdown() {
  stopScheduler();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
