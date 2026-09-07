import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, playEvents, scrobbleStore, honkerDbModule] = await setupIsolatedBackend(
  "play-events",
  "backend/services/playEventService.js",
  "backend/services/scrobbleConnectionStore.js",
  "backend/services/honkerDb.js",
);
const { db } = await import("../../backend/config/database.js");

test.beforeEach(async () => {
  await resetDatabase();
  await db.run("INSERT INTO users (username, password_hash) VALUES (?, ?)", [
    "listener",
    "test",
  ]);
});

test.after(async () => cleanupIsolatedState(isolatedState));

test("records local plays and aggregates artists without provider access", async () => {
  const userId = (await db.get("SELECT id FROM users WHERE username = ?", ["listener"])).id;
  const first = await playEvents.recordPlayEvent(userId, {
    trackId: "song:one",
    title: "One",
    artist: "Artist A",
    album: "Album",
    durationMs: 180000,
    playedAt: 1700000000,
    source: "subsonic",
  });
  await playEvents.recordPlayEvent(userId, {
    trackId: "song:two",
    title: "Two",
    artist: "Artist A",
    playedAt: 1700000001,
    source: "native-player",
  });

  assert.equal(first.playedAt, 1700000000000);
  assert.equal((await playEvents.getPlayHistory(userId)).length, 2);
  assert.deepEqual((await playEvents.getTopPlayedArtists(userId))[0], {
    artistName: "Artist A",
    mbid: null,
    playcount: 2,
    lastPlayedAt: 1700000001000,
  });
});

test("pins each scrobble delivery to the connection active when the play was recorded", async () => {
  const userId = (await db.get("SELECT id FROM users WHERE username = ?", ["listener"])).id;
  const connection = await scrobbleStore.scrobbleConnectionStore.saveConnection(
    userId,
    "lastfm",
    {
      token: "session-token",
      displayName: "listener",
    },
  );
  const event = await playEvents.recordPlayEvent(userId, {
    trackId: "song:one",
    title: "One",
    artist: "Artist A",
  });
  const row = honkerDbModule.getHonkerDb().query(
    "SELECT payload FROM _honker_live WHERE queue = ?",
    ["_outbox:play-events"],
  )[0];

  assert.equal(JSON.parse(row.payload).eventId, event.id);
  assert.equal(JSON.parse(row.payload).connectionRevision, connection.connectionRevision);
});
