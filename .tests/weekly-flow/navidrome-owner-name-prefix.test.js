import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { dbOps, userOps },
  { flowPlaylistConfig },
  { WeeklyFlowPlaylistManager },
] = await setupIsolatedBackend(
  "navidrome-owner-name-prefix",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
);

test.beforeEach(async () => {
  await resetDatabase();
  await dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
    playlistArtwork: { style: "aurral" },
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

function makeManager() {
  const manager = new WeeklyFlowPlaylistManager(process.env.WEEKLY_FLOW_FOLDER);
  const created = [];
  manager.navidromeDestination.client = {
    created,
    isConfigured: () => true,
    async ensureWeeklyFlowLibrary() {},
    async getPlaylists() {
      return [];
    },
    async findSong() {
      return { id: "song-id" };
    },
    async createPlaylist(name) {
      created.push(name);
      return { id: name, name };
    },
    async updatePlaylist() {},
    async deletePlaylist() {},
    async scanLibrary() {},
  };
  return manager;
}

test("the Navidrome adapter keeps an unowned flow name bare", async () => {
  const manager = makeManager();
  const names = await manager.navidromeDestination.getPlaylistNames({
    displayName: "Weekend Vibes",
  });
  assert.equal(names.current, "Weekend Vibes");
  assert.deepEqual(names.legacy, ["[A] Weekend Vibes", "Aurral Weekend Vibes"]);
});

test("the Navidrome adapter prefixes an owned flow and keeps legacy names", async () => {
  const jody = await userOps.createUser("jody", "hash", "user");
  const manager = makeManager();
  const names = await manager.navidromeDestination.getPlaylistNames({
    ownerUserId: jody.id,
    displayName: "Weekend Vibes",
  });
  assert.equal(names.current, "jody - Weekend Vibes");
  assert.deepEqual(names.legacy, [
    "Weekend Vibes",
    "[A] Weekend Vibes",
    "Aurral Weekend Vibes",
  ]);
});

test("the Navidrome adapter prefixes an owned shared playlist and keeps legacy names", async () => {
  const jody = await userOps.createUser("jody", "hash", "user");
  const playlist = await flowPlaylistConfig.createSharedPlaylist({ name: "80s Anthems" });
  const manager = makeManager();
  const names = await manager.navidromeDestination.getPlaylistNames({
    entityId: playlist.id,
    ownerUserId: jody.id,
    displayName: "80s Anthems",
  });
  assert.equal(names.current, "jody - 80s Anthems");
  assert.deepEqual(names.legacy, [
    "80s Anthems",
    "[AS] 80s Anthems",
    "Aurral Shared 80s Anthems",
  ]);
  await flowPlaylistConfig.deleteSharedPlaylist(playlist.id);
});

test("two different owners can use the same native playlist name", async () => {
  const gordon = await userOps.createUser("gordon", "hash", "admin");
  const jody = await userOps.createUser("jody", "hash", "user");
  const gordonFlow = await flowPlaylistConfig.createFlow({
    name: "Weekend Vibes",
    ownerUserId: gordon.id,
  });
  await flowPlaylistConfig.setEnabled(gordonFlow.id, true);
  const jodyFlow = await flowPlaylistConfig.createFlow({ name: "Weekend Vibes", ownerUserId: jody.id });
  await flowPlaylistConfig.setEnabled(jodyFlow.id, true);

  const manager = makeManager();
  await manager.ensurePlaylists();

  assert.deepEqual(
    manager.navidromeDestination.client.created.sort(),
    ["gordon - Weekend Vibes", "jody - Weekend Vibes"].sort(),
  );
});
