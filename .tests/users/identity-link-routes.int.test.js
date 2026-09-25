import test from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
  startServerProcess,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { userOps, userIdentityOps, dbOps },
  { createSession },
  { plexConnectionStore },
] = await setupIsolatedBackend(
  "identity-link-routes",
  "backend/config/database.js",
  "backend/db/helpers/index.js",
  "backend/config/session-helpers.js",
  "backend/services/plex/plexConnectionStore.js",
);

let server = null;

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

const ageSessionByToken = (token, ageMs) =>
  db.run("UPDATE sessions SET reauthenticated_at = ? WHERE token = ?", [Date.now() - ageMs, token]);

// The server rate-limits /api/auth/login (10 per 15 minutes, shared with the
// password route), so tests that are not about logging in start a session
// directly, the same row a login would create.
const sessionFor = async (user) =>
  (await createSession(user.id, "127.0.0.1", "test-agent")).token;

// The server keeps its own settings mirror and encryption key, so the database
// is reset once before it starts; every test uses its own accounts.
test.before(async () => {
  await resetDatabase();
  await dbOps.updateSettings({ integrations: {}, onboardingComplete: true });
  server = await startServerProcess({
    extraEnv: { AURRAL_PG_SCHEMA: process.env.AURRAL_PG_SCHEMA },
  });
});

test.after(async () => {
  await server?.stop();
  await cleanupIsolatedState(isolatedState);
});

test("GET /me/identities requires authentication", async () => {
  const { response } = await apiFetch(null, "/api/users/me/identities");
  assert.equal(response.status, 401);
});

test("GET /me/identities lists only the caller's own linked identities", async () => {
  const userA = await userOps.createUser("identity-user-a", bcrypt.hashSync("password123", 4), "user");
  const userB = await userOps.createUser("identity-user-b", bcrypt.hashSync("password123", 4), "user");
  await userIdentityOps.link(userA.id, {
    providerType: "oidc",
    providerKey: "https://issuer.example/",
    subject: "sub-a",
    displayName: "a@example.com",
  });

  const tokenA = await sessionFor(userA);
  const tokenB = await sessionFor(userB);

  const { response: resA, payload: payloadA } = await apiFetch(tokenA, "/api/users/me/identities");
  assert.equal(resA.status, 200);
  assert.equal(payloadA.hasLocalPassword, true);
  assert.equal(payloadA.identities.length, 1);
  assert.equal(payloadA.identities[0].providerType, "oidc");
  assert.equal(payloadA.identities[0].subject, undefined, "subjects are not exposed");

  const { payload: payloadB } = await apiFetch(tokenB, "/api/users/me/identities");
  assert.equal(payloadB.identities.length, 0);
});

test("reauth accepts the correct password and rejects an incorrect one", async () => {
  const user = await userOps.createUser("reauth-user", bcrypt.hashSync("password123", 4), "user");
  const token = await sessionFor(user);

  const { response: badResponse } = await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "wrong-password" }),
  });
  assert.equal(badResponse.status, 400);

  const { response: goodResponse, payload } = await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });
  assert.equal(goodResponse.status, 200);
  assert.equal(payload.success, true);
});

test("reauth is refused for an account without a local password", async () => {
  const external = await userOps.createUser(
    "reauth-external-user",
    bcrypt.hashSync("unknown-random-hash", 4),
    "user",
    null,
    false,
  );
  const session = await createSession(external.id, "127.0.0.1", "test-agent");
  const { response, payload } = await apiFetch(session.token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "unknown-random-hash" }),
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "no_local_password");
});

test("unlinking an identity requires a recent reauth and succeeds after confirming it", async () => {
  const user = await userOps.createUser(
    "stale-session-user",
    bcrypt.hashSync("password123", 4),
    "user",
  );
  const identity = await userIdentityOps.link(user.id, {
    providerType: "oidc",
    providerKey: "https://issuer.example/",
    subject: "sub-stale",
  });
  const token = await sessionFor(user);

  await ageSessionByToken(token, 20 * 60 * 1000);
  const { response: staleResponse, payload: stalePayload } = await apiFetch(
    token,
    `/api/users/me/identities/${identity.id}`,
    { method: "DELETE" },
  );
  assert.equal(staleResponse.status, 401);
  assert.equal(stalePayload.error, "reauth_required");

  await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });

  const { response: freshResponse, payload } = await apiFetch(
    token,
    `/api/users/me/identities/${identity.id}`,
    { method: "DELETE" },
  );
  assert.equal(freshResponse.status, 200);
  assert.equal(payload.success, true);
  assert.equal(await userIdentityOps.countForUser(user.id), 0);
});

