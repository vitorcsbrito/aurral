import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  {
    buildSlskdRankingHistoryOptions,
    recordSlskdTransferOutcome,
  },
] = await setupIsolatedBackend(
  "slskd-transfer-history",
  "backend/services/slskdTransferHistory.js",
);

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

async function recordOutcome(username, status) {
  return recordSlskdTransferOutcome({
    job: {
      id: `${username}-${status}`,
      artistName: "Artist",
      trackName: "Track",
      albumName: "Album",
    },
    candidate: {
      raw: {
        user: username,
        file: "Artist/Album/01 - Track.flac",
      },
    },
    status,
  });
}

test("buildSlskdRankingHistoryOptions penalizes repeated failed peers", async () => {
  for (let index = 0; index < 5; index += 1) {
    await recordOutcome("fragilePeer", "transfer_failed");
  }

  const options = await buildSlskdRankingHistoryOptions();

  assert.equal(options.isUserBlacklisted("fragilePeer"), true);
  assert.ok(options.getUserQueuePenalty("fragilePeer") > 0);
});

test("buildSlskdRankingHistoryOptions keeps successful peers eligible", async () => {
  for (let index = 0; index < 5; index += 1) {
    await recordOutcome("recoveredPeer", "transfer_failed");
  }
  await recordOutcome("recoveredPeer", "success");

  const options = await buildSlskdRankingHistoryOptions();

  assert.equal(options.isUserBlacklisted("recoveredPeer"), false);
  assert.ok(options.getUserQueuePenalty("recoveredPeer") > 0);
});
