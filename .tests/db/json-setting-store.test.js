import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  ,
  { createJsonSettingStore },
  { plexPlaylistPointerStore },
  { plexConnectionStore },
  { spotifyConnectionStore },
] = await setupIsolatedBackend(
  "json-setting-store",
  "backend/db/helpers/index.js",
  "backend/db/helpers/jsonSettingStore.js",
  "backend/services/plex/plexPlaylistPointerStore.js",
  "backend/services/plex/plexConnectionStore.js",
  "backend/services/spotify/spotifyConnectionStore.js",
);

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("concurrent updates to one store keep every change", async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      plexPlaylistPointerStore.setPointer(`flow-${index}`, "owner:1", {
        location: `/library/${index}`,
        ratingKey: String(100 + index),
        title: `Flow ${index}`,
      }),
    ),
  );
  for (let index = 0; index < 8; index += 1) {
    assert.equal(
      (await plexPlaylistPointerStore.getPointer(`flow-${index}`, "owner:1"))?.ratingKey,
      String(100 + index),
    );
  }

  await Promise.all([
    plexConnectionStore.saveConnection(1, { linkType: "self", token: "a", clientId: "c1" }),
    plexConnectionStore.saveConnection(2, { linkType: "self", token: "b", clientId: "c2" }),
    plexConnectionStore.setLastError(1, "unreachable"),
  ]);
  assert.equal((await plexConnectionStore.getConnection(1))?.lastError?.message, "unreachable");
  assert.equal((await plexConnectionStore.getConnection(2))?.token, "b");
});

test("a failed update does not block later updates", async () => {
  const store = createJsonSettingStore("jsonSettingStoreTest");
  await assert.rejects(
    store.update(() => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await store.update((value) => ((value.ok = true), "done")), "done");
  assert.equal(await store.update(() => false), false);
  assert.deepEqual(await store.read(), { ok: true });
});

test("refreshing Spotify tokens does not restore a cleared connection", async () => {
  await spotifyConnectionStore.saveConnection(7, {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 60_000,
  });
  const [cleared, refreshed] = await Promise.all([
    spotifyConnectionStore.clearConnection(7),
    spotifyConnectionStore.updateTokens(7, { accessToken: "access-2" }),
  ]);
  assert.equal(cleared, true);
  assert.equal(refreshed, null);
  assert.equal(await spotifyConnectionStore.getConnection(7), null);
});
