import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { beginPlaylistMutation }, { weeklyFlowWorker }] =
  await setupIsolatedBackend(
    "weekly-flow-mutation-guards",
    "backend/services/weeklyFlow/weeklyFlowMutationGuards.js",
    "backend/services/weeklyFlow/weeklyFlowWorker.js",
  );

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("mutation release unblocks every playlist and prunes after an unblock error", async (t) => {
  const calls = [];
  t.mock.method(weeklyFlowWorker, "blockPlaylist", () => true);
  t.mock.method(weeklyFlowWorker, "clearIncompleteRetry", () => {});
  t.mock.method(weeklyFlowWorker, "waitForPlaylistIdle", async () => {});
  t.mock.method(weeklyFlowWorker, "unblockPlaylist", (id) => {
    calls.push(`unblock:${id}`);
    if (id === "first") throw new Error("unblock failed");
  });
  t.mock.method(weeklyFlowWorker, "pruneOrphanedJobState", () => {
    calls.push("prune");
  });

  const release = await beginPlaylistMutation(["first", "second"], { clearPending: false });
  assert.throws(() => release(), /unblock failed/);
  assert.deepEqual(calls, ["unblock:first", "unblock:second", "prune"]);
});

test("mutation setup failure unblocks only the playlists it blocked", async (t) => {
  const calls = [];
  t.mock.method(weeklyFlowWorker, "blockPlaylist", (id) => {
    if (id === "second") throw new Error("block failed");
    calls.push(`block:${id}`);
  });
  t.mock.method(weeklyFlowWorker, "clearIncompleteRetry", () => {});
  t.mock.method(weeklyFlowWorker, "waitForPlaylistIdle", async () => {});
  t.mock.method(weeklyFlowWorker, "unblockPlaylist", (id) => {
    calls.push(`unblock:${id}`);
  });

  await assert.rejects(
    beginPlaylistMutation(["first", "second", "third"], { clearPending: false }),
    /block failed/,
  );
  assert.deepEqual(calls, ["block:first", "unblock:first"]);
});
