import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { dbOps },
  { WeeklyFlowPlaylistManager },
  { PLAYLIST_LIBRARY_DIR },
] = await setupIsolatedBackend(
  "playlist-root-resync",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/playlistPaths.js",
);

test.beforeEach(async () => {
  await resetDatabase();
  await dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
    downloadFolderPath: "",
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("updateConfig re-resolves the playlist root once the stored download folder loads", async () => {
  const storedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-stored-root-"));
  // Startup order: manager constructs before settings cache loads.
  const manager = new WeeklyFlowPlaylistManager(undefined, { triggerEnsureOnInit: false });
  const staleRoot = manager.weeklyFlowRoot;
  assert.notEqual(staleRoot, path.resolve(storedRoot));
  assert.equal(manager.plexDestination.weeklyFlowRoot, staleRoot);

  manager.plexDestination._sectionId = "stale-section";
  manager.plexDestination._libraryTracks = [{ ratingKey: "1" }];
  await dbOps.updateSettings({ downloadFolderPath: storedRoot });
  manager.updateConfig(false);

  const expected = path.resolve(storedRoot);
  assert.equal(manager.weeklyFlowRoot, expected);
  assert.equal(manager.playlistLibraryRoot, path.join(expected, PLAYLIST_LIBRARY_DIR));
  assert.equal(manager.plexDestination.weeklyFlowRoot, expected);
  assert.equal(manager.plexDestination._libraryPath(), expected);
  assert.equal(manager.plexDestination._sectionId, null);
  assert.equal(manager.plexDestination._libraryTracks, null);
  assert.equal(manager.navidromeDestination.weeklyFlowRoot, expected);
  assert.equal(manager.navidromeDestination.mediaLibraryRoot, expected);
  assert.equal(
    manager.navidromeDestination.playlistLibraryRoot,
    path.join(expected, PLAYLIST_LIBRARY_DIR),
  );
});

test("updateConfig keeps the root when the stored download folder is unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-same-root-"));
  await dbOps.updateSettings({ downloadFolderPath: root });
  const manager = new WeeklyFlowPlaylistManager(undefined, { triggerEnsureOnInit: false });
  assert.equal(manager.weeklyFlowRoot, path.resolve(root));
  manager.plexDestination._sectionId = "section";
  manager.updateConfig(false);
  assert.equal(manager.weeklyFlowRoot, path.resolve(root));
  assert.equal(manager.plexDestination._sectionId, "section");
});
