import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptsActiveRequest } from '../lib/rsvp-sql.ts';

void test('only the request key stored on the active RSVP is an idempotent replay', () => {
  assert.equal(acceptsActiveRequest('request-a', 'request-a', true), true);
  assert.equal(acceptsActiveRequest('request-a', 'request-b', true), false);
  assert.equal(acceptsActiveRequest(null, 'request-b', true), false);
});

void test('a client without a request key retains state-based POST compatibility', () => {
  assert.equal(
    acceptsActiveRequest('server-generated', 'new-key', false),
    true,
  );
});
