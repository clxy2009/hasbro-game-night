export type OutboxChangeRow = {
  cursor: number;
  eventId: string;
  version: number;
  metroId: string;
};

export type ChangePage = {
  cursor: number;
  hasMore: boolean;
  changes: Array<{ eventId: string; version: number }>;
};

export function nextChangePollDelay(
  consecutiveFailures: number,
  random = Math.random(),
) {
  if (consecutiveFailures <= 0) return 4200 + random * 1600;
  const ceiling = Math.min(60_000, 4000 * 2 ** (consecutiveFailures - 1));
  return ceiling / 2 + random * (ceiling / 2);
}

export async function readSnapshotAfterCursor<T>(
  readCursor: () => Promise<number>,
  readSnapshot: () => Promise<T>,
) {
  const cursor = await readCursor();
  const snapshot = await readSnapshot();
  return { cursor, snapshot };
}

export function buildChangePage(
  rows: OutboxChangeRow[],
  metroId: string,
  since: number,
  pageSize: number,
) {
  const page = rows.slice(0, pageSize);
  const changesByEvent = new Map<string, number>();
  for (const change of page) {
    if (!metroId || change.metroId === metroId) {
      changesByEvent.set(change.eventId, change.version);
    }
  }

  return {
    cursor: page.at(-1)?.cursor ?? since,
    hasMore: rows.length > pageSize,
    changes: Array.from(changesByEvent, ([eventId, version]) => ({
      eventId,
      version,
    })),
  };
}

export async function synchronizeChangePages(options: {
  startingCursor: number;
  maximumPages?: number;
  fetchPage: (since: number) => Promise<ChangePage>;
  applyChanges: (
    changes: Array<{ eventId: string; version: number }>,
  ) => Promise<number> | number;
}) {
  const maximumPages = options.maximumPages ?? 10;
  if (!Number.isInteger(maximumPages) || maximumPages < 1) {
    throw new Error('maximumPages must be a positive integer.');
  }

  let candidateCursor = options.startingCursor;
  let hasMore = false;
  let pages = 0;
  const changedEvents = new Map<string, number>();

  do {
    const page = await options.fetchPage(candidateCursor);
    if (
      !Number.isSafeInteger(page.cursor) ||
      page.cursor < candidateCursor ||
      (page.hasMore && page.cursor === candidateCursor)
    ) {
      throw new Error('The change feed returned a non-advancing cursor.');
    }
    candidateCursor = page.cursor;
    for (const change of page.changes) {
      changedEvents.set(change.eventId, change.version);
    }
    hasMore = page.hasMore;
    pages += 1;
  } while (hasMore && pages < maximumPages);

  if (changedEvents.size) {
    const appliedCursor = await options.applyChanges(
      Array.from(changedEvents, ([eventId, version]) => ({ eventId, version })),
    );
    if (
      !Number.isSafeInteger(appliedCursor) ||
      appliedCursor < candidateCursor
    ) {
      throw new Error('The applied snapshot is older than the change batch.');
    }
    candidateCursor = appliedCursor;
  }

  return { cursor: candidateCursor, hasMore };
}
