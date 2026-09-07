import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../../backend/config/database.js";
import { migrateDatabase } from "../../backend/db/pg/schema.js";
import { dbOps, userOps } from "../../backend/db/helpers/index.js";
import { loadSettingsCache } from "../../backend/db/helpers/settings.js";
import {
  createSession,
  getSessionByToken,
  deleteSession,
  cleanExpiredSessions,
} from "../../backend/config/session-helpers.js";

test.before(async () => {
  await migrateDatabase(db, { logger: {} });
  for (const table of [
    "sessions",
    "users",
    "images_cache",
    "lidarr_artist_id_map",
    "artist_overrides",
    "discovery_cache",
    "aurral_history",
    "inbox_items",
  ]) {
    await db.run(`DELETE FROM ${table}`);
  }
  await loadSettingsCache();
});

test("image cache upserts and expires", async () => {
  await dbOps.setImage("mbid-1", "http://img/1", { small: "s" });
  await dbOps.setImage("mbid-1", "http://img/2", null);
  const image = await dbOps.getImage("mbid-1");
  assert.equal(image.imageUrl, "http://img/2");
  assert.equal(await dbOps.countImages(), 1);
  const many = await dbOps.getImages(["mbid-1", "missing"]);
  assert.deepEqual(Object.keys(many), ["mbid-1"]);
  await dbOps.deleteImage("mbid-1");
  assert.equal(await dbOps.countImages(), 0);
});

test("lidarr id map reports unique conflicts with a stable code", async () => {
  await dbOps.setLidarrArtistIdMap("mb-a", "lidarr-1");
  assert.equal(await dbOps.getLidarrArtistMbid("lidarr-1"), "mb-a");
  await assert.rejects(dbOps.setLidarrArtistIdMap("mb-b", "lidarr-1"), (error) => {
    assert.equal(error.code, "LIDARR_ARTIST_ID_CONFLICT");
    return true;
  });
  await dbOps.setLidarrArtistIdMap("mb-a", "lidarr-2");
  assert.equal(await dbOps.getLidarrArtistMbid("lidarr-2"), "mb-a");
  assert.equal(await dbOps.getLidarrArtistMbid("lidarr-1"), null);
});

test("artist overrides round-trip", async () => {
  await dbOps.setArtistOverride("mb-x", { deezerArtistId: "12" });
  const override = await dbOps.getArtistOverride("mb-x");
  assert.equal(override.deezerArtistId, "12");
  await dbOps.deleteArtistOverride("mb-x");
  assert.equal(await dbOps.getArtistOverride("mb-x"), null);
});

test("discovery cache stores namespaced payloads", async () => {
  await dbOps.updateDiscoveryCache(
    { recommendations: [{ id: 1 }], provider: "lastfm", isEnriching: true },
    "user:1",
  );
  const cached = await dbOps.getDiscoveryCache("user:1");
  assert.deepEqual(cached.recommendations, [{ id: 1 }]);
  assert.equal(cached.provider, "lastfm");
  assert.ok(cached.lastUpdated);
  await dbOps.deleteDiscoveryCacheByPrefix("user:1:");
  const cleared = await dbOps.getDiscoveryCache("user:1");
  assert.deepEqual(cleared.recommendations, []);
  assert.equal(cleared.provider, null);
});

test("aurral history inserts, lists and prunes", async () => {
  const now = Date.now();
  await dbOps.insertAurralHistory({ id: "h1", title: "One", createdAt: now - 1000 });
  await dbOps.insertAurralHistory({ id: "h2", title: "Two", createdAt: now });
  await dbOps.insertAurralHistory({ id: "h2", title: "Two again", createdAt: now });
  const rows = await dbOps.getAurralHistory({ since: 0, limit: 10 });
  assert.deepEqual(
    rows.map((row) => row.title),
    ["Two again", "One"],
  );
  await dbOps.pruneAurralHistory({ maxEntries: 1 });
  assert.equal((await dbOps.getAurralHistory()).length, 1);
});

test("inbox items upsert and update", async () => {
  const user = await userOps.createUser("inbox", "hash", "user");
  const item = await dbOps.upsertInboxItem({
    userId: user.id,
    kind: "release",
    sourceKey: "src-1",
    title: "New release",
  });
  assert.ok(item.id);
  assert.equal(await dbOps.getInboxUnreadCount(user.id), 1);
  const updated = await dbOps.updateInboxItem(user.id, item.id, { isRead: true });
  assert.equal(updated.isRead, true);
  assert.equal(await dbOps.getInboxUnreadCount(user.id), 0);
  const listed = await dbOps.getInboxItems(user.id, { kinds: ["release"] });
  assert.equal(listed.length, 1);
});

test("sessions round-trip", async () => {
  const user = await userOps.createUser("sessions", "hash", "admin");
  const session = await createSession(user.id, "127.0.0.1", "test");
  const resolved = await getSessionByToken(session.token);
  assert.equal(resolved.user.id, user.id);
  assert.equal(await deleteSession(session.token), true);
  assert.equal(await getSessionByToken(session.token), null);
  assert.equal(typeof (await cleanExpiredSessions()), "number");
});