test("unlinking a nonexistent or another user's identity 404s", async () => {
  const userA = await userOps.createUser("owner-user", bcrypt.hashSync("password123", 4), "user");
  const userB = await userOps.createUser("other-user", bcrypt.hashSync("password123", 4), "user");
  const identity = await userIdentityOps.link(userA.id, {
    providerType: "oidc",
    providerKey: "https://issuer.example/",
    subject: "sub-owner",
  });
  const tokenB = await sessionFor(userB);

  const { response } = await apiFetch(tokenB, `/api/users/me/identities/${identity.id}`, {
    method: "DELETE",
  });
  assert.equal(response.status, 404);
  assert.equal(await userIdentityOps.countForUser(userA.id), 1);

  const { response: missing } = await apiFetch(tokenB, "/api/users/me/identities/999999", {
    method: "DELETE",
  });
  assert.equal(missing.status, 404);
});

test("a successful local login records that the account has a usable local password", async () => {
  const legacy = await userOps.createUser(
    "legacy-local-user",
    bcrypt.hashSync("password123", 4),
    "user",
    null,
    false,
  );
  assert.equal((await userOps.getUserById(legacy.id)).hasLocalPassword, false);

  await login("legacy-local-user", "password123");

  assert.equal(
    (await userOps.getUserById(legacy.id)).hasLocalPassword,
    true,
    "logging in with a password proves one exists, which re-arms lockout and password-change checks",
  );
});

test("changing a password requires a recent auth, so a stale session cannot take the account over", async () => {
  const user = await userOps.createUser(
    "stale-password-user",
    bcrypt.hashSync("password123", 4),
    "user",
  );
  const token = await sessionFor(user);

  await ageSessionByToken(token, 20 * 60 * 1000);
  const { response: staleResponse } = await apiFetch(token, "/api/users/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123", newPassword: "brand-new-password" }),
  });
  assert.equal(staleResponse.status, 401);

  await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });

  const { response: freshResponse } = await apiFetch(token, "/api/users/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123", newPassword: "brand-new-password" }),
  });
  assert.equal(freshResponse.status, 200);
});

test("an account without a local password sets one from a fresh session without a current password", async () => {
  const external = await userOps.createUser(
    "fresh-external-user",
    bcrypt.hashSync("unknown-random-hash", 4),
    "user",
    null,
    false,
  );
  const session = await createSession(external.id, "127.0.0.1", "test-agent");
  const { response } = await apiFetch(session.token, "/api/users/me/password", {
    method: "POST",
    body: JSON.stringify({ newPassword: "first-local-password" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await userOps.getUserById(external.id)).hasLocalPassword, true);
  await login("fresh-external-user", "first-local-password");
});

test("lockout protection blocks removing the last usable auth method", async () => {
  const passwordHash = bcrypt.hashSync("unused-random-hash", 4);
  const oidcOnlyUser = await userOps.createUser("oidc-only-user", passwordHash, "user", null, false);
  const identity = await userIdentityOps.link(oidcOnlyUser.id, {
    providerType: "oidc",
    providerKey: "https://issuer.example/",
    subject: "sub-only",
  });

  const session = await createSession(oidcOnlyUser.id, "127.0.0.1", "test-agent");

  const { response, payload } = await apiFetch(
    session.token,
    `/api/users/me/identities/${identity.id}`,
    { method: "DELETE" },
  );
  assert.equal(response.status, 400);
  assert.equal(payload.error, "last_auth_method");
  assert.equal(await userIdentityOps.countForUser(oidcOnlyUser.id), 1);
});

test("removing Plex from connected accounts also clears its saved connection", async () => {
  const user = await userOps.createUser("generic-plex-unlink", bcrypt.hashSync("password123", 4));
  const identity = await userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "generic-plex-subject",
  });
  await plexConnectionStore.saveConnection(user.id, {
    linkType: "self",
    token: "generic-plex-token",
    clientId: "generic-plex-client",
    plexAccountId: "generic-plex-subject",
  });
  const token = await sessionFor(user);

  const { response } = await apiFetch(token, `/api/users/me/identities/${identity.id}`, {
    method: "DELETE",
  });

  assert.equal(response.status, 200);
  assert.equal(await userIdentityOps.getById(identity.id), null);
  assert.equal(await plexConnectionStore.getConnection(user.id), null);
});

