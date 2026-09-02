export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS metros (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('player', 'organizer')),
    home_metro_id TEXT NOT NULL DEFAULT 'metro-seattle' REFERENCES metros(id)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY NOT NULL,
    organizer_id TEXT NOT NULL REFERENCES users(id),
    metro_id TEXT NOT NULL DEFAULT 'metro-seattle' REFERENCES metros(id),
    title TEXT NOT NULL,
    game_type TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    location TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 500),
    rsvp_opens_at TEXT NOT NULL DEFAULT '',
    rsvp_closes_at TEXT NOT NULL DEFAULT '',
    cancellation_closes_at TEXT NOT NULL DEFAULT '',
    attendee_count INTEGER NOT NULL DEFAULT 0 CHECK (attendee_count BETWEEN 0 AND capacity),
    version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    CHECK (rsvp_opens_at <= rsvp_closes_at AND rsvp_closes_at <= starts_at),
    CHECK (cancellation_closes_at <= starts_at)
  )`,
  `CREATE TABLE IF NOT EXISTS rsvps (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, player_id)
  )`,
  `CREATE TABLE IF NOT EXISTS rsvp_history (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT NOT NULL REFERENCES events(id),
    player_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('reserved', 'canceled')),
    occurred_at TEXT NOT NULL,
    request_id TEXT,
    event_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS outbox_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    occurred_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    scope TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    hits INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (scope, window_start)
  )`,
  `CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export const indexStatements = [
  'CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events(starts_at, id)',
  'CREATE INDEX IF NOT EXISTS idx_events_organizer_starts_at ON events(organizer_id, starts_at)',
  'CREATE INDEX IF NOT EXISTS idx_events_metro_starts_at ON events(metro_id, starts_at, id)',
  'CREATE INDEX IF NOT EXISTS idx_rsvps_player_event ON rsvps(player_id, event_id)',
  'CREATE INDEX IF NOT EXISTS idx_rsvp_history_player_time ON rsvp_history(player_id, occurred_at, id)',
  'CREATE INDEX IF NOT EXISTS idx_rsvp_history_event_time ON rsvp_history(event_id, occurred_at, id)',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_rsvp_history_request
    ON rsvp_history(event_id, player_id, request_id)
    WHERE action = 'reserved' AND request_id IS NOT NULL`,
  'CREATE INDEX IF NOT EXISTS idx_outbox_event_id ON outbox_events(event_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_rate_limits_expires_at ON rate_limits(expires_at)',
];

export const eventTriggerStatements = [
  `CREATE TRIGGER IF NOT EXISTS trg_events_before_legacy_insert
    BEFORE INSERT ON events
    WHEN NEW.metro_id IS NULL OR NEW.metro_id = ''
      OR NEW.rsvp_opens_at IS NULL OR NEW.rsvp_opens_at = ''
      OR NEW.rsvp_closes_at IS NULL OR NEW.rsvp_closes_at = ''
      OR NEW.cancellation_closes_at IS NULL OR NEW.cancellation_closes_at = ''
    BEGIN
      INSERT INTO events
        (id, organizer_id, metro_id, title, game_type, starts_at, location, capacity,
          rsvp_opens_at, rsvp_closes_at, cancellation_closes_at,
          attendee_count, version, created_at)
      VALUES
        (NEW.id, NEW.organizer_id,
          CASE WHEN NEW.metro_id IS NULL OR NEW.metro_id = ''
            THEN 'metro-seattle' ELSE NEW.metro_id END,
          NEW.title, NEW.game_type, NEW.starts_at, NEW.location, NEW.capacity,
          CASE WHEN NEW.rsvp_opens_at IS NULL OR NEW.rsvp_opens_at = ''
            THEN NEW.created_at ELSE NEW.rsvp_opens_at END,
          CASE WHEN NEW.rsvp_closes_at IS NULL OR NEW.rsvp_closes_at = ''
            THEN NEW.starts_at ELSE NEW.rsvp_closes_at END,
          CASE WHEN NEW.cancellation_closes_at IS NULL OR NEW.cancellation_closes_at = ''
            THEN NEW.starts_at ELSE NEW.cancellation_closes_at END,
          COALESCE(NEW.attendee_count, 0), COALESCE(NEW.version, 0), NEW.created_at);
      SELECT RAISE(IGNORE);
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_events_after_insert
    AFTER INSERT ON events
    BEGIN
      UPDATE events
      SET rsvp_opens_at = CASE
            WHEN NEW.rsvp_opens_at = '' THEN NEW.created_at
            ELSE NEW.rsvp_opens_at
          END,
          rsvp_closes_at = CASE
            WHEN NEW.rsvp_closes_at = '' THEN NEW.starts_at
            ELSE NEW.rsvp_closes_at
          END,
          cancellation_closes_at = CASE
            WHEN NEW.cancellation_closes_at = '' THEN NEW.starts_at
            ELSE NEW.cancellation_closes_at
          END
      WHERE id = NEW.id;
      INSERT INTO outbox_events
        (event_id, event_type, event_version, occurred_at)
      SELECT NEW.id, 'event.created', version, NEW.created_at
      FROM events WHERE id = NEW.id;
    END`,
];

export const rsvpTriggerStatements = [
  `CREATE TRIGGER IF NOT EXISTS trg_rsvps_after_insert
    AFTER INSERT ON rsvps
    BEGIN
      UPDATE events
      SET attendee_count = attendee_count + 1,
          version = version + 1
      WHERE id = NEW.event_id;
      INSERT INTO rsvp_history
        (id, event_id, player_id, action, occurred_at, request_id, event_version)
      SELECT lower(hex(randomblob(16))), NEW.event_id, NEW.player_id, 'reserved',
        NEW.created_at, NEW.request_id, version
      FROM events WHERE id = NEW.event_id;
      INSERT INTO outbox_events
        (event_id, event_type, event_version, occurred_at)
      SELECT NEW.event_id, 'capacity.changed', version, NEW.created_at
      FROM events WHERE id = NEW.event_id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_rsvps_after_delete
    AFTER DELETE ON rsvps
    BEGIN
      UPDATE events
      SET attendee_count = CASE WHEN attendee_count > 0 THEN attendee_count - 1 ELSE 0 END,
          version = version + 1
      WHERE id = OLD.event_id;
      INSERT INTO rsvp_history
        (id, event_id, player_id, action, occurred_at, request_id, event_version)
      SELECT lower(hex(randomblob(16))), OLD.event_id, OLD.player_id, 'canceled',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.request_id, version
      FROM events WHERE id = OLD.event_id;
      INSERT INTO outbox_events
        (event_id, event_type, event_version, occurred_at)
      SELECT OLD.event_id, 'capacity.changed', version,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM events WHERE id = OLD.event_id;
    END`,
];

export const rsvpTriggerDropStatements = [
  'DROP TRIGGER IF EXISTS trg_rsvps_after_insert',
  'DROP TRIGGER IF EXISTS trg_rsvps_after_delete',
];

export const triggerStatements = [
  ...eventTriggerStatements,
  ...rsvpTriggerStatements,
];

export const legacyColumnUpgrades = [
  {
    table: 'users',
    column: 'home_metro_id',
    sql: `ALTER TABLE users ADD COLUMN home_metro_id TEXT NOT NULL
      DEFAULT 'metro-seattle'`,
  },
  {
    table: 'events',
    column: 'metro_id',
    sql: `ALTER TABLE events ADD COLUMN metro_id TEXT NOT NULL
      DEFAULT 'metro-seattle'`,
  },
  {
    table: 'events',
    column: 'rsvp_opens_at',
    sql: "ALTER TABLE events ADD COLUMN rsvp_opens_at TEXT NOT NULL DEFAULT ''",
  },
  {
    table: 'events',
    column: 'rsvp_closes_at',
    sql: "ALTER TABLE events ADD COLUMN rsvp_closes_at TEXT NOT NULL DEFAULT ''",
  },
  {
    table: 'events',
    column: 'cancellation_closes_at',
    sql: `ALTER TABLE events ADD COLUMN cancellation_closes_at TEXT NOT NULL
      DEFAULT ''`,
  },
  {
    table: 'events',
    column: 'attendee_count',
    sql: `ALTER TABLE events ADD COLUMN attendee_count INTEGER NOT NULL
      DEFAULT 0`,
  },
  {
    table: 'events',
    column: 'version',
    sql: 'ALTER TABLE events ADD COLUMN version INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'rsvps',
    column: 'request_id',
    sql: 'ALTER TABLE rsvps ADD COLUMN request_id TEXT',
  },
] as const;

export const legacyBackfillStatements = [
  `UPDATE rsvps
    SET request_id = lower(hex(randomblob(16)))
    WHERE request_id IS NULL OR request_id = ''`,
  `UPDATE events
    SET metro_id = CASE WHEN metro_id = '' THEN 'metro-seattle' ELSE metro_id END,
        rsvp_opens_at = CASE WHEN rsvp_opens_at = '' THEN created_at ELSE rsvp_opens_at END,
        rsvp_closes_at = CASE WHEN rsvp_closes_at = '' THEN starts_at ELSE rsvp_closes_at END,
        cancellation_closes_at = CASE
          WHEN cancellation_closes_at = '' THEN starts_at
          ELSE cancellation_closes_at
        END,
        attendee_count = (
          SELECT COUNT(*) FROM rsvps WHERE rsvps.event_id = events.id
        ),
        version = MAX(version, (
          SELECT COUNT(*) FROM rsvps WHERE rsvps.event_id = events.id
        ))
    WHERE metro_id = ''
      OR rsvp_opens_at = ''
      OR rsvp_closes_at = ''
      OR cancellation_closes_at = ''
      OR attendee_count != (
        SELECT COUNT(*) FROM rsvps WHERE rsvps.event_id = events.id
      )
      OR version < (
        SELECT COUNT(*) FROM rsvps WHERE rsvps.event_id = events.id
      )`,
];
