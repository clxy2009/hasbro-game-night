import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventSchema } from '../lib/event-input.ts';

const originalClientPayload = {
  title: 'Compatibility Table',
  gameType: 'Chess',
  startsAt: '2026-11-01T18:00:00.000Z',
  location: 'Community Hall',
  capacity: 8,
};

void test('the event API accepts the previous client payload during rollout', () => {
  const parsed = createEventSchema.safeParse(originalClientPayload);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.metroId, undefined);
});

void test('an explicitly invalid metro is not treated as an omitted metro', () => {
  const parsed = createEventSchema.safeParse({
    ...originalClientPayload,
    metroId: '',
  });
  assert.equal(parsed.success, false);
});
