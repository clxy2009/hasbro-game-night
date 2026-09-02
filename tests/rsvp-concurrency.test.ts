import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { rsvpTriggerStatements } from '../lib/server/database-ddl.ts';

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; inserted: boolean }
  | { type: 'error'; message: string };

void test('parallel database writers cannot overbook the final seat', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'game-night-rsvp-'));
  const databasePath = join(directory, 'concurrency.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      starts_at TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      rsvp_opens_at TEXT NOT NULL,
      rsvp_closes_at TEXT NOT NULL,
      cancellation_closes_at TEXT NOT NULL,
      attendee_count INTEGER NOT NULL DEFAULT 0 CHECK (attendee_count BETWEEN 0 AND capacity),
      version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE rsvps (
      event_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, player_id)
    );
    CREATE TABLE rsvp_history (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      action TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      request_id TEXT,
      event_version INTEGER NOT NULL
    );
    CREATE TABLE outbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);
  for (const statement of rsvpTriggerStatements) db.exec(statement);
  const now = new Date();
  db.prepare(`INSERT INTO events
    (id, starts_at, capacity, rsvp_opens_at, rsvp_closes_at, cancellation_closes_at)
    VALUES (?, ?, 1, ?, ?, ?)`).run(
    'parallel-last-seat',
    new Date(now.getTime() + 86_400_000).toISOString(),
    new Date(now.getTime() - 60_000).toISOString(),
    new Date(now.getTime() + 43_200_000).toISOString(),
    new Date(now.getTime() + 43_200_000).toISOString(),
  );
  db.close();

  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const gate = new Int32Array(gateBuffer);
  const workerCount = 24;
  let readyCount = 0;
  const workerInstances: Worker[] = [];
  const workers = Array.from(
    { length: workerCount },
    (_, index) =>
      new Promise<boolean>((resolve, reject) => {
        let inserted: boolean | undefined;
        const worker = new Worker(
          new URL('./rsvp-worker.ts', import.meta.url),
          {
            execArgv: ['--no-warnings', '--experimental-strip-types'],
            workerData: {
              databasePath,
              eventId: 'parallel-last-seat',
              playerId: `parallel-player-${index}`,
              gate: gateBuffer,
            },
          },
        );
        workerInstances.push(worker);
        worker.on('message', (message: WorkerMessage) => {
          if (message.type === 'ready') {
            readyCount += 1;
            if (readyCount === workerCount) {
              Atomics.store(gate, 0, 1);
              Atomics.notify(gate, 0, workerCount);
            }
          } else if (message.type === 'result') {
            inserted = message.inserted;
          } else {
            reject(new Error(message.message));
          }
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0)
            reject(new Error(`RSVP worker exited with code ${code}.`));
          else if (inserted !== undefined) resolve(inserted);
          else reject(new Error('RSVP worker exited without a result.'));
        });
      }),
  );

  try {
    const results = await Promise.all(workers);
    assert.equal(results.filter(Boolean).length, 1);

    const verification = new DatabaseSync(databasePath);
    const row = verification
      .prepare(`SELECT attendee_count AS attendeeCount, version,
        (SELECT COUNT(*) FROM rsvps WHERE event_id = events.id) AS rowCount
        FROM events WHERE id = ?`)
      .get('parallel-last-seat');
    verification.close();
    assert.equal(row?.attendeeCount, 1);
    assert.equal(row?.rowCount, 1);
    assert.equal(row?.version, 1);
  } finally {
    await Promise.all(workerInstances.map((worker) => worker.terminate()));
    try {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch {
      // node:sqlite can retain a Windows mapping until process exit even after
      // every worker closes. The test database lives under the OS temp folder.
    }
  }
});