test("replacing a provider identity removes the former Plex subject", async () => {
  const user = await userOps.createUser("plex-replacement", bcrypt.hashSync("password123", 4));
  await userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "former-subject",
  });

  await userIdentityOps.replaceForUser(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "replacement-subject",
  });

  assert.equal(await userIdentityOps.findByProvider("plex", "plex", "former-subject"), null);
  assert.equal(
    (await userIdentityOps.findByProvider("plex", "plex", "replacement-subject"))?.userId,
    user.id,
  );
});

test("a conflicting Plex identity rolls back the connection and identity replacement", async () => {
  const { persistSelfPlexLink } = await importFromRepo(
    "backend/routes/users/plexLinkHandlers.js",
  );
  const owner = await userOps.createUser("plex-conflict-owner", "unused", "user");
  const contender = await userOps.createUser("plex-conflict-contender", "unused", "user");
  await userIdentityOps.link(owner.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "claimed-subject",
  });
  const originalIdentity = await userIdentityOps.link(contender.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "original-subject",
  });
  await plexConnectionStore.saveConnection(contender.id, {
    linkType: "self",
    token: "original-token",
    clientId: "original-client",
    plexAccountId: "original-subject",
  });

  await assert.rejects(
    () =>
      persistSelfPlexLink(
        contender.id,
        {
          linkType: "self",
          token: "replacement-token",
          clientId: "replacement-client",
          plexAccountId: "claimed-subject",
        },
        {
          providerType: "plex",
          providerKey: "plex",
          subject: "claimed-subject",
        },
      ),
    (error) => error?.code === "23505",
  );

  const connection = await plexConnectionStore.getConnection(contender.id);
  assert.equal(connection.token, "original-token");
  assert.equal(connection.clientId, "original-client");
  assert.equal(connection.plexAccountId, "original-subject");
  assert.equal((await userIdentityOps.getById(originalIdentity.id))?.subject, "original-subject");
  assert.equal(
    (await userIdentityOps.findByProvider("plex", "plex", "claimed-subject"))?.userId,
    owner.id,
  );
});

test("a disabled user's session and Basic credentials stop working until reactivation", async () => {
  const admin = await userOps.createUser("identity-admin", bcrypt.hashSync("password123", 4), "admin");
  const target = await userOps.createUser("identity-suspend-target", bcrypt.hashSync("password123", 4));
  const adminToken = await sessionFor(admin);
  const targetToken = await sessionFor(target);

  const { response } = await apiFetch(adminToken, `/api/users/${target.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await apiFetch(targetToken, "/api/auth/me")).response.status, 401);
  const basic = Buffer.from("identity-suspend-target:password123").toString("base64");
  const { response: basicResponse } = await apiFetch(null, "/api/auth/me", {
    headers: { Authorization: `Basic ${basic}` },
  });
  assert.equal(basicResponse.status, 401);
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?", [target.id])).count, 0);

  const { response: reactivate } = await apiFetch(adminToken, `/api/users/${target.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "active" }),
  });
  assert.equal(reactivate.status, 200);
  await login("identity-suspend-target", "password123");
});

test("an admin setting any password, their own included, needs a recent sign-in", async () => {
  const admin = await userOps.createUser("password-admin", bcrypt.hashSync("password123", 4), "admin");
  const token = await sessionFor(admin);
  await ageSessionByToken(token, 20 * 60 * 1000);

  const { response: staleResponse, payload } = await apiFetch(token, `/api/users/${admin.id}`, {
    method: "PATCH",
    body: JSON.stringify({ password: "another-password-1" }),
  });
  assert.equal(staleResponse.status, 401);
  assert.equal(payload.error, "reauth_required");

  await apiFetch(token, "/api/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "password123" }),
  });
  const { response: freshResponse } = await apiFetch(token, `/api/users/${admin.id}`, {
    method: "PATCH",
    body: JSON.stringify({ password: "another-password-1" }),
  });
  assert.equal(freshResponse.status, 200);
});

test("the bootstrap payload advertises SSO-only mode and the secondary login providers", async () => {
  const { response, payload } = await apiFetch(null, "/api/health/bootstrap");
  assert.equal(response.status, 200);
  assert.equal(payload.googleLoginEnabled, false);
  assert.equal(payload.plexLoginEnabled, false);
  assert.equal(payload.ssoOnly, false);
});
