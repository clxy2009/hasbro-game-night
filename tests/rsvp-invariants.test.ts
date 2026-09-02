import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { cancelSeatSql, reserveSeatSql } from '../lib/rsvp-sql.ts';
import { rsvpTriggerStatements } from '../lib/server/database-ddl.ts';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      starts_at TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 500),
      rsvp_opens_at TEXT NOT NULL,
      rsvp_closes_at TEXT NOT NULL,
      cancellation_closes_at TEXT NOT NULL,
      attendee_count INTEGER NOT NULL DEFAULT 0 CHECK (attendee_count BETWEEN 0 AND capacity),
      version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE rsvps (
      event_id TEXT NOT NULL REFERENCES events(id),
      player_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, player_id)
    );
    CREATE TABLE rsvp_history (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      action TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      request_id TEXT,
      event_version INTEGER NOT NULL
    );
    CREATE TABLE outbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);
  for (const statement of rsvpTriggerStatements) db.exec(statement);
  return db;
}

function addEvent(
  db: DatabaseSync,
  id: string,
  capacity: number,
  startsAt: string,
  options?: {
    opensAt?: string;
    closesAt?: string;
    cancellationClosesAt?: string;
  },
) {
  const alreadyOpen = new Date(Date.now() - 60_000).toISOString();
  db.prepare(`INSERT INTO events
    (id, starts_at, capacity, rsvp_opens_at, rsvp_closes_at, cancellation_closes_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    startsAt,
    capacity,
    options?.opensAt ?? alreadyOpen,
    options?.closesAt ?? startsAt,
    options?.cancellationClosesAt ?? startsAt,
  );
}

function reserve(
  db: DatabaseSync,
  eventId: string,
  playerId: string,
  requestId = `request-${playerId}`,
) {
  return db
    .prepare(reserveSeatSql)
    .get({ 1: eventId, 2: playerId, 3: requestId });
}

function cancel(
  db: DatabaseSync,
  eventId: string,
  playerId: string,
  requestId = `request-${playerId}`,
) {
  return db
    .prepare(cancelSeatSql)
    .get({ 1: eventId, 2: playerId, 3: requestId });
}

void test('competing attempts for the final seat cannot overbook the event', () => {
  const db = database();
  addEvent(db, 'last-seat', 1, new Date(Date.now() + 86_400_000).toISOString());

  const winners = Array.from({ length: 40 }, (_, index) =>
    reserve(db, 'last-seat', `player-${index}`),
  ).filter(Boolean);

  assert.equal(winners.length, 1);
  const finalEvent = db
    .prepare('SELECT attendee_count AS count, version FROM events WHERE id = ?')
    .get('last-seat');
  assert.equal(finalEvent?.count, 1);
  assert.equal(finalEvent?.version, 1);
});

void test('a retried RSVP is idempotent and never double-counts', () => {
  const db = database();
  addEvent(db, 'retry', 10, new Date(Date.now() + 86_400_000).toISOString());

  const results = Array.from({ length: 10 }, () =>
    reserve(db, 'retry', 'same-player'),
  ).filter(Boolean);

  assert.equal(results.length, 1);
  assert.equal(
    db
      .prepare('SELECT attendee_count AS count FROM events WHERE id = ?')
      .get('retry')?.count,
    1,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM rsvp_history').get()?.count,
    1,
  );
});

void test('canceling is idempotent, records history, and releases exactly one seat', () => {
  const db = database();
  addEvent(db, 'cancel', 1, new Date(Date.now() + 86_400_000).toISOString());

  assert.ok(reserve(db, 'cancel', 'first-player'));
  assert.equal(reserve(db, 'cancel', 'second-player'), undefined);
  assert.ok(cancel(db, 'cancel', 'first-player'));
  assert.equal(cancel(db, 'cancel', 'first-player'), undefined);
  assert.ok(reserve(db, 'cancel', 'second-player'));

  const finalEvent = db
    .prepare('SELECT attendee_count AS count, version FROM events WHERE id = ?')
    .get('cancel');
  assert.equal(finalEvent?.count, 1);
  assert.equal(finalEvent?.version, 3);
  assert.deepEqual(
    db
      .prepare('SELECT action FROM rsvp_history ORDER BY rowid')
      .all()
      .map((row) => row.action),
    ['reserved', 'canceled', 'reserved'],
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM outbox_events').get()?.count,
    3,
  );
});

void test('replaying the same RSVP command after cancellation does not rebook', () => {
  const db = database();
  addEvent(
    db,
    'durable-retry',
    2,
    new Date(Date.now() + 86_400_000).toISOString(),
  );

  assert.ok(reserve(db, 'durable-retry', 'player', 'stable-request'));
  assert.ok(cancel(db, 'durable-retry', 'player', 'stable-request'));
  assert.equal(
    reserve(db, 'durable-retry', 'player', 'stable-request'),
    undefined,
  );
  assert.equal(
    db
      .prepare('SELECT attendee_count AS count FROM events WHERE id = ?')
      .get('durable-retry')?.count,
    0,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM rsvp_history').get()?.count,
    2,
  );
});

void test('a delayed cancellation cannot delete a newer reservation generation', () => {
  const db = database();
  addEvent(
    db,
    'generation',
    2,
    new Date(Date.now() + 86_400_000).toISOString(),
  );

  assert.ok(reserve(db, 'generation', 'player', 'reservation-a'));
  assert.ok(cancel(db, 'generation', 'player', 'reservation-a'));
  assert.ok(reserve(db, 'generation', 'player', 'reservation-b'));

  const before = db
    .prepare(`SELECT attendee_count AS attendeeCount, version,
      (SELECT COUNT(*) FROM rsvp_history) AS historyCount,
      (SELECT COUNT(*) FROM outbox_events) AS outboxCount
      FROM events WHERE id = ?`)
    .get('generation');
  assert.equal(cancel(db, 'generation', 'player', 'reservation-a'), undefined);
  const active = db
    .prepare(
      'SELECT request_id AS requestId FROM rsvps WHERE event_id = ? AND player_id = ?',
    )
    .get('generation', 'player');
  const after = db
    .prepare(`SELECT attendee_count AS attendeeCount, version,
      (SELECT COUNT(*) FROM rsvp_history) AS historyCount,
      (SELECT COUNT(*) FROM outbox_events) AS outboxCount
      FROM events WHERE id = ?`)
    .get('generation');

  assert.equal(active?.requestId, 'reservation-b');
  assert.deepEqual(after, before);
});

void test('RSVP opening and closing boundaries are enforced by the write', () => {
  const db = database();
  const now = Date.now();
  const startsAt = new Date(now + 86_400_000).toISOString();
  addEvent(db, 'not-open', 10, startsAt, {
    opensAt: new Date(now + 3_600_000).toISOString(),
    closesAt: new Date(now + 7_200_000).toISOString(),
  });
  addEvent(db, 'open', 10, startsAt);
  addEvent(db, 'closed', 10, startsAt, {
    opensAt: new Date(now - 7_200_000).toISOString(),
    closesAt: new Date(now - 3_600_000).toISOString(),
  });

  assert.equal(reserve(db, 'not-open', 'early-player'), undefined);
  assert.ok(reserve(db, 'open', 'on-time-player'));
  assert.equal(reserve(db, 'closed', 'late-player'), undefined);
});

void test('the cancellation cutoff is enforced by the delete statement', () => {
  const db = database();
  const now = Date.now();
  const startsAt = new Date(now + 86_400_000).toISOString();
  const cancellationClosesAt = new Date(now - 3_600_000).toISOString();
  addEvent(db, 'cancel-window', 2, startsAt, { cancellationClosesAt });
  assert.ok(reserve(db, 'cancel-window', 'player'));

  assert.equal(cancel(db, 'cancel-window', 'player'), undefined);
  assert.equal(
    db
      .prepare('SELECT attendee_count AS count FROM events WHERE id = ?')
      .get('cancel-window')?.count,
    1,
  );
});

void test('events that already started reject new RSVPs', () => {
  const db = database();
  const past = new Date(Date.now() - 60_000).toISOString();
  addEvent(db, 'past', 10, past, {
    opensAt: past,
    closesAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(reserve(db, 'past', 'late-player'), undefined);
});
