import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { dbOps }, { runStorageHealthCheck }] =
  await setupIsolatedBackend(
    "storage-health-playlist-path",
    "backend/db/helpers/index.js",
    "backend/services/storageHealthService.js",
  );

test.beforeEach(async () => {
  await resetDatabase();
  const downloadFolder = process.env.DOWNLOAD_FOLDER;
  await dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {},
    pathMappings: [],
    downloadFolderPath: downloadFolder,
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("does not report legacy playlist job paths as storage failures", async () => {
  const result = await runStorageHealthCheck({ force: true });

  assert.equal(result.sections.some((section) => section.id === "playlists"), false);
  assert.equal(
    result.sections
      .find((section) => section.id === "downloads")
      ?.steps.some((step) => step.id === "playlist-root"),
    false,
  );
});
