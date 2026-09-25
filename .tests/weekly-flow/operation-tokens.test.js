import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { dbOps }, { markLatestWeeklyFlowOperationToken }] =
  await setupIsolatedBackend(
    "weekly-flow-operation-tokens",
    "backend/db/helpers/index.js",
    "backend/services/weeklyFlow/weeklyFlowOperations.js",
  );

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("concurrent operation tokens for different scopes are all kept", async () => {
  await Promise.all([
    markLatestWeeklyFlowOperationToken("flow:a", "token-a"),
    markLatestWeeklyFlowOperationToken("flow:b", "token-b"),
    markLatestWeeklyFlowOperationToken("playlist:c", "token-c"),
  ]);

  assert.equal(dbOps.getJSONSetting("weeklyFlowOperationTokens:flow%3Aa"), "token-a");
  assert.equal(dbOps.getJSONSetting("weeklyFlowOperationTokens:flow%3Ab"), "token-b");
  assert.equal(dbOps.getJSONSetting("weeklyFlowOperationTokens:playlist%3Ac"), "token-c");
});

test("a newer token for the same scope replaces the older one", async () => {
  await markLatestWeeklyFlowOperationToken("flow:a", "old");
  await markLatestWeeklyFlowOperationToken("flow:a", "new");

  assert.equal(dbOps.getJSONSetting("weeklyFlowOperationTokens:flow%3Aa"), "new");
});
