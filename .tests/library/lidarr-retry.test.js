import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, honkerDb, libraryManagerModule, systemTaskWorker] =
  await setupIsolatedBackend(
    "lidarr-retry",
    "backend/services/honkerDb.js",
    "backend/services/libraryManager.js",
    "backend/services/systemTaskWorker.js",
  );
const { lidarrClient } = await import("../../backend/services/lidarrClient.js");
const { libraryManager } = libraryManagerModule;

// Honker keeps its queue in its own SQLite file, not in Postgres.
function getPendingRetryJobs() {
  return honkerDb
    .getHonkerDb()
    .query(
      `
        SELECT id, payload
        FROM _honker_live
        WHERE queue = 'system-task' AND state = 'pending'
      `,
      [],
    )
    .filter((row) => JSON.parse(row.payload)?.kind === "lidarr-retry");
}

function setHonkerJobRunAt(jobId, runAt) {
  const tx = honkerDb.getHonkerDb().transaction();
  try {
    tx.execute("UPDATE _honker_live SET run_at = ? WHERE id = ?", [runAt, jobId]);
    tx.commit();
  } catch (error) {
    try {
      tx.rollback();
    } catch {}
    throw error;
  }
}

async function settleRetryEnqueues() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("unavailable Lidarr keeps one retry job and continues its retry chain", async (t) => {
  t.mock.method(lidarrClient, "isConfigured", () => true);
  const request = t.mock.method(lidarrClient, "request", async () => {
    throw new Error("provider unavailable");
  });
  const queue = honkerDb.getSystemTaskQueue();
  const backlogRunAt = Math.floor(Date.now() / 1000) + 3600;
  for (let index = 0; index < 101; index += 1) {
    queue.enqueue({ kind: `older-system-task-${index}` }, { runAt: backlogRunAt });
  }

  await libraryManager.syncLidarrArtists();
  for (let index = 0; index < 5; index += 1) {
    await libraryManager.syncLidarrArtists();
    await libraryManager.getRecentArtists();
  }
  await settleRetryEnqueues();

  const firstRetryJobs = getPendingRetryJobs();
  assert.equal(firstRetryJobs.length, 1);
  assert.equal(request.mock.callCount(), 1);

  await systemTaskWorker.stopSystemTaskWorker();
  const firstRetryJob = firstRetryJobs[0];
  setHonkerJobRunAt(firstRetryJob.id, Math.floor(Date.now() / 1000) - 1);
  const claimedRetry = queue.claimOne(honkerDb.getWorkerId());
  assert.equal(claimedRetry?.id, firstRetryJob.id);

  await systemTaskWorker.processSystemTask(
    { kind: "lidarr-retry" },
    claimedRetry,
  );
  await settleRetryEnqueues();

  const successorJobs = getPendingRetryJobs();
  assert.equal(request.mock.callCount(), 2);
  assert.equal(successorJobs.length, 1);
  assert.notEqual(successorJobs[0].id, claimedRetry.id);

  claimedRetry.ack();
  queue.cancel(successorJobs[0].id);
  await systemTaskWorker.stopSystemTaskWorker();
});
