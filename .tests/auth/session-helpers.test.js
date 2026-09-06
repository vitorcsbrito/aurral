import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, { userOps }, sessionHelpers] =
  await setupIsolatedBackend(
    "sessions",
    "backend/config/database.js",
    "backend/db/helpers/index.js",
    "backend/config/session-helpers.js",
  );

const bcryptModule = await import("bcrypt");

const bcrypt = bcryptModule.default;

const {
  createSession,
  getSessionByToken,
  deleteSession,
  deleteSessionsByUserId,
  cleanExpiredSessions,
} = sessionHelpers;

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("creates and resolves sessions with user payload metadata", async () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = await userOps.createUser("alice", hash, "admin");

  const session = await createSession(user.id, "127.0.0.1", "node:test");
  const stored = await getSessionByToken(session.token);

  assert.ok(session.token);
  assert.equal(typeof session.expiresAt, "number");
  assert.equal(stored?.userId, user.id);
  assert.equal(stored?.user?.username, "alice");
  assert.equal(stored?.ipAddress, "127.0.0.1");
  assert.equal(stored?.userAgent, "node:test");
});

test("deletes expired sessions when looked up or cleaned", async () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = await userOps.createUser("bob", hash, "user");
  const session = await createSession(user.id);

  await db.run("UPDATE sessions SET expires_at = ? WHERE token = ?", [
    Date.now() - 1000,
    session.token,
  ]);

  assert.equal(await getSessionByToken(session.token), null);
  assert.equal(await cleanExpiredSessions(), 0);
});

test("can delete one session or all sessions for a user", async () => {
  const hash = bcrypt.hashSync("secret", 4);
  const user = await userOps.createUser("carol", hash, "user");
  const first = await createSession(user.id);
  const second = await createSession(user.id);

  assert.equal(await deleteSession(first.token), true);
  assert.equal(await getSessionByToken(first.token), null);
  assert.ok(await getSessionByToken(second.token));

  assert.equal(await deleteSessionsByUserId(user.id), 1);
  assert.equal(await getSessionByToken(second.token), null);
});
