import assert from 'node:assert/strict';
import test from 'node:test';

import { parseApiResponse } from '../lib/client-api.ts';
import { nextChangePollDelay } from '../lib/change-feed.ts';
import { toLocalDateTimeValue } from '../lib/local-datetime.ts';

void test('API parsing preserves structured errors and handles non-JSON failures', async () => {
  await assert.rejects(
    parseApiResponse(
      Response.json(
        { error: { code: 'EVENT_FULL', message: 'The event is full.' } },
        { status: 409 },
      ),
    ),
    { message: 'The event is full.', status: 409, code: 'EVENT_FULL' },
  );
  await assert.rejects(
    parseApiResponse(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    ),
    { message: 'The server returned HTTP 502.', status: 502 },
  );
  await assert.rejects(
    parseApiResponse(
      new Response(
        JSON.stringify({ error: { code: 'BUSY', message: 'Try later.' } }),
        {
          status: 503,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    ),
    { message: 'Try later.', status: 503, code: 'BUSY' },
  );
});

void test('local date-time values use the browser offset instead of UTC', () => {
  const instant = new Date('2026-09-01T18:30:00.000Z');
  assert.equal(toLocalDateTimeValue(instant, 420), '2026-09-01T11:30');
  assert.equal(toLocalDateTimeValue(instant, 480), '2026-09-01T10:30');
});

void test('change polling backs off after failures and stays bounded', () => {
  assert.equal(nextChangePollDelay(0, 0), 4200);
  assert.equal(nextChangePollDelay(0, 1), 5800);
  assert.equal(nextChangePollDelay(1, 0), 2000);
  assert.equal(nextChangePollDelay(5, 1), 60_000);
  assert.equal(nextChangePollDelay(50, 1), 60_000);
});
