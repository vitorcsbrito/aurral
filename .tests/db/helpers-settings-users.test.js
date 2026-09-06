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
