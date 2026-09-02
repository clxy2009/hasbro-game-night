import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRsvpPrecondition, rsvpEtag } from '../lib/rsvp-sql.ts';

void test('RSVP preconditions accept one strong opaque tag', () => {
  assert.deepEqual(parseRsvpPrecondition('"reservation-1"'), {
    kind: 'valid',
    version: 'reservation-1',
  });
  assert.equal(rsvpEtag('reservation-1'), '"reservation-1"');
});

void test('RSVP preconditions reject missing, weak, wildcard, and list values', () => {
  assert.deepEqual(parseRsvpPrecondition(null), { kind: 'missing' });
  for (const value of [
    'W/"reservation-1"',
    '*',
    '"reservation-1", "reservation-2"',
    'reservation-1',
    '""',
  ]) {
    assert.deepEqual(parseRsvpPrecondition(value), { kind: 'invalid' });
  }
});
