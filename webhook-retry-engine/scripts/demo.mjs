// Run this against the running server + receiver (npm run receiver / npm run dev
// in two other terminals first). Walks through every required scenario in
// order with a printed label before each step, so it's easy to narrate over
// for the demo video instead of typing curl commands live.

const SERVER = 'http://localhost:4000';
const RECEIVER = 'http://localhost:4100';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function main() {
  // unique ids every run, otherwise re-running this against the same db
  // file just returns the already-completed events from last time
  // (which is actually correct idempotent behavior, just confusing for a demo)
  const runId = Date.now();
  const evt1 = `evt_demo_${runId}_1`;
  const evt2 = `evt_demo_${runId}_2`;
  const evt3 = `evt_demo_${runId}_3`;

  log('STEP 1 - AC1: successful delivery');
  console.log(`Receiver is on default "success" mode. Submitting ${evt1}...`);
  const r1 = await post(`${SERVER}/events`, {
    eventId: evt1,
    type: 'incident.created',
    occurredAt: '2026-09-15T10:00:00Z',
    payload: { incidentId: 'inc_1', severity: 'high' },
  });
  console.log('Response:', r1.status, r1.body);
  await sleep(1000);
  const r1check = await get(`${SERVER}/events/${evt1}`);
  console.log('\nState after delivery:', JSON.stringify(r1check.body, null, 2));

  log('STEP 2 - AC2: temporary failure then successful retry');
  console.log('Switching receiver to flaky mode (fails twice, then succeeds)...');
  await post(`${RECEIVER}/mode`, { mode: 'flaky', flakyFailCount: 2 });
  console.log(`Submitting ${evt2}...`);
  await post(`${SERVER}/events`, {
    eventId: evt2,
    type: 'incident.created',
    occurredAt: '2026-09-15T10:00:00Z',
    payload: { incidentId: 'inc_2', severity: 'high' },
  });
  console.log('Waiting for retries to play out...');
  await sleep(3500);
  const r2check = await get(`${SERVER}/events/${evt2}`);
  console.log('\nState + attempt history:', JSON.stringify(r2check.body, null, 2));

  log('STEP 3 - AC3: bounded failure, stops after max attempts');
  console.log('Switching receiver to permanent-fail mode...');
  await post(`${RECEIVER}/mode`, { mode: 'fail' });
  console.log(`Submitting ${evt3}...`);
  await post(`${SERVER}/events`, {
    eventId: evt3,
    type: 'incident.created',
    occurredAt: '2026-09-15T10:00:00Z',
    payload: { incidentId: 'inc_3', severity: 'critical' },
  });
  console.log('Waiting for all 5 attempts to exhaust (backoff adds up: 500ms, 1s, 2s, 4s between them)...');
  await sleep(10000);
  const r3check = await get(`${SERVER}/events/${evt3}`);
  console.log('\nFinal state, stopped retrying:', JSON.stringify(r3check.body, null, 2));

  log('STEP 4 - AC4: idempotent ingestion');
  console.log(`Resubmitting ${evt1} with a DIFFERENT payload...`);
  const r4 = await post(`${SERVER}/events`, {
    eventId: evt1,
    type: 'incident.created',
    occurredAt: '2026-09-15T10:00:00Z',
    payload: { totally: 'different payload this time' },
  });
  console.log('Response status:', r4.status, '(200, not 201, means nothing new was created)');
  console.log('Response body (original payload preserved):', JSON.stringify(r4.body, null, 2));

  log('DONE - reset receiver back to success mode for next run');
  await post(`${RECEIVER}/mode`, { mode: 'success' });
}

main().catch((err) => {
  console.error('demo script failed:', err);
  process.exit(1);
});
