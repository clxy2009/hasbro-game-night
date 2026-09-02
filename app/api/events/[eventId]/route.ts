import { ensureDatabase, getDatabase } from '@/lib/server/database';
import { ApiError, errorResponse, getOptionalActor } from '@/lib/server/http';
import type { GameEvent } from '@/lib/types';

type EventRow = Omit<GameEvent, 'isRsvped'> & { isRsvped: number };

export async function GET(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    await ensureDatabase();
    const { eventId } = await context.params;
    const viewerId = (await getOptionalActor(request))?.id ?? '';
    const event = await getDatabase()
      .prepare(`SELECT
        e.id, e.organizer_id AS organizerId, organizer.name AS organizerName,
        e.metro_id AS metroId, metro.name AS metroName, metro.timezone,
        e.title, e.game_type AS gameType, e.starts_at AS startsAt,
        e.location, e.capacity, e.attendee_count AS attendeeCount,
        e.rsvp_opens_at AS rsvpOpensAt, e.rsvp_closes_at AS rsvpClosesAt,
        e.cancellation_closes_at AS cancellationClosesAt, e.version,
        CASE WHEN ?2 <> '' AND EXISTS (
          SELECT 1 FROM rsvps own WHERE own.event_id = e.id AND own.player_id = ?2
        ) THEN 1 ELSE 0 END AS isRsvped,
        (SELECT own.request_id FROM rsvps own
          WHERE own.event_id = e.id AND own.player_id = ?2
        ) AS rsvpVersion
        FROM events e
        JOIN users organizer ON organizer.id = e.organizer_id
        JOIN metros metro ON metro.id = e.metro_id
        WHERE e.id = ?1
      `)
      .bind(eventId, viewerId)
      .first<EventRow>();
    if (!event)
      throw new ApiError(
        404,
        'EVENT_NOT_FOUND',
        'That event could not be found.',
      );
    return Response.json(
      { event: { ...event, isRsvped: Boolean(event.isRsvped) } },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
