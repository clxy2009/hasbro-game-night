import { z } from 'zod';

import { buildChangePage, type OutboxChangeRow } from '@/lib/change-feed';
import { ensureDatabase, getDatabase } from '@/lib/server/database';
import { ApiError, errorResponse } from '@/lib/server/http';

const querySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  metroId: z.string().trim().max(64).default(''),
});

const pageSize = 200;

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      throw new ApiError(400, 'INVALID_QUERY', 'The change cursor is invalid.');

    const result = await getDatabase()
      .prepare(`SELECT o.id AS cursor, o.event_id AS eventId,
        o.event_version AS version, e.metro_id AS metroId
        FROM outbox_events o
        JOIN events e ON e.id = o.event_id
        WHERE o.id > ?
        ORDER BY o.id ASC
        LIMIT ?`)
      .bind(parsed.data.since, pageSize + 1)
      .all<OutboxChangeRow>();
    const page = buildChangePage(
      result.results,
      parsed.data.metroId,
      parsed.data.since,
      pageSize,
    );

    return Response.json(page, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
