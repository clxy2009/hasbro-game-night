import { env } from 'cloudflare:workers';

import {
  DEMO_SEED_KEY,
  shouldInitializeDemoData,
  shouldSeedRsvpsForEvent,
} from './bootstrap-policy';
import {
  indexStatements,
  legacyBackfillStatements,
  legacyColumnUpgrades,
  rsvpTriggerDropStatements,
  schemaStatements,
  triggerStatements,
} from './database-ddl';

const seedMetros = [
  ['metro-seattle', 'seattle', 'Seattle', 'America/Los_Angeles'],
  ['metro-portland', 'portland', 'Portland', 'America/Los_Angeles'],
  ['metro-bay-area', 'bay-area', 'Bay Area', 'America/Los_Angeles'],
] as const;

const RUNTIME_SCHEMA_KEY = 'runtime-schema-v2';

const seedUsers = [
  ['player-maya', 'Maya Chen', 'player', 'metro-seattle'],
  ['player-jordan', 'Jordan Lee', 'player', 'metro-seattle'],
  ['player-sam', 'Sam Rivera', 'player', 'metro-portland'],
  ['player-riley', 'Riley Brooks', 'player', 'metro-seattle'],
  ['player-avery', 'Avery Patel', 'player', 'metro-bay-area'],
  ['player-zoe', 'Zoë Martin', 'player', 'metro-portland'],
  ['player-elliot', 'Elliot Kim', 'player', 'metro-seattle'],
  ['player-noor', 'Noor Hassan', 'player', 'metro-bay-area'],
  ['org-meeple', 'Meeple House', 'organizer', 'metro-seattle'],
  ['org-commons', 'Tabletop Commons', 'organizer', 'metro-seattle'],
  ['org-rose-city', 'Rose City Games', 'organizer', 'metro-portland'],
  ['org-bay-table', 'Bay Table Collective', 'organizer', 'metro-bay-area'],
] as const;

const seedEventSpecs = [
  [
    'event-draft',
    'org-meeple',
    'metro-seattle',
    'Friday Night Draft',
    'Magic: The Gathering',
    2,
    18,
    30,
    'Meeple House · Ballard',
    8,
  ],
  [
    'event-brunch',
    'org-commons',
    'metro-seattle',
    'Board Game Brunch',
    'Open play',
    3,
    11,
    0,
    'Tabletop Commons · Fremont',
    18,
  ],
  [
    'event-dnd',
    'org-meeple',
    'metro-seattle',
    'D&D: The Sunless Citadel',
    'Dungeons & Dragons',
    4,
    14,
    0,
    'Meeple House · Ballard',
    4,
  ],
  [
    'event-catan',
    'org-commons',
    'metro-seattle',
    'Catan League Night',
    'Catan',
    6,
    19,
    0,
    'Tabletop Commons · Fremont',
    6,
  ],
  [
    'event-paint',
    'org-rose-city',
    'metro-portland',
    'Miniature Paint & Take',
    'Miniatures',
    8,
    18,
    0,
    'Rose City Games · Hawthorne',
    12,
  ],
  [
    'event-chess',
    'org-bay-table',
    'metro-bay-area',
    'Casual Chess Social',
    'Chess',
    11,
    17,
    30,
    'Mission Community Room · San Francisco',
    10,
  ],
  [
    'event-portland-open',
    'org-rose-city',
    'metro-portland',
    'Sunday Strategy Open',
    'Open play',
    5,
    13,
    0,
    'Rose City Games · Hawthorne',
    16,
  ],
  [
    'event-bay-lorcana',
    'org-bay-table',
    'metro-bay-area',
    'Lorcana League',
    'Disney Lorcana',
    7,
    18,
    30,
    'Bay Table Collective · Oakland',
    12,
  ],
] as const;

const seedRsvps: Record<string, string[]> = {
  'event-draft': [
    'player-maya',
    'player-jordan',
    'player-sam',
    'player-riley',
    'player-avery',
    'player-zoe',
    'player-elliot',
  ],
  'event-brunch': [
    'player-jordan',
    'player-sam',
    'player-riley',
    'player-avery',
    'player-zoe',
    'player-noor',
    'player-maya',
    'player-elliot',
  ],
  'event-dnd': ['player-maya', 'player-jordan', 'player-sam', 'player-riley'],
  'event-catan': ['player-avery', 'player-noor'],
  'event-chess': [
    'player-jordan',
    'player-riley',
    'player-zoe',
    'player-elliot',
    'player-noor',
  ],
  'event-portland-open': ['player-sam', 'player-zoe'],
  'event-bay-lorcana': ['player-avery'],
};

let ready: Promise<void> | undefined;

export function getDatabase() {
  if (!env.DB) throw new Error('The DB binding is unavailable.');
  return env.DB;
}

