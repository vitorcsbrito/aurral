import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { dbOps }, persistence] = await setupIsolatedBackend(
  "discovery-cache-hydration",
  "backend/db/helpers/index.js",
  "backend/services/discovery/persistence.js",
);

const { getDiscoveryCache, initDiscoveryPersistence, resetDiscoveryModuleCache } = persistence;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("getDiscoveryCache preserves lastUpdated after an empty completed refresh", async () => {
  await resetDatabase();

  await dbOps.updateDiscoveryCache({
    recommendations: [],
    globalTop: [],
    basedOn: [],
    topTags: [],
    topGenres: [],
  });

  // Rehydrate from the database the way startup does.
  resetDiscoveryModuleCache();
  await initDiscoveryPersistence();
  const cache = getDiscoveryCache();

  assert.ok(cache.lastUpdated);
  assert.deepEqual(cache.recommendations, []);
  assert.deepEqual(cache.globalTop, []);
  assert.deepEqual(cache.topGenres, []);
  assert.equal(cache.isUpdating, false);
});

test("getDiscoveryCache persists recommendation enrichment metadata", async () => {
  await resetDatabase();

  await dbOps.updateDiscoveryCache({
    recommendations: [{ id: "artist-1", name: "Initial Artist" }],
    recommendationQuality: "initial",
    isEnriching: true,
    discoveryRunId: "run-1",
    enrichmentStartedAt: "2026-06-18T00:00:00.000Z",
    enrichmentProgressMessage: "Improving recommendations",
  });

  const cache = await dbOps.getDiscoveryCache();

  assert.equal(cache.recommendationQuality, "initial");
  assert.equal(cache.isEnriching, true);
  assert.equal(cache.discoveryRunId, "run-1");
  assert.equal(cache.enrichmentStartedAt, "2026-06-18T00:00:00.000Z");
  assert.equal(cache.enrichmentProgressMessage, "Improving recommendations");
});
