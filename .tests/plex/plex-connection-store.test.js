import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, , { plexConnectionStore }] = await setupIsolatedBackend(
  "plex-connection-store",
  "backend/db/helpers/index.js",
  "backend/services/plex/plexConnectionStore.js",
);
const { db } = await import("../../backend/config/database.js");

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("getConnection returns null when nothing is linked", async () => {
  assert.equal(await plexConnectionStore.getConnection(1), null);
  assert.deepEqual(await plexConnectionStore.getPublicStatus(1), {
    connected: false,
    linkType: null,
    plexUsername: null,
    connectedAt: null,
    lastError: null,
  });
});

test("saveConnection round-trips and encrypts the token at rest", async () => {
  const saved = await plexConnectionStore.saveConnection(1, {
    linkType: "self",
    token: "plex-token-abc",
    clientId: "client-1",
    plexAccountId: 42,
    plexUuid: "uuid-42",
    plexUsername: "friend1",
  });
  assert.equal(saved.token, "plex-token-abc");
  assert.equal(saved.linkType, "self");
  assert.equal(saved.clientId, "client-1");
  assert.equal(saved.plexAccountId, 42);
  assert.equal(saved.linkedByAdminId, null);

  const raw = await db.get("SELECT value FROM settings WHERE key = ?", ["plexConnections"]);
  assert.ok(raw?.value);
  assert.ok(!raw.value.includes("plex-token-abc"), "raw token must not be stored in plaintext");

  const fetched = await plexConnectionStore.getConnection(1);
  assert.equal(fetched.token, "plex-token-abc");
});

test("getPublicStatus never leaks the token", async () => {
  await plexConnectionStore.saveConnection(2, {
    linkType: "managed",
    token: "super-secret",
    clientId: "client-2",
    plexAccountId: 7,
    plexUsername: "kid",
    linkedByAdminId: 1,
  });
  const status = await plexConnectionStore.getPublicStatus(2);
  assert.equal(status.connected, true);
  assert.equal(status.linkType, "managed");
  assert.equal(status.plexUsername, "kid");
  assert.equal(JSON.stringify(status).includes("super-secret"), false);
});

test("saveConnection rejects invalid linkType or missing token/clientId", async () => {
  await assert.rejects(() =>
    plexConnectionStore.saveConnection(3, { linkType: "admin", token: "t", clientId: "c" }),
  );
  await assert.rejects(() =>
    plexConnectionStore.saveConnection(3, { linkType: "self", token: "", clientId: "c" }),
  );
  await assert.rejects(() =>
    plexConnectionStore.saveConnection(3, { linkType: "self", token: "t", clientId: "" }),
  );
});

test("updateToken refreshes the token, keeps identity, and clears lastError", async () => {
  await plexConnectionStore.saveConnection(4, {
    linkType: "managed",
    token: "old-token",
    clientId: "client-4",
    plexAccountId: 9,
    plexUsername: "teen",
    linkedByAdminId: 1,
  });
  await plexConnectionStore.setLastError(4, "401 stale token");
  assert.equal(
    (await plexConnectionStore.getConnection(4)).lastError.message,
    "401 stale token",
  );

  const updated = await plexConnectionStore.updateToken(4, { token: "new-token" });
  assert.equal(updated.token, "new-token");
  assert.equal(updated.plexUsername, "teen");
  assert.equal(updated.lastError, null);
});

test("updateToken is a no-op when nothing is linked", async () => {
  assert.equal(await plexConnectionStore.updateToken(999, { token: "x" }), null);
});

test("clearConnection removes the entry and reports whether one existed", async () => {
  await plexConnectionStore.saveConnection(5, {
    linkType: "self",
    token: "t",
    clientId: "c",
    plexAccountId: 1,
  });
  assert.equal(await plexConnectionStore.clearConnection(5), true);
  assert.equal(await plexConnectionStore.getConnection(5), null);
  assert.equal(await plexConnectionStore.clearConnection(5), false);
});

test("getAllLinkedPlexAccountIds aggregates across users", async () => {
  await plexConnectionStore.saveConnection(6, {
    linkType: "self",
    token: "t",
    clientId: "c6",
    plexAccountId: 100,
  });
  await plexConnectionStore.saveConnection(7, {
    linkType: "managed",
    token: "t",
    clientId: "c7",
    plexAccountId: 200,
    linkedByAdminId: 1,
  });
  const ids = await plexConnectionStore.getAllLinkedPlexAccountIds();
  assert.ok(ids.has("100"));
  assert.ok(ids.has("200"));
  assert.equal(ids.size, 2);
});
