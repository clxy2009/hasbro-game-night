import {
  acceptsActiveRequest,
  cancelSeatSql,
  parseRsvpPrecondition,
  reserveSeatSql,
  rsvpEtag,
} from '@/lib/rsvp-sql';
import { getDatabase } from '@/lib/server/database';
import {
  ApiError,
  enforceRateLimit,
  errorResponse,
  getActor,
} from '@/lib/server/http';

type RsvpRow = {
  eventId: string;
  playerId: string;
  createdAt: string;
  requestId: string;
};
type ActiveRsvpRow = Omit<RsvpRow, 'requestId'> & {
  requestId: string | null;
};
type HistoricalRsvpRow = RsvpRow & { eventVersion: number };
type EventAvailability = {
  startsAt: string;
  rsvpOpensAt: string;
  rsvpClosesAt: string;
  cancellationClosesAt: string;
  capacity: number;
  attendeeCount: number;
  version: number;
};

type RequestIdentity = { id: string; supplied: boolean };

function requestIdentity(request: Request): RequestIdentity {
  const supplied = request.headers.get('idempotency-key')?.trim();
  if (!supplied) return { id: crypto.randomUUID(), supplied: false };
  if (supplied.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(supplied)) {
    throw new ApiError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'The idempotency key is invalid.',
    );
  }
  return { id: supplied, supplied: true };
}

function validatedEventId(value: string) {
  if (!value || value.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new ApiError(400, 'INVALID_EVENT_ID', 'The event ID is invalid.');
  }
  return value;
}

function requireMatchingActiveRequest(
  active: ActiveRsvpRow,
  identity: RequestIdentity,
) {
  if (!acceptsActiveRequest(active.requestId, identity.id, identity.supplied)) {
    throw new ApiError(
      409,
      'ALREADY_RSVPED',
      'You already have an active RSVP for this event.',
    );
  }
}

function publicRsvp(active: ActiveRsvpRow): RsvpRow {
  if (!active.requestId) {
    throw new ApiError(
      500,
      'RSVP_VERSION_MISSING',
      'The reservation is missing its concurrency version.',
    );
  }
  return {
    eventId: active.eventId,
    playerId: active.playerId,
    createdAt: active.createdAt,
    requestId: active.requestId,
  };
}

function activeRsvpResponse(
  body: Record<string, unknown>,
  active: ActiveRsvpRow | RsvpRow,
  status = 200,
) {
  if (!active.requestId) {
    throw new ApiError(
      500,
      'RSVP_VERSION_MISSING',
      'The reservation is missing its concurrency version.',
    );
  }
  return Response.json(body, {
    status,
    headers: { etag: rsvpEtag(active.requestId) },
  });
}

async function availability(eventId: string) {
  return getDatabase()
    .prepare(`SELECT starts_at AS startsAt, rsvp_opens_at AS rsvpOpensAt,
      rsvp_closes_at AS rsvpClosesAt, cancellation_closes_at AS cancellationClosesAt,
      capacity, attendee_count AS attendeeCount, version
      FROM events WHERE id = ?`)
    .bind(eventId)
    .first<EventAvailability>();
}

