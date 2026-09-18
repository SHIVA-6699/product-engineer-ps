import express from 'express';

// Fake webhook receiver so I don't need a real external service to test
// against. Switch its mode with POST /mode (or MODE env var on startup):
//   success - always 200
//   fail    - always 500, never recovers (for the exhaustion scenario)
//   flaky   - fails flakyFailCount times per eventId then starts succeeding
type Mode = 'success' | 'fail' | 'flaky';

let mode: Mode = (process.env.MODE as Mode) ?? 'success';
let flakyFailCount = Number(process.env.FLAKY_FAIL_COUNT ?? 2);

const received: Array<{ eventId: string; attemptNumber: number; body: unknown; at: string }> = [];
const flakyAttemptsSeen = new Map<string, number>();

const app = express();
app.use(express.json());

app.post('/mode', (req, res) => {
  const { mode: newMode, flakyFailCount: newCount } = req.body ?? {};
  if (newMode) mode = newMode;
  if (typeof newCount === 'number') flakyFailCount = newCount;
  flakyAttemptsSeen.clear();
  res.json({ mode, flakyFailCount });
});

app.get('/received', (_req, res) => {
  res.json({ mode, flakyFailCount, received });
});

app.post('/webhook', (req, res) => {
  const eventId = String(req.header('x-event-id') ?? 'unknown');
  const attemptNumber = Number(req.header('x-attempt-number') ?? 0);
  received.push({ eventId, attemptNumber, body: req.body, at: new Date().toISOString() });

  if (mode === 'fail') {
    return res.status(500).json({ error: 'simulated permanent failure' });
  }

  if (mode === 'flaky') {
    const seen = (flakyAttemptsSeen.get(eventId) ?? 0) + 1;
    flakyAttemptsSeen.set(eventId, seen);
    if (seen <= flakyFailCount) {
      return res.status(500).json({ error: `simulated transient failure (${seen}/${flakyFailCount})` });
    }
  }

  res.status(200).json({ ok: true });
});

const PORT = Number(process.env.RECEIVER_PORT ?? 4100);
app.listen(PORT, () => {
  console.log(`[test-receiver] listening on http://localhost:${PORT}, mode=${mode}`);
});
