import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../../backend/config/database.js";
import { migrateDatabase } from "../../backend/db/pg/schema.js";
import { dbOps, loadSettingsCache } from "../../backend/db/helpers/settings.js";
import { userOps } from "../../backend/db/helpers/users.js";

test.before(async () => {
  await migrateDatabase(db, { logger: {} });
  await db.run("DELETE FROM settings");
  await db.run("DELETE FROM users");
  await loadSettingsCache();
});

test("settings are read synchronously from the mirror and written through", async () => {
  const initial = dbOps.getSettings();
  assert.equal(initial.quality, "standard");
  assert.equal(initial.onboardingComplete, false);

  await dbOps.updateSettings({
    quality: "lossless",
    onboardingComplete: true,
    integrations: { lidarr: { url: "http://lidarr", apiKey: "secret" } },
    blocklist: { artists: ["x"], tags: [] },
  });
  const updated = dbOps.getSettings();
  assert.equal(updated.quality, "lossless");
  assert.equal(updated.onboardingComplete, true);
  assert.equal(updated.integrations.lidarr.apiKey, "secret");
  assert.deepEqual(updated.blocklist.artists, ["x"]);

  const storedIntegrations = await db.get("SELECT value FROM settings WHERE key = 'integrations'");
  assert.ok(!storedIntegrations.value.includes("secret"), "integrations are encrypted at rest");

  await loadSettingsCache();
  assert.equal(dbOps.getSettings().quality, "lossless");
});

test("json settings write through the mirror", async () => {
  await dbOps.setJSONSetting("someKey", { a: 1 });
  assert.deepEqual(dbOps.getJSONSetting("someKey"), { a: 1 });
  assert.deepEqual(await dbOps.readJSONSetting("someKey"), { a: 1 });
  await dbOps.deleteSetting("someKey");
  assert.equal(dbOps.getJSONSetting("someKey"), null);
});

test("users round-trip with generated ids", async () => {
  assert.equal(await userOps.countUsers(), 0);
  const created = await userOps.createUser("Admin", "hash", "admin", { deleteArtist: true });
  assert.equal(typeof created.id, "number");
  assert.equal(created.permissions.deleteArtist, true);

  const byName = await userOps.getUserByUsername("admin");
  assert.equal(byName.id, created.id);
  assert.equal(byName.passwordHash, "hash");

  const updated = await userOps.updateUser(created.id, { role: "user", lastfmUsername: "lfm" });
  assert.equal(updated.role, "user");
  assert.equal(updated.listenHistoryProvider, "lastfm");
  assert.equal(updated.listenHistoryUsername, "lfm");

  const listening = await userOps.getAllListeningHistoryUsers();
  assert.equal(listening.length, 1);

  assert.equal(await userOps.createUser("admin", "dup", "user"), null, "duplicate usernames return null");
  assert.equal(await userOps.deleteUser(created.id), true);
  assert.equal(await userOps.countUsers(), 0);
});

test("concurrent user updates keep each other's fields", async () => {
  const user = await userOps.createUser("racer", "hash", "user");
  await Promise.all([
    userOps.updateUser(user.id, { role: "admin" }),
    userOps.updateUser(user.id, { lastfmUsername: "racer-lfm" }),
    userOps.updateUser(user.id, { permissions: { deleteArtist: true } }),
  ]);
  const stored = await userOps.getUserById(user.id);
  assert.equal(stored.role, "admin");
  assert.equal(stored.listenHistoryUsername, "racer-lfm");
  assert.equal(stored.permissions.deleteArtist, true);
  await userOps.deleteUser(user.id);
});

test("a rejected user update returns null without aborting the caller's transaction", async () => {
  const first = await userOps.createUser("first-name", "hash", "user");
  const second = await userOps.createUser("second-name", "hash", "user");
  assert.equal(await userOps.updateUser(second.id, { username: "first-name" }), null);

  const renamed = await db.transaction(async () => {
    assert.equal(await userOps.updateUser(second.id, { username: "first-name" }), null);
    return userOps.updateUser(second.id, { username: "third-name" });
  });
  assert.equal(renamed?.username, "third-name");
  assert.equal((await userOps.getUserById(second.id)).username, "third-name");
  await userOps.deleteUser(first.id);
  await userOps.deleteUser(second.id);
});

test("a password login is recorded only against the hash it was verified with", async () => {
  const user = await userOps.createUser("recorder", "old-hash", "user", null, false);
  assert.equal(
    await userOps.recordPasswordLogin(user.id, { verifiedHash: "old-hash", password: "old-pass" }),
    true,
  );
  assert.equal(await userOps.getSubsonicPasswordById(user.id), "old-pass");
  assert.equal((await userOps.getUserById(user.id)).hasLocalPassword, true);
  assert.equal(
    await userOps.recordPasswordLogin(user.id, { verifiedHash: "old-hash", password: "old-pass" }),
    false,
    "an unchanged login writes nothing",
  );

  // The password changes while a login with the old one is in flight.
  await userOps.updateUser(user.id, { passwordHash: "new-hash", subsonicPassword: "new-pass" });
  assert.equal(
    await userOps.recordPasswordLogin(user.id, {
      verifiedHash: "old-hash",
      password: "old-pass",
      newHash: "old-rehash",
    }),
    false,
  );
  assert.equal((await userOps.getUserById(user.id)).passwordHash, "new-hash");
  assert.equal(await userOps.getSubsonicPasswordById(user.id), "new-pass");

  assert.equal(
    await userOps.recordPasswordLogin(user.id, {
      verifiedHash: "new-hash",
      password: "new-pass",
      newHash: "new-rehash",
    }),
    true,
  );
  assert.equal((await userOps.getUserById(user.id)).passwordHash, "new-rehash");
  await userOps.deleteUser(user.id);
});
