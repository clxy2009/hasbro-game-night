import { ensureDatabase, getDatabase } from '@/lib/server/database';
import { errorResponse } from '@/lib/server/http';
import type { Metro } from '@/lib/types';

export async function GET() {
  try {
    await ensureDatabase();
    const result = await getDatabase()
      .prepare('SELECT id, slug, name, timezone FROM metros ORDER BY name')
      .all<Metro>();
    return Response.json({ metros: result.results });
  } catch (error) {
    return errorResponse(error);
  }
}
