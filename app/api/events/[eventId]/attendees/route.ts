import { getDatabase } from '@/lib/server/database';
import { ApiError, errorResponse, getActor } from '@/lib/server/http';
import type { Attendee } from '@/lib/types';

export async function GET(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const organizer = await getActor(request, 'organizer');
    const { eventId } = await context.params;
    const event = await getDatabase()
      .prepare('SELECT organizer_id AS organizerId FROM events WHERE id = ?')
      .bind(eventId)
      .first<{ organizerId: string }>();
    if (!event)
      throw new ApiError(
        404,
        'EVENT_NOT_FOUND',
        'That event could not be found.',
      );
    if (event.organizerId !== organizer.id) {
      throw new ApiError(
        403,
        'NOT_EVENT_OWNER',
        'Organizers may only view attendees for their own events.',
      );
    }
    const result = await getDatabase()
      .prepare(`SELECT users.id, users.name, rsvps.created_at AS rsvpedAt
        FROM rsvps JOIN users ON users.id = rsvps.player_id
        WHERE rsvps.event_id = ? ORDER BY rsvps.created_at ASC`)
      .bind(eventId)
      .all<Attendee>();
    return Response.json({ attendees: result.results });
  } catch (error) {
    return errorResponse(error);
  }
}
