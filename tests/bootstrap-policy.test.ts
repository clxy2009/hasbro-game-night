import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldInitializeDemoData,
  shouldSeedRsvpsForEvent,
} from '../lib/server/bootstrap-policy.ts';

void test('demo bootstrap runs once and preserves RSVPs for existing events', () => {
  assert.equal(shouldInitializeDemoData(undefined), true);
  assert.equal(shouldInitializeDemoData('complete'), false);
  assert.equal(shouldSeedRsvpsForEvent(false), true);
  assert.equal(shouldSeedRsvpsForEvent(true), false);
});
