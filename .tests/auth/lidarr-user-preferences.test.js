import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, , { userOps }] = await setupIsolatedBackend(
  "lidarr-user-preferences",
  "backend/config/database.js",
  "backend/db/helpers/index.js",
);

const bcryptModule = await import("bcrypt");

const bcrypt = bcryptModule.default;

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("new users start with null Lidarr defaults on all user read paths", async () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = await userOps.createUser("alice", hash, "user");

  assert.equal(user?.lidarrRootFolderPath, null);
  assert.equal(user?.lidarrQualityProfileId, null);

  const stored = await userOps.getUserById(user.id);
  assert.equal(stored?.lidarrRootFolderPath, null);
  assert.equal(stored?.lidarrQualityProfileId, null);

  const listed = await userOps.getAllUsers();
  assert.equal(listed[0]?.lidarrRootFolderPath, null);
  assert.equal(listed[0]?.lidarrQualityProfileId, null);
});

test("user updates persist Lidarr root folder and quality profile defaults", async () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = await userOps.createUser("bob", hash, "user");

  const updated = await userOps.updateUser(user.id, {
    lidarrRootFolderPath: "/music/alt",
    lidarrQualityProfileId: 9,
  });

  assert.equal(updated?.lidarrRootFolderPath, "/music/alt");
  assert.equal(updated?.lidarrQualityProfileId, 9);

  const stored = await userOps.getUserById(user.id);
  assert.equal(stored?.lidarrRootFolderPath, "/music/alt");
  assert.equal(stored?.lidarrQualityProfileId, 9);
});
