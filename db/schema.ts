import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const metros = sqliteTable(
  'metros',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
  },
  (table) => [uniqueIndex('idx_metros_slug').on(table.slug)],
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    role: text('role', { enum: ['player', 'organizer'] }).notNull(),
    homeMetroId: text('home_metro_id')
      .notNull()
      .default('metro-seattle')
      .references(() => metros.id),
  },
  (table) => [
    check('users_role_check', sql`${table.role} in ('player', 'organizer')`),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    organizerId: text('organizer_id')
      .notNull()
      .references(() => users.id),
    metroId: text('metro_id')
      .notNull()
      .default('metro-seattle')
      .references(() => metros.id),
    title: text('title').notNull(),
    gameType: text('game_type').notNull(),
    startsAt: text('starts_at').notNull(),
    location: text('location').notNull(),
    capacity: integer('capacity').notNull(),
    rsvpOpensAt: text('rsvp_opens_at').notNull().default(''),
    rsvpClosesAt: text('rsvp_closes_at').notNull().default(''),
    cancellationClosesAt: text('cancellation_closes_at').notNull().default(''),
    attendeeCount: integer('attendee_count').notNull().default(0),
    version: integer('version').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check('events_capacity_check', sql`${table.capacity} between 1 and 500`),
    check(
      'events_attendee_count_check',
      sql`${table.attendeeCount} between 0 and ${table.capacity}`,
    ),
    check(
      'events_rsvp_window_check',
      sql`${table.rsvpOpensAt} <= ${table.rsvpClosesAt} and ${table.rsvpClosesAt} <= ${table.startsAt}`,
    ),
    check(
      'events_cancel_window_check',
      sql`${table.cancellationClosesAt} <= ${table.startsAt}`,
    ),
    index('idx_events_starts_at').on(table.startsAt, table.id),
    index('idx_events_organizer_starts_at').on(
      table.organizerId,
      table.startsAt,
    ),
    index('idx_events_metro_starts_at').on(
      table.metroId,
      table.startsAt,
      table.id,
    ),
  ],
);

export const rsvps = sqliteTable(
  'rsvps',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.playerId] }),
    index('idx_rsvps_player_event').on(table.playerId, table.eventId),
  ],
);

export const rsvpHistory = sqliteTable(
  'rsvp_history',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id),
    playerId: text('player_id')
      .notNull()
      .references(() => users.id),
    action: text('action', { enum: ['reserved', 'canceled'] }).notNull(),
    occurredAt: text('occurred_at').notNull(),
    requestId: text('request_id'),
    eventVersion: integer('event_version').notNull(),
  },
  (table) => [
    check(
      'rsvp_history_action_check',
      sql`${table.action} in ('reserved', 'canceled')`,
    ),
    index('idx_rsvp_history_player_time').on(
      table.playerId,
      table.occurredAt,
      table.id,
    ),
    index('idx_rsvp_history_event_time').on(
      table.eventId,
      table.occurredAt,
      table.id,
    ),
    uniqueIndex('idx_rsvp_history_request')
      .on(table.eventId, table.playerId, table.requestId)
      .where(
        sql`${table.action} = 'reserved' and ${table.requestId} is not null`,
      ),
  ],
);

export const outboxEvents = sqliteTable(
  'outbox_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull(),
    occurredAt: text('occurred_at').notNull(),
  },
  (table) => [index('idx_outbox_event_id').on(table.eventId, table.id)],
);

export const rateLimits = sqliteTable(
  'rate_limits',
  {
    scope: text('scope').notNull(),
    windowStart: integer('window_start').notNull(),
    hits: integer('hits').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.windowStart] }),
    index('idx_rate_limits_expires_at').on(table.expiresAt),
  ],
);

export const appMetadata = sqliteTable('app_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
