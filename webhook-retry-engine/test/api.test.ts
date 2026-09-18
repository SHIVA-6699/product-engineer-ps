import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const db = createDb(':memory:');
  const app = createApp(db);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterEach(() => {
  server.close();
});

const validEvent = {
  eventId: 'evt_api_dup',
  type: 'incident.created',
  occurredAt: '2026-09-15T10:00:00Z',
  payload: { incidentId: 'inc_1', severity: 'high' },
};

describe('POST /events over real HTTP', () => {
  it('AC4: submitting the same eventId twice returns the existing event, not a new one', async () => {
    const first = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validEvent),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.status).toBe('pending');

    const second = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validEvent, payload: { different: true } }),
    });
    expect(second.status).toBe(200); // 200, not 201 (nothing new was created)
    const secondBody = await second.json();
    expect(secondBody.eventId).toBe(validEvent.eventId);
    expect(secondBody.payload).toEqual(validEvent.payload); // original payload retained, not overwritten

    const list = await (await fetch(`${baseUrl}/events`)).json();
    expect(list.filter((e: { eventId: string }) => e.eventId === validEvent.eventId)).toHaveLength(1);
  });

  it('rejects an event missing the required stable identifier', async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'incident.created', occurredAt: '2026-09-15T10:00:00Z', payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('returns a clean JSON 400 for a malformed body, not Express\'s default HTML error page', async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('GET /events/:eventId 404s for an unknown id, and returns ordered attempts for a known one', async () => {
    const missing = await fetch(`${baseUrl}/events/does_not_exist`);
    expect(missing.status).toBe(404);

    await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validEvent),
    });
    const found = await fetch(`${baseUrl}/events/${validEvent.eventId}`);
    expect(found.status).toBe(200);
    const body = await found.json();
    expect(body.attempts).toEqual([]); // no delivery attempted yet in this test, scheduler isn't running here
  });
});