async function historicalRsvp(
  eventId: string,
  playerId: string,
  idempotencyKey: string,
) {
  return getDatabase()
    .prepare(`SELECT event_id AS eventId, player_id AS playerId,
      occurred_at AS createdAt, request_id AS requestId,
      event_version AS eventVersion
      FROM rsvp_history
      WHERE event_id = ? AND player_id = ? AND action = 'reserved' AND request_id = ?`)
    .bind(eventId, playerId, idempotencyKey)
    .first<HistoricalRsvpRow>();
}

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const player = await getActor(request, 'player');
    const eventId = validatedEventId((await context.params).eventId);
    const db = getDatabase();
    const identity = requestIdentity(request);
    await enforceRateLimit(`rsvp:${player.id}`, 60, 60);
    const initialEvent = await availability(eventId);
    if (!initialEvent)
      throw new ApiError(
        404,
        'EVENT_NOT_FOUND',
        'That event could not be found.',
      );
    await enforceRateLimit(`rsvp:${player.id}:${eventId}`, 20, 60);
    if (identity.supplied) {
      const completed = await historicalRsvp(eventId, player.id, identity.id);
      if (completed)
        return Response.json({
          rsvp: completed,
          event: initialEvent,
          idempotent: true,
          replayed: true,
        });
    }
    const existing = await db
      .prepare(`SELECT event_id AS eventId, player_id AS playerId,
        request_id AS requestId, created_at AS createdAt
        FROM rsvps WHERE event_id = ? AND player_id = ?`)
      .bind(eventId, player.id)
      .first<ActiveRsvpRow>();
    if (existing) {
      requireMatchingActiveRequest(existing, identity);
      return activeRsvpResponse(
        {
          rsvp: publicRsvp(existing),
          event: initialEvent,
          idempotent: true,
        },
        existing,
      );
    }

    const inserted = await db
      .prepare(reserveSeatSql)
      .bind(eventId, player.id, identity.id)
      .first<RsvpRow>();
    if (inserted) {
      const event = await availability(eventId);
      return activeRsvpResponse(
        { rsvp: inserted, event, idempotent: false },
        inserted,
        201,
      );
    }

    const retry = await db
      .prepare(`SELECT event_id AS eventId, player_id AS playerId,
        request_id AS requestId, created_at AS createdAt
        FROM rsvps WHERE event_id = ? AND player_id = ?`)
      .bind(eventId, player.id)
      .first<ActiveRsvpRow>();
    if (retry) {
      requireMatchingActiveRequest(retry, identity);
      return activeRsvpResponse(
        {
          rsvp: publicRsvp(retry),
          event: await availability(eventId),
          idempotent: true,
        },
        retry,
      );
    }

    const historicalRetry = await historicalRsvp(
      eventId,
      player.id,
      identity.id,
    );
    if (historicalRetry)
      return Response.json({
        rsvp: historicalRetry,
        event: await availability(eventId),
        idempotent: true,
        replayed: true,
      });

    const event = await availability(eventId);
    if (!event)
      throw new ApiError(
        404,
        'EVENT_NOT_FOUND',
        'That event could not be found.',
      );
    const currentTime = Date.now();
    if (new Date(event.startsAt).getTime() <= currentTime) {
      throw new ApiError(
        409,
        'EVENT_STARTED',
        'This event has already started.',
      );
    }
    if (new Date(event.rsvpOpensAt).getTime() > currentTime) {
      throw new ApiError(409, 'RSVP_NOT_OPEN', 'RSVPs are not open yet.');
    }
    if (new Date(event.rsvpClosesAt).getTime() <= currentTime) {
      throw new ApiError(
        409,
        'RSVP_CLOSED',
        'RSVPs are closed for this event.',
      );
    }
    throw new ApiError(
      409,
      'EVENT_FULL',
      'This event just filled up. Choose another table.',
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  try {
    const player = await getActor(request, 'player');
    const eventId = validatedEventId((await context.params).eventId);
    const precondition = parseRsvpPrecondition(request.headers.get('if-match'));
    if (precondition.kind === 'missing') {
      throw new ApiError(
        428,
        'RSVP_PRECONDITION_REQUIRED',
        'Refresh this event before canceling the reservation.',
      );
    }
    if (precondition.kind === 'invalid') {
      throw new ApiError(
        400,
        'INVALID_RSVP_PRECONDITION',
        'The reservation precondition is invalid.',
      );
    }
    await enforceRateLimit(`rsvp:${player.id}`, 60, 60);
    const initialEvent = await availability(eventId);
    if (!initialEvent)
      throw new ApiError(
        404,
        'EVENT_NOT_FOUND',
        'That event could not be found.',
      );
    await enforceRateLimit(`rsvp:${player.id}:${eventId}`, 20, 60);
    const db = getDatabase();
    const result = await db
      .prepare(cancelSeatSql)
      .bind(eventId, player.id, precondition.version)
      .first();
    if (result)
      return Response.json({
        canceled: true,
        event: await availability(eventId),
      });

    const event = await availability(eventId);
    if (!event)
      throw new ApiError(
        404,
        'EVENT_NOT_FOUND',
        'That event could not be found.',
      );
    const existing = await db
      .prepare(
        'SELECT request_id AS requestId FROM rsvps WHERE event_id = ? AND player_id = ?',
      )
      .bind(eventId, player.id)
      .first<{ requestId: string | null }>();
    if (existing && existing.requestId !== precondition.version) {
      throw new ApiError(
        412,
        'RSVP_CHANGED',
        'This reservation changed. Refresh before canceling it.',
      );
    }
    if (!existing) {
      const completed = await db
        .prepare(`SELECT 1 AS present FROM rsvp_history
          WHERE event_id = ? AND player_id = ?
            AND action = 'canceled' AND request_id = ?`)
        .bind(eventId, player.id, precondition.version)
        .first();
      if (completed) {
        return Response.json({ canceled: true, replayed: true, event });
      }
      throw new ApiError(
        412,
        'RSVP_CHANGED',
        'This reservation no longer exists. Refresh before retrying.',
      );
    }
    if (new Date(event.cancellationClosesAt).getTime() <= Date.now()) {
      throw new ApiError(
        409,
        'CANCELLATION_CLOSED',
        'The cancellation window has closed. Contact the organizer.',
      );
    }
    throw new ApiError(
      409,
      'RSVP_CANCEL_CONFLICT',
      'The reservation could not be canceled. Refresh and try again.',
    );
  } catch (error) {
    return errorResponse(error);
  }
}
