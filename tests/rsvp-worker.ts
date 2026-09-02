import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { reserveSeatSql } from '../lib/rsvp-sql.ts';

type WorkerInput = {
  databasePath: string;
  eventId: string;
  playerId: string;
  gate: SharedArrayBuffer;
};

const input = workerData as WorkerInput;
const gate = new Int32Array(input.gate);
parentPort?.postMessage({ type: 'ready' });
Atomics.wait(gate, 0, 0);

const db = new DatabaseSync(input.databasePath);
try {
  db.exec('PRAGMA busy_timeout = 10000;');
  const result = db.prepare(reserveSeatSql).get({
    1: input.eventId,
    2: input.playerId,
    3: `parallel-${input.playerId}`,
  });
  parentPort?.postMessage({ type: 'result', inserted: Boolean(result) });
} catch (error) {
  parentPort?.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  db.close();
}
