import { ensureDatabase, getDatabase } from './database';
import { ApiError } from './api-error';
export { ApiError } from './api-error';
export { readJson } from './request-body';

export type Role = 'player' | 'organizer';
export type Actor = {
  id: string;
  name: string;
  role: Role;
  homeMetroId: string;
};

let rateLimitChecksUntilCleanup = 100;

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    const retryAfter =
      error.status === 429 &&
      error.details &&
      typeof error.details === 'object' &&
      'retryAfterSeconds' in error.details
        ? String(error.details.retryAfterSeconds)
        : undefined;
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      {
        status: error.status,
        headers: retryAfter ? { 'retry-after': retryAfter } : undefined,
      },
    );
  }
  console.error(error);
  return Response.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
      },
    },
    { status: 500 },
  );
}

export async function getActor(request: Request, requiredRole?: Role) {
  await ensureDatabase();
  const userId = request.headers.get('x-user-id');
  if (!userId)
    throw new ApiError(
      401,
      'IDENTITY_REQUIRED',
      'Choose who you are before continuing.',
    );

  const actor = await getDatabase()
    .prepare(
      'SELECT id, name, role, home_metro_id AS homeMetroId FROM users WHERE id = ?',
    )
    .bind(userId)
    .first<Actor>();
  if (!actor)
    throw new ApiError(401, 'UNKNOWN_IDENTITY', 'That user does not exist.');
  if (requiredRole && actor.role !== requiredRole) {
    throw new ApiError(
      403,
      'ROLE_FORBIDDEN',
      `Only ${requiredRole}s may perform this action.`,
    );
  }
  return actor;
}

export async function getOptionalActor(request: Request) {
  return request.headers.has('x-user-id') ? getActor(request) : undefined;
}

export async function enforceRateLimit(
  scope: string,
  limit: number,
  windowSeconds: number,
) {
  await ensureDatabase();
  const db = getDatabase();
  const now = Date.now();
  rateLimitChecksUntilCleanup -= 1;
  if (rateLimitChecksUntilCleanup === 0) {
    rateLimitChecksUntilCleanup = 100;
    await db
      .prepare('DELETE FROM rate_limits WHERE expires_at < ?')
      .bind(now)
      .run();
  }
  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(`INSERT INTO rate_limits (scope, window_start, hits, expires_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(scope, window_start) DO UPDATE SET hits = hits + 1
      RETURNING hits`)
    .bind(scope, windowStart, windowStart + windowMs * 2)
    .first<{ hits: number }>();
  if (Number(row?.hits ?? 0) > limit) {
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'Too many requests. Wait a moment and try again.',
      {
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowStart + windowMs - now) / 1000),
        ),
      },
    );
  }
}
