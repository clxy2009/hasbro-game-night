import { z } from 'zod';

import { getDatabase } from '@/lib/server/database';
import { ApiError, errorResponse, getActor } from '@/lib/server/http';
import type { RsvpHistoryItem } from '@/lib/types';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request) {
  try {
    const player = await getActor(request, 'player');
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_QUERY',
        'The history request is invalid.',
      );

    const result = await getDatabase()
      .prepare(`SELECT h.id, h.event_id AS eventId, e.title AS eventTitle,
        e.game_type AS gameType, e.location, e.starts_at AS startsAt,
        h.action, h.occurred_at AS occurredAt, h.event_version AS eventVersion
        FROM rsvp_history h
        JOIN events e ON e.id = h.event_id
        WHERE h.player_id = ?
        ORDER BY h.occurred_at DESC, h.id DESC
        LIMIT ?`)
      .bind(player.id, parsed.data.limit)
      .all<RsvpHistoryItem>();

    return Response.json(
      { history: result.results },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
