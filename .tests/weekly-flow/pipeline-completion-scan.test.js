import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { finalizePipelineJobSuccess }, { playlistManager }, { weeklyFlowWorker }] =
  await setupIsolatedBackend(
    "pipeline-completion-scan",
    "backend/services/pipelineHelpers.js",
    "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
    "backend/services/weeklyFlow/weeklyFlowWorker.js",
  );

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("pipeline completion leaves the library scan to playlist completion", async (t) => {
  const scheduleScanLibrary = t.mock.method(playlistManager, "scheduleScanLibrary", () => 1);
  const refreshPlaylist = t.mock.method(playlistManager, "refreshPlaylist", async () => null);
  const wake = t.mock.method(weeklyFlowWorker, "wake", () => {});
  const checkPlaylistComplete = t.mock.method(
    weeklyFlowWorker,
    "checkPlaylistComplete",
    async () => {},
  );

  await finalizePipelineJobSuccess({
    downloadTracker: {
      setDone() {},
    },
    job: {
      id: "pipeline-job",
      playlistType: "flow-playlist",
      artistName: "Artist",
      trackName: "Track",
    },
    committedFinalPath: "/library/Artist/Track.flac",
  });

  assert.equal(scheduleScanLibrary.mock.callCount(), 0);
  assert.deepEqual(refreshPlaylist.mock.calls.map((call) => call.arguments), [["flow-playlist"]]);
  assert.deepEqual(wake.mock.calls.map((call) => call.arguments), [[0]]);
  assert.deepEqual(
    checkPlaylistComplete.mock.calls.map((call) => call.arguments),
    [["flow-playlist"]],
  );
});
