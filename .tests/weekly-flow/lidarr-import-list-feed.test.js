import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLidarrImportListItems,
  verifyFlowLidarrFeedToken,
} from "../../backend/services/lidarrImportListFeed.js";
import { ensureTestDatabase } from "../helpers/backendTestHarness.js";
import { loadSettingsCache } from "../../backend/db/helpers/settings.js";

await ensureTestDatabase();
await loadSettingsCache();

test("buildLidarrImportListItems maps jobs to lidarr custom list rows", () => {
  const items = buildLidarrImportListItems([
    {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      albumMbid: "22222222-2222-4222-8222-222222222222",
    },
    {
      artistMbid: "11111111-1111-4111-8111-111111111111",
      albumMbid: "22222222-2222-4222-8222-222222222222",
    },
    {
      artistMbid: "33333333-3333-4333-8333-333333333333",
      albumMbid: null,
    },
    { artistMbid: null, albumMbid: "44444444-4444-4444-8444-444444444444" },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    MusicBrainzId: "11111111-1111-4111-8111-111111111111",
    AlbumId: "22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(items[1], {
    MusicBrainzId: "33333333-3333-4333-8333-333333333333",
  });
});

test("verifyFlowLidarrFeedToken rejects missing or mismatched tokens", () => {
  assert.equal(verifyFlowLidarrFeedToken("missing-flow", "token"), null);
});
