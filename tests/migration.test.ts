import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

void test('the checked-in migration upgrades and preserves the original schema data', () => {
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
      'event', 'organizer', 'Existing event', 'Chess',
      '2026-10-01T18:00:00.000Z', 'Existing venue', 8, '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO rsvps VALUES ('event', 'player', '2026-09-02T00:00:00.000Z');
  `);

  const migrationDirectory = new URL('../drizzle/', import.meta.url);
  const migrationFiles = readdirSync(migrationDirectory)
    .filter((file) => /^\d+_.+\.sql$/.test(file) && !file.startsWith('0000_'))
    .sort();
  for (const migrationFile of migrationFiles) {
    if (migrationFile.startsWith('0004_')) {
      db.prepare(
        `INSERT INTO users (id, name, role, home_metro_id)
          VALUES ('pre-0004-player', 'Pre-0004 Player', 'player', 'metro-seattle')`,
      ).run();
      db.prepare(
        `INSERT INTO rsvps (event_id, player_id, request_id, created_at)
          VALUES ('event', 'pre-0004-player', 'pre-0004-request',
            '2026-09-02T12:00:00.000Z')`,
      ).run();
      db.prepare(
        `DELETE FROM rsvps
          WHERE event_id = 'event' AND player_id = 'pre-0004-player'`,
      ).run();
    }
    const migration = readFileSync(
      new URL(migrationFile, migrationDirectory),
      'utf8',
    );
    db.exec('BEGIN');
    try {
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) db.exec(statement);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const event = db
    .prepare(`SELECT metro_id AS metroId, attendee_count AS attendeeCount,
      version, rsvp_opens_at AS opensAt, rsvp_closes_at AS closesAt
      FROM events WHERE id = 'event'`)
    .get();
  assert.equal(event?.metroId, 'metro-seattle');
  assert.equal(event?.attendeeCount, 1);
  assert.equal(event?.version, 3);
  assert.equal(event?.opensAt, '2026-09-01T00:00:00.000Z');
  assert.equal(event?.closesAt, '2026-10-01T18:00:00.000Z');
  assert.equal(
    db
      .prepare(`SELECT home_metro_id AS metroId FROM users WHERE id = 'player'`)
      .get()?.metroId,
    'metro-seattle',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM rsvps').get()?.count,
    1,
  );
  assert.deepEqual(
    db
      .prepare('SELECT action FROM rsvp_history ORDER BY rowid')
      .all()
      .map((row) => row.action),
    ['reserved', 'canceled'],
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM outbox_events').get()?.count,
    2,
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.ok(
    db
      .prepare(`SELECT 1 FROM sqlite_schema
        WHERE type = 'table' AND name = 'app_metadata'`)
      .get(),
  );
  db.prepare(
    `INSERT INTO users (id, name, role, home_metro_id)
      VALUES ('player-2', 'Second Player', 'player', 'metro-seattle')`,
  ).run();
  db.prepare(
    `INSERT INTO rsvps (event_id, player_id, request_id, created_at)
      VALUES ('event', 'player-2', 'migration-test', '2026-09-03T00:00:00.000Z')`,
  ).run();
  assert.equal(
    db
      .prepare(`SELECT attendee_count AS count FROM events WHERE id = 'event'`)
      .get()?.count,
    2,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM rsvp_history').get()?.count,
    3,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM outbox_events').get()?.count,
    3,
  );
  db.prepare(
    `DELETE FROM rsvps WHERE event_id = 'event' AND player_id = 'player-2'`,
  ).run();
  assert.equal(
    db
      .prepare(`SELECT attendee_count AS count FROM events WHERE id = 'event'`)
      .get()?.count,
    1,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM rsvp_history').get()?.count,
    4,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM outbox_events').get()?.count,
    4,
  );
  db.prepare(
    `INSERT INTO events
      (id, organizer_id, title, game_type, starts_at, location, capacity, created_at)
      VALUES ('legacy-writer-event', 'organizer', 'Legacy writer', 'Chess',
        '2026-11-01T18:00:00.000Z', 'Existing venue', 6,
        '2026-09-04T00:00:00.000Z')`,
  ).run();
  assert.deepEqual(
    {
      ...db
        .prepare(`SELECT metro_id AS metroId, rsvp_opens_at AS opensAt,
          rsvp_closes_at AS closesAt, cancellation_closes_at AS cancellationClosesAt
          FROM events WHERE id = 'legacy-writer-event'`)
        .get(),
    },
    {
      metroId: 'metro-seattle',
      opensAt: '2026-09-04T00:00:00.000Z',
      closesAt: '2026-11-01T18:00:00.000Z',
      cancellationClosesAt: '2026-11-01T18:00:00.000Z',
    },
  );
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
          WHERE event_id = 'legacy-writer-event' AND event_type = 'event.created'`,
      )
      .get()?.count,
    1,
  );
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});
