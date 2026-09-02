import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../lib/server/api-error.ts';
import { readJson } from '../lib/server/request-body.ts';

void test('readJson enforces the streaming byte limit without Content-Length', async () => {
  const request = new Request('https://example.test/api', {
    method: 'POST',
    body: JSON.stringify({ value: 'larger than the limit' }),
  });
  assert.equal(request.headers.get('content-length'), null);

  await assert.rejects(
    () => readJson(request, 8),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 413 &&
      error.code === 'PAYLOAD_TOO_LARGE',
  );
});

void test('readJson parses a bounded body and rejects malformed JSON', async () => {
  const parsed = await readJson(
    new Request('https://example.test/api', {
      method: 'POST',
      body: JSON.stringify({ capacity: 8 }),
    }),
  );
  assert.deepEqual(parsed, { capacity: 8 });

  await assert.rejects(
    () =>
      readJson(
        new Request('https://example.test/api', {
          method: 'POST',
          body: '{broken',
        }),
      ),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 400 &&
      error.code === 'INVALID_JSON',
  );
});
