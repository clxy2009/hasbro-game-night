import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChangePage,
  readSnapshotAfterCursor,
  synchronizeChangePages,
  type OutboxChangeRow,
} from '../lib/change-feed.ts';

void test('the snapshot protocol captures its cursor before reading state', async () => {
  const calls: string[] = [];
  const result = await readSnapshotAfterCursor(
    async () => {
      calls.push('cursor');
      return 41;
    },
    async () => {
      calls.push('snapshot');
      return { attendeeCount: 7 };
    },
  );

  assert.deepEqual(calls, ['cursor', 'snapshot']);
  assert.deepEqual(result, {
    cursor: 41,
    snapshot: { attendeeCount: 7 },
  });
});

void test('a full change page advances only through rows it returned', () => {
  const rows: OutboxChangeRow[] = Array.from({ length: 201 }, (_, index) => ({
    cursor: index + 1,
    eventId: `event-${index + 1}`,
    version: 1,
    metroId: 'metro-seattle',
  }));

  const first = buildChangePage(rows, 'metro-seattle', 0, 200);
  assert.equal(first.cursor, 200);
  assert.equal(first.hasMore, true);
  assert.equal(first.changes.length, 200);

  const second = buildChangePage(rows.slice(200), 'metro-seattle', 200, 200);
  assert.equal(second.cursor, 201);
  assert.equal(second.hasMore, false);
  assert.deepEqual(second.changes, [{ eventId: 'event-201', version: 1 }]);
});

void test('irrelevant metros advance the cursor without producing false changes', () => {
  const rows: OutboxChangeRow[] = [
    {
      cursor: 11,
      eventId: 'portland-event',
      version: 3,
      metroId: 'metro-portland',
    },
    {
      cursor: 12,
      eventId: 'seattle-event',
      version: 5,
      metroId: 'metro-seattle',
    },
  ];

  assert.deepEqual(buildChangePage(rows, 'metro-seattle', 10, 200), {
    cursor: 12,
    hasMore: false,
    changes: [{ eventId: 'seattle-event', version: 5 }],
  });
});

void test('an empty metro scope returns changes from every metro', () => {
  const rows: OutboxChangeRow[] = [
    {
      cursor: 71,
      eventId: 'portland-event',
      version: 1,
      metroId: 'metro-portland',
    },
    {
      cursor: 72,
      eventId: 'seattle-event',
      version: 2,
      metroId: 'metro-seattle',
    },
  ];

  assert.deepEqual(buildChangePage(rows, '', 70, 200), {
    cursor: 72,
    hasMore: false,
    changes: [
      { eventId: 'portland-event', version: 1 },
      { eventId: 'seattle-event', version: 2 },
    ],
  });
});

void test('a later page failure does not expose a cursor to commit', async () => {
  let committedCursor = 10;

  await assert.rejects(async () => {
    const synchronized = await synchronizeChangePages({
      startingCursor: committedCursor,
      fetchPage: async (since) => {
        if (since === 10) {
          return {
            cursor: 11,
            hasMore: true,
            changes: [{ eventId: 'event-1', version: 2 }],
          };
        }
        throw new Error('page unavailable');
      },
      applyChanges: async () => committedCursor,
    });
    committedCursor = synchronized.cursor;
  }, /page unavailable/);

  assert.equal(committedCursor, 10);
});

void test('a snapshot application failure does not expose a cursor to commit', async () => {
  let committedCursor = 20;

  await assert.rejects(async () => {
    const synchronized = await synchronizeChangePages({
      startingCursor: committedCursor,
      fetchPage: async () => ({
        cursor: 21,
        hasMore: false,
        changes: [{ eventId: 'event-2', version: 4 }],
      }),
      applyChanges: async () => {
        throw new Error('snapshot unavailable');
      },
    });
    committedCursor = synchronized.cursor;
  }, /snapshot unavailable/);

  assert.equal(committedCursor, 20);
});

void test('the cursor is returned only after all pages and state apply', async () => {
  const calls: string[] = [];
  const synchronized = await synchronizeChangePages({
    startingCursor: 30,
    fetchPage: async (since) => {
      calls.push(`fetch:${since}`);
      return since === 30
        ? {
            cursor: 31,
            hasMore: true,
            changes: [{ eventId: 'event-3', version: 1 }],
          }
        : {
            cursor: 32,
            hasMore: false,
            changes: [{ eventId: 'event-3', version: 2 }],
          };
    },
    applyChanges: async (changes) => {
      calls.push(`apply:${changes.map(({ eventId }) => eventId).join(',')}`);
      return 35;
    },
  });

  assert.deepEqual(calls, ['fetch:30', 'fetch:31', 'apply:event-3']);
  assert.deepEqual(synchronized, { cursor: 35, hasMore: false });
});

void test('a snapshot older than the consumed change batch is rejected', async () => {
  await assert.rejects(
    () =>
      synchronizeChangePages({
        startingCursor: 40,
        fetchPage: async () => ({
          cursor: 41,
          hasMore: false,
          changes: [{ eventId: 'event-4', version: 3 }],
        }),
        applyChanges: async () => 40,
      }),
    /snapshot is older/,
  );
});
