import test from "node:test";
import assert from "node:assert/strict";

import { db, closeDatabase } from "../../backend/config/database.js";
import {
  MIGRATIONS,
  USER_IDENTITIES_BACKFILL,
  migrateDatabase,
} from "../../backend/db/pg/schema.js";
import { userIdentityOps } from "../../backend/db/helpers/userIdentities.js";

const IDENTITY_MIGRATION = "0006_user_identities";

const insertUser = async (username, { role = "user", hasLocalPassword = 0 } = {}) =>
  (
    await db.get(
      "INSERT INTO users (username, password_hash, role, has_local_password) VALUES (?, 'hash', ?, ?) RETURNING id",
      [username, role, hasLocalPassword],
    )
  ).id;

const setIntegrations = (value) =>
  db.run(
    `INSERT INTO settings (key, value) VALUES ('integrations', ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [typeof value === "string" ? value : JSON.stringify(value)],
  );

const protectedUsernames = async () =>
  (await db.all("SELECT username FROM users WHERE is_protected = 1 ORDER BY username")).map(
    (row) => row.username,
  );

const resetTables = () => db.exec("TRUNCATE user_identities, sessions, users, settings CASCADE");

test.after(async () => {
  await closeDatabase();
});

// Runs first, on the empty per-process schema: builds a database as it was
// before the identity migration, then upgrades it.
test("the identity migration protects the recovery admin, expires sessions and flags pre-identity accounts", async () => {
  const pending = MIGRATIONS.splice(MIGRATIONS.findIndex((m) => m.id === IDENTITY_MIGRATION));
  try {
    const applied = await migrateDatabase(db, { logger: {} });
    assert.ok(applied.includes("0005_users_subsonic_password"));
    assert.ok(!applied.includes(IDENTITY_MIGRATION));
  } finally {
    MIGRATIONS.push(...pending);
  }

  await db.run("INSERT INTO settings (key, value) VALUES ('integrations', ?)", [
    JSON.stringify({ general: { authUser: "Recovery-Admin", authPassword: "AURRAL_ENC:secret" } }),
  ]);
  const recoveryId = (
    await db.get(
      "INSERT INTO users (username, password_hash, role) VALUES ('recovery-admin', 'legacy-hash', 'admin') RETURNING id",
    )
  ).id;
  await db.run(
    "INSERT INTO users (username, password_hash, role) VALUES ('other-admin', 'hash', 'admin'), ('listener', 'hash', 'user')",
  );
  await db.run(
    "INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (?, 'legacy-session', ?, ?)",
    [recoveryId, Date.now(), Date.now() + 60_000],
  );

  assert.deepEqual(await migrateDatabase(db, { logger: {} }), [IDENTITY_MIGRATION]);

  const users = await db.all(
    `SELECT username, status, is_protected, role_source, has_local_password,
       needs_identity_migration, allow_identity_adoption
     FROM users ORDER BY username`,
  );
  assert.deepEqual(users, [
    {
      username: "listener",
      status: "active",
      is_protected: 0,
      role_source: "local",
      has_local_password: 0,
      needs_identity_migration: 1,
      allow_identity_adoption: 0,
    },
    {
      username: "other-admin",
      status: "active",
      is_protected: 0,
      role_source: "local",
      has_local_password: 0,
      needs_identity_migration: 1,
      allow_identity_adoption: 0,
    },
    {
      username: "recovery-admin",
      status: "active",
      is_protected: 1,
      role_source: "local",
      has_local_password: 0,
      needs_identity_migration: 1,
      allow_identity_adoption: 0,
    },
  ]);
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM sessions")).count, 0);
  const sessionColumns = await db.all(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'sessions'",
  );
  assert.ok(sessionColumns.some((row) => row.column_name === "reauthenticated_at"));
  assert.deepEqual(await migrateDatabase(db, { logger: {} }), [], "the migration runs once");
});

test("the backfill protects only an admin named by a legacy setting that has a password", async () => {
  await resetTables();
  await insertUser("admin", { role: "admin" });
  await insertUser("ops", { role: "admin" });
  await insertUser("listener");

  await setIntegrations({ general: { authPassword: "set" } });
  await db.exec(USER_IDENTITIES_BACKFILL);
  assert.deepEqual(await protectedUsernames(), ["admin"], "authUser defaults to admin");

  await db.run("UPDATE users SET is_protected = 0");
  await setIntegrations({ general: { authUser: "ops", authPassword: "" } });
  await db.exec(USER_IDENTITIES_BACKFILL);
  assert.deepEqual(await protectedUsernames(), [], "no legacy password, no recovery account");

  await setIntegrations({ general: { authUser: "   ", authPassword: "set" } });
  await db.exec(USER_IDENTITIES_BACKFILL);
  assert.deepEqual(await protectedUsernames(), [], "a blank authUser names nobody");

  await setIntegrations({ general: { authUser: " Listener ", authPassword: "set" } });
  await db.exec(USER_IDENTITIES_BACKFILL);
  assert.deepEqual(await protectedUsernames(), [], "only an admin can be the recovery account");

  await setIntegrations("{not json");
  await db.exec(USER_IDENTITIES_BACKFILL);
  assert.deepEqual(await protectedUsernames(), []);

  await setIntegrations({ general: { authUser: " OPS ", authPassword: "set" } });
  await db.exec(USER_IDENTITIES_BACKFILL);
  assert.deepEqual(await protectedUsernames(), ["ops"]);
});

test("the backfill does not flag accounts that already have an identity", async () => {
  await resetTables();
  const linked = await insertUser("linked");
  await insertUser("legacy");
  await userIdentityOps.link(linked, { providerType: "oidc", providerKey: "issuer", subject: "s" });

  await db.exec(USER_IDENTITIES_BACKFILL);
  const flags = await db.all(
    "SELECT username, needs_identity_migration FROM users ORDER BY username",
  );
  assert.deepEqual(flags, [
    { username: "legacy", needs_identity_migration: 1 },
    { username: "linked", needs_identity_migration: 0 },
  ]);
});

test("startup reconciliation clears migration flags once an identity is linked", async () => {
  await resetTables();
  const linked = await insertUser("gordon.may");
  const legacy = await insertUser("jody.may");
  await db.run(
    "UPDATE users SET needs_identity_migration = 1, allow_identity_adoption = 1 WHERE id IN (?, ?)",
    [linked, legacy],
  );
  await userIdentityOps.link(linked, {
    providerType: "oidc",
    providerKey: "https://idp.example/",
    subject: "subject-1",
  });

  assert.equal(await userIdentityOps.reconcileMigrationFlags(), 1);
  const rows = await db.all(
    "SELECT username, needs_identity_migration, allow_identity_adoption FROM users ORDER BY username",
  );
  assert.deepEqual(rows, [
    { username: "gordon.may", needs_identity_migration: 0, allow_identity_adoption: 0 },
    { username: "jody.may", needs_identity_migration: 1, allow_identity_adoption: 1 },
  ]);
  assert.equal(await userIdentityOps.reconcileMigrationFlags(), 0);
});

test("identities cascade with their user and one subject links to one account", async () => {
  await resetTables();
  const owner = await insertUser("owner");
  const contender = await insertUser("contender");
  const identity = await userIdentityOps.link(owner, {
    providerType: "plex",
    providerKey: "plex",
    subject: "claimed",
    displayName: "Owner",
  });
  assert.equal((await userIdentityOps.findByProvider("plex", "plex", "claimed")).userId, owner);
  assert.equal((await userIdentityOps.getById(identity.id)).displayName, "Owner");

  await assert.rejects(
    () =>
      userIdentityOps.link(contender, {
        providerType: "plex",
        providerKey: "plex",
        subject: "claimed",
      }),
    (error) => error?.code === "23505",
  );

  const original = await userIdentityOps.link(contender, {
    providerType: "plex",
    providerKey: "plex",
    subject: "original",
  });
  await assert.rejects(
    () =>
      userIdentityOps.replaceForUser(contender, {
        providerType: "plex",
        providerKey: "plex",
        subject: "claimed",
      }),
    (error) => error?.code === "23505",
  );
  assert.equal(
    (await userIdentityOps.getById(original.id))?.subject,
    "original",
    "a failed replacement keeps the previous identity",
  );

  const replaced = await userIdentityOps.replaceForUser(contender, {
    providerType: "plex",
    providerKey: "plex",
    subject: "replacement",
  });
  assert.equal(await userIdentityOps.getById(original.id), null);
  assert.equal((await userIdentityOps.getForUser(contender)).length, 1);
  assert.equal(replaced.subject, "replacement");

  await db.run("DELETE FROM users WHERE id = ?", [owner]);
  assert.equal(await userIdentityOps.getById(identity.id), null);
  assert.equal(await userIdentityOps.countForUser(owner), 0);
});

test("an identity is only removed while another sign-in method remains", async () => {
  await resetTables();
  const external = await insertUser("external");
  const only = await userIdentityOps.link(external, {
    providerType: "oidc",
    providerKey: "issuer",
    subject: "only",
  });
  assert.equal(await userIdentityOps.isLastSignInMethod(external), true);
  assert.deepEqual(await userIdentityOps.unlinkUnlessLastSignIn(external, only.id), {
    unlinked: false,
    reason: "last_auth_method",
  });

  const second = await userIdentityOps.link(external, {
    providerType: "google",
    providerKey: "google",
    subject: "second",
  });
  assert.equal(await userIdentityOps.isLastSignInMethod(external), false);
  let afterUnlinkCalls = 0;
  assert.deepEqual(
    await userIdentityOps.unlinkUnlessLastSignIn(external, second.id, {
      afterUnlink: async () => {
        afterUnlinkCalls += 1;
      },
    }),
    { unlinked: true },
  );
  assert.equal(afterUnlinkCalls, 1);
  assert.deepEqual(
    await userIdentityOps.unlinkUnlessLastSignIn(external, only.id, { force: true }),
    { unlinked: true },
  );

  const local = await insertUser("local", { hasLocalPassword: 1 });
  const localIdentity = await userIdentityOps.link(local, {
    providerType: "oidc",
    providerKey: "issuer",
    subject: "local",
  });
  assert.deepEqual(await userIdentityOps.unlinkUnlessLastSignIn(external, localIdentity.id), {
    unlinked: false,
    reason: "not_found",
  });
  assert.deepEqual(await userIdentityOps.unlinkUnlessLastSignIn(local, localIdentity.id), {
    unlinked: true,
  });
});

test("concurrent removals cannot both pass the last-sign-in-method check", async () => {
  await resetTables();
  const user = await insertUser("racer");
  const first = await userIdentityOps.link(user, {
    providerType: "oidc",
    providerKey: "issuer",
    subject: "first",
  });
  const second = await userIdentityOps.link(user, {
    providerType: "google",
    providerKey: "google",
    subject: "second",
  });

  // Park both removals behind a table lock so they reach their checks together.
  const lockHeld = Promise.withResolvers();
  const releaseLock = Promise.withResolvers();
  const locker = db.transaction(async () => {
    await db.exec("LOCK TABLE user_identities IN ACCESS EXCLUSIVE MODE");
    lockHeld.resolve();
    await releaseLock.promise;
  });
  await lockHeld.promise;
  const racing = Promise.all([
    userIdentityOps.unlinkUnlessLastSignIn(user, first.id),
    userIdentityOps.unlinkUnlessLastSignIn(user, second.id),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  releaseLock.resolve();
  await locker;
  const results = await racing;

  assert.equal(results.filter((result) => result.unlinked).length, 1);
  assert.equal(await userIdentityOps.countForUser(user), 1);
});