function futureDate(days: number, hour: number, minute: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

async function seedDemoDataOnce(db: D1Database) {
  const marker = await db
    .prepare('SELECT value FROM app_metadata WHERE key = ?')
    .bind(DEMO_SEED_KEY)
    .first<{ value: string }>();
  const markerValue = marker?.value;
  if (!shouldInitializeDemoData(markerValue)) return;

  const existingEvents = await db
    .prepare('SELECT id FROM events')
    .all<{ id: string }>();
  const existingEventIds = new Set(existingEvents.results.map(({ id }) => id));
  const now = new Date().toISOString();
  const markSeeded = db
    .prepare(`INSERT OR IGNORE INTO app_metadata (key, value, updated_at)
      VALUES (?, 'complete', ?)`)
    .bind(DEMO_SEED_KEY, now);

  const userStatements = seedUsers.map(([id, name, role, homeMetroId]) =>
    db
      .prepare(`INSERT OR IGNORE INTO users (id, name, role, home_metro_id)
        VALUES (?, ?, ?, ?)`)
      .bind(id, name, role, homeMetroId),
  );
  const eventStatements = seedEventSpecs.map(
    ([
      id,
      organizerId,
      metroId,
      title,
      gameType,
      days,
      hour,
      minute,
      location,
      capacity,
    ]) => {
      const startsAt = futureDate(days, hour, minute);
      return db
        .prepare(`INSERT OR IGNORE INTO events
          (id, organizer_id, metro_id, title, game_type, starts_at, location, capacity,
            rsvp_opens_at, rsvp_closes_at, cancellation_closes_at, attendee_count, version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`)
        .bind(
          id,
          organizerId,
          metroId,
          title,
          gameType,
          startsAt,
          location,
          capacity,
          now,
          startsAt,
          startsAt,
          now,
        );
    },
  );
  const rsvpStatements = Object.entries(seedRsvps).flatMap(
    ([eventId, players]) =>
      shouldSeedRsvpsForEvent(existingEventIds.has(eventId))
        ? players.map((playerId, index) =>
            db
              .prepare(`INSERT OR IGNORE INTO rsvps
                (event_id, player_id, request_id, created_at) VALUES (?, ?, ?, ?)`)
              .bind(
                eventId,
                playerId,
                `seed:${eventId}:${playerId}`,
                new Date(Date.now() + index * 1000).toISOString(),
              ),
          )
        : [],
  );

  await db.batch([
    ...userStatements,
    ...eventStatements,
    ...rsvpStatements,
    markSeeded,
  ]);
}

async function missingLegacyColumnUpgrades(db: D1Database) {
  const columnsByTable = new Map<string, Set<string>>();
  for (const table of new Set(
    legacyColumnUpgrades.map((upgrade) => upgrade.table),
  )) {
    const result = await db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    columnsByTable.set(
      table,
      new Set(result.results.map((column) => column.name)),
    );
  }

  return legacyColumnUpgrades.filter(
    ({ table, column }) => !columnsByTable.get(table)?.has(column),
  );
}

async function upgradeLegacySchema(db: D1Database) {
  const missing = await missingLegacyColumnUpgrades(db);
  if (missing.length) {
    try {
      await db.batch(missing.map(({ sql }) => db.prepare(sql)));
    } catch (error) {
      if ((await missingLegacyColumnUpgrades(db)).length) throw error;
    }
  }
  await db.batch(
    legacyBackfillStatements.map((statement) => db.prepare(statement)),
  );
}

async function initializeDatabase() {
  const db = getDatabase();
  try {
    const marker = await db
      .prepare('SELECT value FROM app_metadata WHERE key = ?')
      .bind(RUNTIME_SCHEMA_KEY)
      .first<{ value: string }>();
    if (marker?.value === 'complete') return;
  } catch {
    // The metadata table does not exist in the original schema.
  }
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
  await db.batch(
    seedMetros.map(([id, slug, name, timezone]) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO metros (id, slug, name, timezone) VALUES (?, ?, ?, ?)',
        )
        .bind(id, slug, name, timezone),
    ),
  );
  await upgradeLegacySchema(db);
  await db.batch(indexStatements.map((statement) => db.prepare(statement)));
  await db.batch(
    [...rsvpTriggerDropStatements, ...triggerStatements].map((statement) =>
      db.prepare(statement),
    ),
  );
  await seedDemoDataOnce(db);
  await db
    .prepare('DELETE FROM rate_limits WHERE expires_at < ?')
    .bind(Date.now())
    .run();
  await db.prepare('PRAGMA optimize').run();
  await db
    .prepare(`INSERT OR REPLACE INTO app_metadata (key, value, updated_at)
      VALUES (?, 'complete', ?)`)
    .bind(RUNTIME_SCHEMA_KEY, new Date().toISOString())
    .run();
}

export function ensureDatabase() {
  ready ??= initializeDatabase().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}
