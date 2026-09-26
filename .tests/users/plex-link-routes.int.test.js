import test from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { userOps, userIdentityOps, dbOps },
  { plexConnectionStore },
  { createSession },
] = await setupIsolatedBackend(
  "plex-link-routes",
  "backend/config/database.js",
  "backend/db/helpers/index.js",
  "backend/services/plex/plexConnectionStore.js",
  "backend/config/session-helpers.js",
);

let server = null;
let adminId = null;
let userAId = null;
let userBId = null;
let adminToken = "";
let userAToken = "";
let userBToken = "";

async function login(username, password) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.token;
}

async function apiFetch(token, path, options = {}) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...options,
    headers,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload };
}

test.before(async () => {
  await resetDatabase();
  await dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  const admin = await userOps.createUser("plex-admin", bcrypt.hashSync("password123", 4), "admin");
  const userA = await userOps.createUser("plex-user-a", bcrypt.hashSync("password123", 4), "user");
  const userB = await userOps.createUser("plex-user-b", bcrypt.hashSync("password123", 4), "user");
  adminId = admin.id;
  userAId = userA.id;
  userBId = userB.id;

  server = await startServerProcess({
    extraEnv: { AURRAL_PG_SCHEMA: process.env.AURRAL_PG_SCHEMA },
  });
  adminToken = await login("plex-admin", "password123");
  userAToken = await login("plex-user-a", "password123");
  userBToken = await login("plex-user-b", "password123");
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("GET /me/plex-link/status requires authentication", async () => {
  const { response } = await apiFetch(null, "/api/users/me/plex-link/status");
  assert.equal(response.status, 401);
});

test("GET /me/plex-link/status reflects only the caller's own connection", async () => {
  await plexConnectionStore.saveConnection(userAId, {
    linkType: "self",
    token: "user-a-token",
    clientId: "user-a-client",
    plexAccountId: 111,
    plexUsername: "friendA",
  });

  const { response: resA, payload: payloadA } = await apiFetch(
    userAToken,
    "/api/users/me/plex-link/status",
  );
  assert.equal(resA.status, 200);
  assert.equal(payloadA.connected, true);
  assert.equal(payloadA.plexUsername, "friendA");

  const { response: resB, payload: payloadB } = await apiFetch(
    userBToken,
    "/api/users/me/plex-link/status",
  );
  assert.equal(resB.status, 200);
  assert.equal(payloadB.connected, false);
});

test("DELETE /me/plex-link only ever clears the caller's own connection, never another user's", async () => {
  await plexConnectionStore.saveConnection(userAId, {
    linkType: "self",
    token: "user-a-token",
    clientId: "user-a-client",
    plexAccountId: 111,
    plexUsername: "friendA",
  });

  const { response } = await apiFetch(userBToken, "/api/users/me/plex-link", {
    method: "DELETE",
  });
  assert.equal(response.status, 200);

  assert.equal(
    (await plexConnectionStore.getConnection(userAId))?.plexUsername,
    "friendA",
  );

  const { response: responseA } = await apiFetch(userAToken, "/api/users/me/plex-link", {
    method: "DELETE",
  });
  assert.equal(responseA.status, 200);
  assert.equal(await plexConnectionStore.getConnection(userAId), null);
});

test("POST /me/plex-link/oauth/complete validates required fields before touching Plex, and ignores any userId in the body", async () => {
  const { response, payload } = await apiFetch(
    userBToken,
    "/api/users/me/plex-link/oauth/complete",
    {
      method: "POST",
      body: JSON.stringify({ userId: userAId }),
    },
  );
  assert.equal(response.status, 400);
  assert.match(payload.error, /pinId, code and clientId are required/);
  assert.equal(await plexConnectionStore.getConnection(userAId), null);
  assert.equal(await plexConnectionStore.getConnection(userBId), null);
});

test("admin-only Plex routes reject non-admin users with 403", async () => {
  const homeUsers = await apiFetch(userAToken, "/api/users/plex-link/home-users");
  assert.equal(homeUsers.response.status, 403);

  const managed = await apiFetch(userAToken, `/api/users/${userBId}/plex-link/managed`, {
    method: "POST",
    body: JSON.stringify({ plexUserId: 1 }),
  });
  assert.equal(managed.response.status, 403);

  const unlink = await apiFetch(userAToken, `/api/users/${userBId}/plex-link`, {
    method: "DELETE",
  });
  assert.equal(unlink.response.status, 403);
});

test("GET /plex-link/home-users requires the global Plex connection to be configured first", async () => {
  const { response, payload } = await apiFetch(adminToken, "/api/users/plex-link/home-users");
  assert.equal(response.status, 400);
  assert.match(payload.error, /Connect the global Plex account/);
});

test("POST /:id/plex-link/managed 404s for an unknown user id", async () => {
  const { response } = await apiFetch(adminToken, "/api/users/999999/plex-link/managed", {
    method: "POST",
    body: JSON.stringify({ plexUserId: 1 }),
  });
  assert.equal(response.status, 404);
});

test("POST /:id/plex-link/managed requires the global Plex connection to be configured first", async () => {
  const { response, payload } = await apiFetch(
    adminToken,
    `/api/users/${userBId}/plex-link/managed`,
    {
      method: "POST",
      body: JSON.stringify({ plexUserId: 1 }),
    },
  );
  assert.equal(response.status, 400);
  assert.match(payload.error, /Connect the global Plex account/);
});

test("admin DELETE /:id/plex-link unlinks a managed user", async () => {
  await plexConnectionStore.saveConnection(userBId, {
    linkType: "managed",
    token: "managed-token",
    clientId: "managed-client",
    plexAccountId: 222,
    linkedByAdminId: adminId,
  });
  const { response } = await apiFetch(adminToken, `/api/users/${userBId}/plex-link`, {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.equal(await plexConnectionStore.getConnection(userBId), null);
});

// The server rate-limits /api/auth/login, so tests that are not about logging
// in start a session directly, the same row a login would create.
const sessionFor = async (user) =>
  (await createSession(user.id, "127.0.0.1", "test-agent")).token;

const ageSession = (token, ageMs) =>
  db.run("UPDATE sessions SET reauthenticated_at = ? WHERE token = ?", [Date.now() - ageMs, token]);

test("admin DELETE /:id/plex-link also removes the user's Plex login identity", async () => {
  const target = await userOps.createUser(
    "plex-login-target",
    bcrypt.hashSync("password123", 4),
    "user",
  );
  await plexConnectionStore.saveConnection(target.id, {
    linkType: "self",
    token: "target-token",
    clientId: "target-client",
    plexAccountId: 555,
    plexUsername: "targetPlex",
  });
  const identity = await userIdentityOps.link(target.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "555",
    displayName: "targetPlex",
  });

  const { response } = await apiFetch(adminToken, `/api/users/${target.id}/plex-link`, {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.equal(await plexConnectionStore.getConnection(target.id), null);
  assert.equal(
    await userIdentityOps.getById(identity.id),
    null,
    "admin unlink must remove the identity, not just the connection, so Plex sign-in stops working",
  );
});

test("admin Plex unlink requires an explicit, recently authenticated force to remove the final sign-in method", async () => {
  const target = await userOps.createUser(
    "plex-force-target",
    bcrypt.hashSync("unused-password", 4),
    "user",
    null,
    false,
  );
  await plexConnectionStore.saveConnection(target.id, {
    linkType: "self",
    token: "force-target-token",
    clientId: "force-target-client",
    plexAccountId: 991,
  });
  const identity = await userIdentityOps.link(target.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "991",
  });

  const blocked = await apiFetch(adminToken, `/api/users/${target.id}/plex-link`, {
    method: "DELETE",
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.payload.requiresForce, true);
  assert.ok(await plexConnectionStore.getConnection(target.id));

  await ageSession(adminToken, 20 * 60 * 1000);
  const staleForce = await apiFetch(
    adminToken,
    `/api/users/${target.id}/plex-link?force=true`,
    { method: "DELETE" },
  );
  assert.equal(staleForce.response.status, 401);
  assert.ok(await userIdentityOps.getById(identity.id));

  const reauth = await apiFetch(adminToken, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });
  assert.equal(reauth.response.status, 200);
  const forced = await apiFetch(
    adminToken,
    `/api/users/${target.id}/plex-link?force=true`,
    { method: "DELETE" },
  );
  assert.equal(forced.response.status, 200);
  assert.equal(forced.payload.forced, true);
  assert.equal(await plexConnectionStore.getConnection(target.id), null);
  assert.equal(await userIdentityOps.getById(identity.id), null);
});

test("Plex login routes are disabled unless integrations.plex.loginEnabled is set", async () => {
  const { response: pinResponse } = await apiFetch(null, "/api/auth/plex/login/pin", {
    method: "POST",
  });
  assert.equal(pinResponse.status, 404);

  const { response: completeResponse } = await apiFetch(null, "/api/auth/plex/login/complete", {
    method: "POST",
    body: JSON.stringify({ pinId: "x", code: "x", clientId: "x" }),
  });
  assert.equal(completeResponse.status, 404);
});

test("disconnecting Plex is blocked when it is the account's only usable auth method", async () => {
  const plexOnlyUser = await userOps.createUser(
    "plex-only-user",
    bcrypt.hashSync("unused-random-hash", 4),
    "user",
    null,
    false,
  );
  await plexConnectionStore.saveConnection(plexOnlyUser.id, {
    linkType: "self",
    token: "plex-only-token",
    clientId: "plex-only-client",
    plexAccountId: 333,
    plexUsername: "plexOnly",
  });
  const identity = await userIdentityOps.link(plexOnlyUser.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "333",
    displayName: "plexOnly",
  });

  const session = await createSession(plexOnlyUser.id, "127.0.0.1", "test-agent");

  const { response } = await apiFetch(session.token, "/api/users/me/plex-link", {
    method: "DELETE",
  });
  assert.equal(response.status, 400);
  assert.ok(await plexConnectionStore.getConnection(plexOnlyUser.id));
  assert.equal((await userIdentityOps.getById(identity.id))?.id, identity.id);
});

test("admin can suspend a user, which immediately invalidates their existing session", async () => {
  const target = await userOps.createUser(
    "suspendable-user",
    bcrypt.hashSync("password123", 4),
    "user",
  );
  const targetToken = await login("suspendable-user", "password123");
  assert.equal((await apiFetch(targetToken, "/api/auth/me")).response.status, 200);

  const { response } = await apiFetch(adminToken, `/api/users/${target.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "suspended" }),
  });
  assert.equal(response.status, 200);

  const { response: sessionCheck } = await apiFetch(targetToken, "/api/auth/me");
  assert.equal(sessionCheck.status, 401);

  const { response: loginAttempt } = await apiFetch(null, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "suspendable-user", password: "password123" }),
  });
  assert.equal(loginAttempt.status, 403);

  const { response: invalidStatus } = await apiFetch(adminToken, `/api/users/${target.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "banned" }),
  });
  assert.equal(invalidStatus.status, 400);
});

test("a user cannot change their own status or approve their own adoption", async () => {
  const user = await userOps.createUser("self-status-user", bcrypt.hashSync("password123", 4));
  const token = await sessionFor(user);
  for (const body of [{ status: "disabled" }, { allowIdentityAdoption: true }]) {
    const { response } = await apiFetch(token, `/api/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403);
  }
  assert.equal((await userOps.getUserById(user.id)).status, "active");
});

test("a protected admin cannot suspend or disable their own account", async () => {
  const protectedAdmin = await userOps.createUser(
    "protected-admin",
    bcrypt.hashSync("password123", 4),
    "admin",
  );
  await userOps.setProtected(protectedAdmin.id, true);
  const protectedAdminToken = await sessionFor(protectedAdmin);

  const { response } = await apiFetch(protectedAdminToken, `/api/users/${protectedAdmin.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "suspended" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await userOps.getUserById(protectedAdmin.id))?.status, "active");
});

test("an admin cannot suspend or disable their own account", async () => {
  const { response } = await apiFetch(adminToken, `/api/users/${adminId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "suspended" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await userOps.getUserById(adminId))?.status, "active");
  assert.equal((await apiFetch(adminToken, "/api/auth/me")).response.status, 200);
});

test("a different admin also cannot suspend or disable a protected recovery account", async () => {
  const protectedAdmin = await userOps.createUser(
    "protected-admin-2",
    bcrypt.hashSync("password123", 4),
    "admin",
  );
  await userOps.setProtected(protectedAdmin.id, true);

  const { response } = await apiFetch(adminToken, `/api/users/${protectedAdmin.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await userOps.getUserById(protectedAdmin.id))?.status, "active");
});

test("disconnecting Plex succeeds and removes the login identity when a fallback method exists", async () => {
  await plexConnectionStore.saveConnection(userAId, {
    linkType: "self",
    token: "user-a-token-2",
    clientId: "user-a-client-2",
    plexAccountId: 444,
    plexUsername: "friendA2",
  });
  const identity = await userIdentityOps.link(userAId, {
    providerType: "plex",
    providerKey: "plex",
    subject: "444",
    displayName: "friendA2",
  });
  const token = await sessionFor({ id: userAId });

  const { response } = await apiFetch(token, "/api/users/me/plex-link", {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.equal(await plexConnectionStore.getConnection(userAId), null);
  assert.equal(await userIdentityOps.getById(identity.id), null);
});

test("only an admin can approve a legacy account for SSO adoption, and only an eligible one", async () => {
  const legacy = await userOps.createUser(
    "adoption-candidate",
    bcrypt.hashSync("password123", 4),
    "user",
    null,
    false,
  );
  await userOps.updateUser(legacy.id, { needsIdentityMigration: true });

  const legacyToken = await sessionFor(legacy);
  const { response: selfResponse } = await apiFetch(legacyToken, `/api/users/${legacy.id}`, {
    method: "PATCH",
    body: JSON.stringify({ allowIdentityAdoption: true }),
  });
  assert.equal(selfResponse.status, 403, "a user must not be able to approve their own adoption");
  assert.equal((await userOps.getUserById(legacy.id)).allowIdentityAdoption, false);

  const { response: adminResponse } = await apiFetch(adminToken, `/api/users/${legacy.id}`, {
    method: "PATCH",
    body: JSON.stringify({ allowIdentityAdoption: true }),
  });
  assert.equal(adminResponse.status, 200);
  assert.equal((await userOps.getUserById(legacy.id)).allowIdentityAdoption, true);

  const modern = await userOps.createUser("modern-user", bcrypt.hashSync("password123", 4), "user");
  const { response: modernResponse } = await apiFetch(adminToken, `/api/users/${modern.id}`, {
    method: "PATCH",
    body: JSON.stringify({ allowIdentityAdoption: true }),
  });
  assert.equal(modernResponse.status, 400);
  assert.equal((await userOps.getUserById(modern.id)).allowIdentityAdoption, false);
});

test("the protected recovery account can never be approved for SSO adoption", async () => {
  const protectedLegacy = await userOps.createUser(
    "protected-legacy-admin",
    bcrypt.hashSync("password123", 4),
    "admin",
    null,
    false,
  );
  await userOps.updateUser(protectedLegacy.id, { needsIdentityMigration: true });
  await userOps.setProtected(protectedLegacy.id, true);

  const { response } = await apiFetch(adminToken, `/api/users/${protectedLegacy.id}`, {
    method: "PATCH",
    body: JSON.stringify({ allowIdentityAdoption: true }),
  });
  assert.equal(response.status, 400);
  assert.equal((await userOps.getUserById(protectedLegacy.id)).allowIdentityAdoption, false);
});

test("disconnecting Plex requires a recent reauth, same as the generic identity-unlink route", async () => {
  const target = await userOps.createUser(
    "plex-reauth-user",
    bcrypt.hashSync("password123", 4),
    "user",
  );
  await plexConnectionStore.saveConnection(target.id, {
    linkType: "self",
    token: "reauth-token",
    clientId: "reauth-client",
    plexAccountId: 666,
    plexUsername: "reauthPlex",
  });
  await userIdentityOps.link(target.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "666",
    displayName: "reauthPlex",
  });
  const targetToken = await sessionFor(target);

  await ageSession(targetToken, 20 * 60 * 1000);

  const { response: staleResponse } = await apiFetch(targetToken, "/api/users/me/plex-link", {
    method: "DELETE",
  });
  assert.equal(staleResponse.status, 401);
  assert.ok(await plexConnectionStore.getConnection(target.id));

  await apiFetch(targetToken, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });

  const { response: freshResponse } = await apiFetch(targetToken, "/api/users/me/plex-link", {
    method: "DELETE",
  });
  assert.equal(freshResponse.status, 200);
  assert.equal(await plexConnectionStore.getConnection(target.id), null);
});

test("Plex login rejects an unsafe forwardUrl before ever contacting Plex", async () => {
  const settingsSave = await apiFetch(adminToken, "/api/settings", {
    method: "POST",
    body: JSON.stringify({
      integrations: {
        plex: { loginEnabled: true, url: "http://plex.example.com:32400", token: "fake-token" },
      },
    }),
  });
  assert.equal(settingsSave.response.status, 200, JSON.stringify(settingsSave.payload));

  const { payload: bootstrap } = await apiFetch(null, "/api/health/bootstrap");
  assert.equal(bootstrap.plexLoginEnabled, true);

  for (const forwardUrl of [
    "https://evil.example.com/steal",
    "//evil.example.com/steal",
    "/\\evil.example.com/steal",
    "/\tevil.example.com/steal",
  ]) {
    const { response } = await apiFetch(null, "/api/auth/plex/login/pin", {
      method: "POST",
      body: JSON.stringify({ forwardUrl }),
    });
    assert.equal(response.status, 400, forwardUrl);
  }
});

test("Plex login complete rejects a request with no valid transaction cookie, even with a guessed pinId/code/clientId", async () => {
  const { response } = await apiFetch(null, "/api/auth/plex/login/complete", {
    method: "POST",
    body: JSON.stringify({ pinId: "attacker-pin", code: "attacker-code", clientId: "attacker-client" }),
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") || "", /json/);
});
