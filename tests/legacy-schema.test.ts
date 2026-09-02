import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  indexStatements,
  legacyBackfillStatements,
  legacyColumnUpgrades,
  schemaStatements,
  triggerStatements,
} from '../lib/server/database-ddl.ts';

void test('runtime initialization upgrades an existing local schema safely', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('player', 'organizer'))
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY NOT NULL,
      organizer_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      game_type TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      location TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 500),
      created_at TEXT NOT NULL
    );
    CREATE TABLE rsvps (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, player_id)
    );
    INSERT INTO users VALUES ('organizer', 'Organizer', 'organizer');
    INSERT INTO users VALUES ('player', 'Player', 'player');
    INSERT INTO events VALUES (
      'existing', 'organizer', 'Existing', 'Chess',
      '2026-10-01T18:00:00.000Z', 'Existing venue', 8,
      '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO rsvps VALUES (
      'existing', 'player', '2026-09-02T00:00:00.000Z'
    );
  `);

  for (const statement of schemaStatements) db.exec(statement);
  db.prepare(
    `INSERT INTO metros (id, slug, name, timezone)
      VALUES ('metro-seattle', 'seattle', 'Seattle', 'America/Los_Angeles')`,
  ).run();
  for (const upgrade of legacyColumnUpgrades) {
    const columns = new Set(
      db
        .prepare(`PRAGMA table_info(${upgrade.table})`)
        .all()
        .map((column) => String(column.name)),
    );
    if (!columns.has(upgrade.column)) db.exec(upgrade.sql);
  }
  for (const statement of legacyBackfillStatements) db.exec(statement);
  for (const statement of indexStatements) db.exec(statement);
  for (const statement of triggerStatements) db.exec(statement);

  db.prepare(
    `UPDATE events SET rsvp_opens_at = '', rsvp_closes_at = '',
      cancellation_closes_at = '', attendee_count = 0, version = 0
      WHERE id = 'existing'`,
  ).run();
  for (const statement of legacyBackfillStatements) db.exec(statement);

  assert.deepEqual(
    {
      ...db
        .prepare(`SELECT metro_id AS metroId, rsvp_opens_at AS opensAt,
          rsvp_closes_at AS closesAt, attendee_count AS attendeeCount,
          version FROM events WHERE id = 'existing'`)
        .get(),
    },
    {
      metroId: 'metro-seattle',
      opensAt: '2026-09-01T00:00:00.000Z',
      closesAt: '2026-10-01T18:00:00.000Z',
      attendeeCount: 1,
      version: 1,
    },
  );

  db.prepare(
    `INSERT INTO events
      (id, organizer_id, title, game_type, starts_at, location, capacity, created_at)
      VALUES ('old-writer', 'organizer', 'Old writer', 'Chess',
        '2026-12-01T18:00:00.000Z', 'Legacy venue', 4,
        '2026-09-03T00:00:00.000Z')`,
  ).run();
  assert.deepEqual(
    {
      ...db
        .prepare(`SELECT metro_id AS metroId, rsvp_opens_at AS opensAt,
          rsvp_closes_at AS closesAt, cancellation_closes_at AS cancellationClosesAt
          FROM events WHERE id = 'old-writer'`)
        .get(),
    },
    {
      metroId: 'metro-seattle',
      opensAt: '2026-09-03T00:00:00.000Z',
      closesAt: '2026-12-01T18:00:00.000Z',
      cancellationClosesAt: '2026-12-01T18:00:00.000Z',
    },
  );
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
          WHERE event_id = 'old-writer' AND event_type = 'event.created'`,
      )
      .get()?.count,
    1,
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});
