import assert from 'node:assert/strict';
import test from 'node:test';

import { eventMetroScope } from '../lib/event-filters.ts';

void test('My Events is all-metro while discovery remains metro-scoped', () => {
  assert.equal(eventMetroScope(true, 'metro-seattle'), '');
  assert.equal(eventMetroScope(true, 'metro-portland'), '');
  assert.equal(eventMetroScope(false, 'metro-portland'), 'metro-portland');
});
