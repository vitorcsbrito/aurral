import test from "node:test";
import assert from "node:assert/strict";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { dbOps }, discoveryIndex] = await setupIsolatedBackend(
  "discovery-flow-settings",
  "backend/db/helpers/index.js",
  "backend/services/discovery/index.js",
);

const {
  getDiscoveryRecommendationsPerRefresh,
  isDiscoveryPersonalizedEnabled,
} = discoveryIndex;

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("discovery flow settings use defaults when unset", () => {
  assert.equal(getDiscoveryRecommendationsPerRefresh(), 200);
  assert.equal(isDiscoveryPersonalizedEnabled(), true);
});

test("discovery personalized toggle", async () => {
  const settings = dbOps.getSettings();
  assert.equal(isDiscoveryPersonalizedEnabled(), true);

  await dbOps.updateSettings({
    ...settings,
    integrations: {
      ...settings.integrations,
      lastfm: {
        ...(settings.integrations?.lastfm || {}),
        discoveryPersonalizedEnabled: false,
      },
    },
  });
  assert.equal(isDiscoveryPersonalizedEnabled(), false);
});
