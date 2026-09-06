import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.js";

const [isolatedState, { dbOps, userOps }] = await setupIsolatedBackend(
  "inbox-helper",
  "backend/db/helpers/index.js",
);

let userId;

test.before(async () => {
  await resetDatabase();
  userId = (await userOps.createUser("inbox-user", "password-hash")).id;
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("inbox items preserve read state while source metadata updates", async () => {
  const first = await dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "artist:release",
    title: "New record",
    subtitle: "Artist",
    metadata: { releaseDate: "2026-08-05" },
  });
  assert.equal(first.isRead, false);
  assert.equal(await dbOps.getInboxUnreadCount(userId), 1);

  const read = await dbOps.updateInboxItem(userId, first.id, { isRead: true });
  assert.equal(read.isRead, true);
  assert.equal(await dbOps.getInboxUnreadCount(userId), 0);

  const refreshed = await dbOps.upsertInboxItem({
    userId,
    kind: "release",
    sourceKey: "artist:release",
    title: "New record (updated)",
    metadata: { releaseDate: "2026-08-06" },
  });
  assert.equal(refreshed.title, "New record (updated)");
  assert.equal(refreshed.isRead, true);
});
