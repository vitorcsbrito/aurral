import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { dbOps },
  { flowPlaylistConfig },
  { downloadTracker },
  { weeklyFlowWorker },
  { startWorkerIfPending },
] = await setupIsolatedBackend(
  "weekly-flow-startup-retry",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/weeklyFlow/weeklyFlowScheduler.js",
);

await downloadTracker.init();

test.beforeEach(async () => {
  downloadTracker.clearAll();
  await resetDatabase();
  await dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("startup leaves failed tracks terminal", async () => {
  const playlist = await flowPlaylistConfig.createSharedPlaylist({
    name: "Incomplete",
    tracks: [{ artistName: "Missing", trackName: "Leave Failed" }],
  });
  const failedId = downloadTracker.addJob(
    { artistName: "Missing", trackName: "Leave Failed" },
    playlist.id,
  );
  downloadTracker.setFailed(failedId, "not found");

  let starts = 0;
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => {
    starts += 1;
  };
  try {
    await startWorkerIfPending();
  } finally {
    weeklyFlowWorker.start = originalStart;
  }

  assert.equal(starts, 0);
  assert.equal(downloadTracker.getJob(failedId)?.status, "failed");
});

test("startup resumes pending work", async () => {
  const playlist = await flowPlaylistConfig.createSharedPlaylist({
    name: "Pending work",
    tracks: [{ artistName: "Pending", trackName: "Resume Me" }],
  });
  const pendingId = downloadTracker.addJob(
    { artistName: "Pending", trackName: "Resume Me" },
    playlist.id,
  );

  let starts = 0;
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => {
    starts += 1;
  };
  try {
    await startWorkerIfPending();
  } finally {
    weeklyFlowWorker.start = originalStart;
  }

  assert.equal(starts, 1);
  assert.equal(downloadTracker.getJob(pendingId)?.status, "pending");
});
