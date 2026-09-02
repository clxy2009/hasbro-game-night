import { ensureDatabase, getDatabase } from '@/lib/server/database';
import { errorResponse } from '@/lib/server/http';
import type { User } from '@/lib/types';

export async function GET() {
  try {
    await ensureDatabase();
    const result = await getDatabase()
      .prepare(`SELECT id, name, role, home_metro_id AS homeMetroId FROM users
        ORDER BY CASE role WHEN 'player' THEN 0 ELSE 1 END, name`)
      .all<User>();
    return Response.json({ users: result.results });
  } catch (error) {
    return errorResponse(error);
  }
}
