import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import bcrypt from "bcrypt";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { db },
  { userOps, dbOps },
  { createSession, touchReauth },
  auth,
  permissions,
] = await setupIsolatedBackend(
  "recent-auth",
  "backend/config/database.js",
  "backend/db/helpers/index.js",
  "backend/config/session-helpers.js",
  "backend/middleware/auth.js",
  "backend/middleware/requirePermission.js",
);

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });
const ageSession = (token, ageMs) =>
  db.run("UPDATE sessions SET reauthenticated_at = ? WHERE token = ?", [Date.now() - ageMs, token]);

test.beforeEach(() => resetDatabase());
test.after(async () => cleanupIsolatedState(isolatedState));

test("recent authentication requires a valid bearer session", async () => {
  const user = await userOps.createUser("recent-user", bcrypt.hashSync("password123", 4));
  const session = await createSession(user.id);

  assert.equal(await permissions.isRecentlyAuthenticated({ headers: {} }), false);
  assert.equal(await permissions.isRecentlyAuthenticated(bearer(session.token)), true);
  assert.equal(await permissions.isRecentlyAuthenticated(bearer("not-a-session")), false);
});

test("a stale session is re-armed only by touching its own token", async () => {
  const user = await userOps.createUser("stale-user", bcrypt.hashSync("password123", 4));
  const other = await userOps.createUser("other-user", bcrypt.hashSync("password123", 4));
  const session = await createSession(user.id);
  await ageSession(session.token, 20 * 60 * 1000);
  assert.equal(await permissions.isRecentlyAuthenticated(bearer(session.token)), false);

  assert.equal(await touchReauth(session.token, other.id), false);
  assert.equal(await permissions.isRecentlyAuthenticated(bearer(session.token)), false);

  assert.equal(await touchReauth(session.token, user.id), true);
  assert.equal(await permissions.isRecentlyAuthenticated(bearer(session.token)), true);
});

test("a session only counts as recent authentication for its own user", async () => {
  const user = await userOps.createUser("session-owner", bcrypt.hashSync("password123", 4));
  const session = await createSession(user.id);
  assert.equal(
    await permissions.isRecentlyAuthenticated({ ...bearer(session.token), user: { id: user.id + 1 } }),
    false,
  );
});

test("requireRecentAuth answers reauth_required for a stale session", async () => {
  const user = await userOps.createUser("middleware-user", bcrypt.hashSync("password123", 4));
  const session = await createSession(user.id);
  await ageSession(session.token, 20 * 60 * 1000);
  const middleware = permissions.requireRecentAuth();
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCalled = false;
  await middleware({ ...bearer(session.token), user: { id: user.id } }, response, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, "reauth_required");
});

test("password and Subsonic authentication reject inactive users", async () => {
  const password = "password123";
  const user = await userOps.createUser(
    "inactive-user",
    bcrypt.hashSync(password, 4),
    "user",
    null,
    true,
    false,
    password,
  );
  await userOps.updateUser(user.id, { status: "suspended" });

  assert.equal(await auth.resolveUser("inactive-user", password), null);
  const salt = "test-salt";
  const token = crypto.createHash("md5").update(`${password}${salt}`).digest("hex");
  assert.equal(await auth.resolveSubsonicTokenUser("inactive-user", token, salt), null);

  await userOps.updateUser(user.id, { status: "active" });
  assert.equal((await auth.resolveUser("inactive-user", password))?.id, user.id);
  assert.equal((await auth.resolveSubsonicTokenUser("inactive-user", token, salt))?.id, user.id);
});

test("Basic authentication cannot restore legacy admin access for an inactive database user", async () => {
  const password = "legacy-password";
  await dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      general: { authUser: "configured-admin", authPassword: password },
    },
  });
  const user = await userOps.createUser(
    "configured-admin",
    bcrypt.hashSync(password, 4),
    "admin",
  );
  await userOps.updateUser(user.id, { status: "suspended" });
  const basic = Buffer.from(`configured-admin:${password}`).toString("base64");

  assert.equal(
    await auth.resolveRequestUser({ headers: { authorization: `Basic ${basic}` } }),
    null,
  );
  const streamRequest = {
    headers: { authorization: `Basic ${basic}` },
    query: {},
  };
  assert.equal(await auth.verifyTokenAuth(streamRequest), false);
  assert.equal(streamRequest.user, undefined);
});

test("trusted-local bypass rejects an inactive sole administrator", async () => {
  const user = await userOps.createUser("local-admin", bcrypt.hashSync("password123", 4), "admin");
  await userOps.updateUser(user.id, { status: "disabled" });
  await dbOps.updateSettings({
    onboardingComplete: true,
    security: { localNetworkBypass: { enabled: true } },
  });
  const req = {
    ip: "127.0.0.1",
    ips: [],
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    connection: { remoteAddress: "127.0.0.1" },
  };

  assert.equal(await auth.resolveLocalNetworkBypassUser(req), null);
});

test("stream tokens of a deactivated user are revoked", async () => {
  const user = await userOps.createUser("streamer", bcrypt.hashSync("password123", 4));
  const token = auth.issueStreamToken({ id: user.id, username: "streamer", role: "user" });
  const other = auth.issueStreamToken({ id: user.id + 1, username: "other", role: "user" });

  assert.equal(auth.revokeStreamTokensForUser(user.id), 1);
  const revokedRequest = { headers: {}, query: { st: token } };
  await dbOps.updateSettings({
    onboardingComplete: true,
    integrations: { general: { authUser: "admin", authPassword: "legacy" } },
  });
  assert.equal(await auth.verifyTokenAuth(revokedRequest), false);
  const otherRequest = { headers: {}, query: { st: other } };
  assert.equal(await auth.verifyTokenAuth(otherRequest), true);
});

test("media routes require authentication once accounts exist", async () => {
  const anonymous = () => ({ headers: {}, query: {} });
  assert.equal(await auth.verifyTokenAuth(anonymous()), true, "open before onboarding");

  await userOps.createUser("owner", bcrypt.hashSync("password123", 4), "admin");
  await dbOps.updateSettings({ onboardingComplete: true });
  assert.equal(await auth.verifyTokenAuth(anonymous()), false);

  const user = await userOps.createUser("listener", bcrypt.hashSync("password123", 4));
  const session = await createSession(user.id);
  const withSession = { headers: {}, query: { token: session.token } };
  assert.equal(await auth.verifyTokenAuth(withSession), true);
  assert.equal(withSession.user?.id, user.id);
});

test("a forwarded loopback address does not count as a local request", () => {
  const request = (peer, forwarded) => ({
    ip: forwarded ?? peer,
    ips: forwarded ? [forwarded] : [],
    headers: {},
    socket: { remoteAddress: peer },
    connection: { remoteAddress: peer },
  });

  // A client reaching Aurral directly claims loopback in X-Forwarded-For.
  assert.equal(auth.isRequestFromTrustedLocalSubnet(request("203.0.113.9", "127.0.0.1")), false);
  // A local reverse proxy forwarding an internet client.
  assert.equal(auth.isRequestFromTrustedLocalSubnet(request("127.0.0.1", "203.0.113.9")), false);
  assert.equal(auth.isRequestFromTrustedLocalSubnet(request("127.0.0.1")), true);
  // TRUST_PROXY=false: Express reports the proxy and ignores the header.
  const untrustedForward = {
    ...request("127.0.0.1"),
    headers: { "x-forwarded-for": "203.0.113.9", forwarded: 'for="[2001:db8::1]"' },
  };
  assert.equal(auth.isRequestFromTrustedLocalSubnet(untrustedForward), false);
});
