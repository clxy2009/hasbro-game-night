import { z } from 'zod';

import { readSnapshotAfterCursor } from '@/lib/change-feed';
import { eventMetroScope } from '@/lib/event-filters';
import { createEventSchema } from '@/lib/event-input';
import { ensureDatabase, getDatabase } from '@/lib/server/database';
import {
  ApiError,
  enforceRateLimit,
  errorResponse,
  getActor,
  getOptionalActor,
  readJson,
} from '@/lib/server/http';
import type { GameEvent } from '@/lib/types';

type EventRow = Omit<GameEvent, 'isRsvped'> & { isRsvped: number };

const listQuerySchema = z.object({
  search: z.string().trim().max(80).default(''),
  gameType: z.string().trim().max(60).default(''),
  organizerId: z.string().trim().max(100).default(''),
  metroId: z.string().trim().max(64).default(''),
  mine: z.enum(['true', 'false']).default('false'),
});

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const parsed = listQuerySchema.safeParse(
      Object.fromEntries(url.searchParams),
    );
    if (!parsed.success) {
      throw new ApiError(
        400,
        'INVALID_QUERY',
        'The event filters are invalid.',
        z.treeifyError(parsed.error),
      );
    }
    const query = parsed.data;
    const mine = query.mine === 'true';
    const effectiveMetroId = eventMetroScope(mine, query.metroId);
    const viewer = mine
      ? await getActor(request, 'player')
      : await getOptionalActor(request);
    const viewerId = viewer?.id ?? '';

    const now = new Date().toISOString();
    const { cursor, snapshot: result } = await readSnapshotAfterCursor(
      async () => {
        const row = await getDatabase()
          .prepare('SELECT COALESCE(MAX(id), 0) AS cursor FROM outbox_events')
          .first<{ cursor: number }>();
        return Number(row?.cursor ?? 0);
      },
      () =>
        getDatabase()
          .prepare(`
        SELECT
          e.id,
          e.organizer_id AS organizerId,
          organizer.name AS organizerName,
          e.metro_id AS metroId,
          metro.name AS metroName,
          metro.timezone,
          e.title,
          e.game_type AS gameType,
          e.starts_at AS startsAt,
          e.location,
          e.capacity,
          e.attendee_count AS attendeeCount,
          e.rsvp_opens_at AS rsvpOpensAt,
          e.rsvp_closes_at AS rsvpClosesAt,
          e.cancellation_closes_at AS cancellationClosesAt,
          e.version,
          CASE WHEN ?1 <> '' AND EXISTS (
            SELECT 1 FROM rsvps own
            WHERE own.event_id = e.id AND own.player_id = ?1
          ) THEN 1 ELSE 0 END AS isRsvped,
          (SELECT own.request_id FROM rsvps own
            WHERE own.event_id = e.id AND own.player_id = ?1
          ) AS rsvpVersion
        FROM events e
        JOIN users organizer ON organizer.id = e.organizer_id
        JOIN metros metro ON metro.id = e.metro_id
        WHERE e.starts_at > ?2
          AND (?3 = '' OR LOWER(e.title) LIKE '%' || LOWER(?3) || '%'
            OR LOWER(e.game_type) LIKE '%' || LOWER(?3) || '%'
            OR LOWER(e.location) LIKE '%' || LOWER(?3) || '%')
          AND (?4 = '' OR e.game_type = ?4)
          AND (?5 = '' OR e.organizer_id = ?5)
          AND (?6 = 0 OR EXISTS (
            SELECT 1 FROM rsvps mine
            WHERE mine.event_id = e.id AND mine.player_id = ?1
          ))
          AND (?7 = '' OR e.metro_id = ?7)
        ORDER BY e.starts_at ASC, e.id ASC
        LIMIT 100
      `)
          .bind(
            viewerId,
            now,
            query.search,
            query.gameType,
            query.organizerId,
            mine ? 1 : 0,
            effectiveMetroId,
          )
          .all<EventRow>(),
    );

    const gameTypes = await getDatabase()
      .prepare(`SELECT DISTINCT game_type AS gameType FROM events
        WHERE starts_at > ? AND (? = '' OR metro_id = ?) ORDER BY game_type ASC`)
      .bind(now, effectiveMetroId, effectiveMetroId)
      .all<{ gameType: string }>();

    return Response.json(
      {
        events: result.results.map((event) => ({
          ...event,
          isRsvped: Boolean(event.isRsvped),
        })),
        gameTypes: gameTypes.results.map((row) => row.gameType),
        changeCursor: cursor,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const organizer = await getActor(request, 'organizer');
    await enforceRateLimit(`event-create:${organizer.id}`, 10, 60 * 60);
    const parsed = createEventSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new ApiError(
        422,
        'VALIDATION_ERROR',
        'Please correct the highlighted event details.',
        z.treeifyError(parsed.error),
      );
    }

    const input = parsed.data;
    const now = new Date();
    const startsAt = new Date(input.startsAt);
    const rsvpOpensAt = new Date(input.rsvpOpensAt ?? now.toISOString());
    const rsvpClosesAt = new Date(input.rsvpClosesAt ?? input.startsAt);
    const cancellationClosesAt = new Date(
      input.cancellationClosesAt ?? input.startsAt,
    );

    if (startsAt.getTime() <= now.getTime()) {
      throw new ApiError(
        422,
        'PAST_DATE',
        'Event date and time must be in the future.',
      );
    }
    if (rsvpOpensAt.getTime() > rsvpClosesAt.getTime()) {
      throw new ApiError(
        422,
        'INVALID_RSVP_WINDOW',
        'RSVP opening must be before its closing time.',
      );
    }
    if (
      rsvpClosesAt.getTime() > startsAt.getTime() ||
      rsvpClosesAt.getTime() <= now.getTime()
    ) {
      throw new ApiError(
        422,
        'INVALID_RSVP_CUTOFF',
        'RSVP closing must be in the future and no later than event start.',
      );
    }
    if (
      cancellationClosesAt.getTime() > startsAt.getTime() ||
      cancellationClosesAt.getTime() <= now.getTime()
    ) {
      throw new ApiError(
        422,
        'INVALID_CANCELLATION_CUTOFF',
        'Cancellation closing must be in the future and no later than event start.',
      );
    }

    const metro = await getDatabase()
      .prepare('SELECT id, name, timezone FROM metros WHERE id = ?')
      .bind(input.metroId ?? organizer.homeMetroId)
      .first<{ id: string; name: string; timezone: string }>();
    if (!metro)
      throw new ApiError(
        422,
        'UNKNOWN_METRO',
        'Choose a supported metro area.',
      );

    const event = {
      id: crypto.randomUUID(),
      organizerId: organizer.id,
      organizerName: organizer.name,
      metroId: metro.id,
      metroName: metro.name,
      timezone: metro.timezone,
      title: input.title,
      gameType: input.gameType,
      startsAt: startsAt.toISOString(),
      location: input.location,
      capacity: input.capacity,
      attendeeCount: 0,
      rsvpOpensAt: rsvpOpensAt.toISOString(),
      rsvpClosesAt: rsvpClosesAt.toISOString(),
      cancellationClosesAt: cancellationClosesAt.toISOString(),
      version: 0,
      isRsvped: false,
      rsvpVersion: null,
    };

    await getDatabase()
      .prepare(`INSERT INTO events
        (id, organizer_id, metro_id, title, game_type, starts_at, location, capacity,
          rsvp_opens_at, rsvp_closes_at, cancellation_closes_at, attendee_count, version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`)
      .bind(
        event.id,
        organizer.id,
        event.metroId,
        event.title,
        event.gameType,
        event.startsAt,
        event.location,
        event.capacity,
        event.rsvpOpensAt,
        event.rsvpClosesAt,
        event.cancellationClosesAt,
        now.toISOString(),
      )
      .run();

    return Response.json({ event }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
