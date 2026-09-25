import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, , dbHelpers, authModule, sessionModule] = await setupIsolatedBackend(
  "proxy-auth",
  "backend/config/database.js",
  "backend/db/helpers/index.js",
  "backend/middleware/auth.js",
  "backend/config/session-helpers.js",
);

const { dbOps, userOps } = dbHelpers;
const { isProxyAuthEnabled, issueProxySession, resolveProxyUser, resolveRequestUser } = authModule;
const { getSessionByToken } = sessionModule;

const completeOnboarding = () => dbOps.updateSettings({ onboardingComplete: true });

function proxyRequest(headers = {}, remoteAddress = "127.0.0.1") {
  return {
    headers,
    socket: { remoteAddress },
    connection: { remoteAddress },
    ip: remoteAddress,
    ips: [remoteAddress],
  };
}

function resetProxyEnv() {
  process.env.AUTH_PROXY_ENABLED = "true";
  delete process.env.AUTH_PROXY_HEADER;
  delete process.env.AUTH_PROXY_TRUSTED_IPS;
  delete process.env.AUTH_PROXY_DEFAULT_ROLE;
  delete process.env.AUTH_PROXY_ADMIN_USERS;
  delete process.env.AUTH_PROXY_ROLE_HEADER;
  delete process.env.AUTH_PROXY_ADMIN_GROUPS;
}

test.beforeEach(async () => {
  await resetDatabase();
  resetProxyEnv();
  await dbOps.updateSettings({ onboardingComplete: false });
});

test.after(async () => {
  delete process.env.AUTH_PROXY_ENABLED;
  delete process.env.AUTH_PROXY_HEADER;
  delete process.env.AUTH_PROXY_TRUSTED_IPS;
  delete process.env.AUTH_PROXY_DEFAULT_ROLE;
  delete process.env.AUTH_PROXY_ADMIN_USERS;
  delete process.env.AUTH_PROXY_ROLE_HEADER;
  delete process.env.AUTH_PROXY_ADMIN_GROUPS;
  await cleanupIsolatedState(isolatedState);
});

test("proxy auth creates a persistent user for a new proxied identity", async () => {
  const resolved = await resolveProxyUser(
    proxyRequest({ "x-forwarded-user": "Alice@example.com" }),
  );

  assert.ok(resolved);
  assert.notEqual(resolved.id, -1);
  assert.equal(resolved.username, "alice@example.com");
  assert.equal(resolved.role, "user");
  assert.equal(resolved.permissions.addArtist, true);
  assert.equal(resolved.permissions.accessFlow, false);
  assert.equal(resolved.permissions.accessSettings, false);

  const stored = await userOps.getUserByUsername("Alice@example.com");
  assert.equal(stored?.id, resolved.id);
  assert.equal(stored?.username, "alice@example.com");
  assert.ok(stored?.passwordHash);

  const secondResolve = await resolveProxyUser(
    proxyRequest({ "x-forwarded-user": "alice@example.com" }),
  );
  assert.equal(secondResolve?.id, resolved.id);
  assert.equal((await userOps.getAllUsers()).length, 1);
});

test("proxy auth creates configured admin users as admins", async () => {
  process.env.AUTH_PROXY_ADMIN_USERS = "sso-admin";

  const resolved = await resolveProxyUser(
    proxyRequest({ "x-forwarded-user": "sso-admin" }),
  );

  assert.ok(resolved);
  assert.equal(resolved.role, "admin");
  assert.equal(resolved.permissions.accessSettings, true);
  assert.equal((await userOps.getUserByUsername("sso-admin"))?.role, "admin");
});

test("proxy auth does not create users from untrusted proxy IPs", async () => {
  process.env.AUTH_PROXY_TRUSTED_IPS = "10.0.0.1";

  const resolved = await resolveProxyUser(
    proxyRequest({ "x-forwarded-user": "mallory" }, "192.168.1.10"),
  );

  assert.equal(resolved, null);
  assert.equal((await userOps.getAllUsers()).length, 0);
});

test("explicitly disabling proxy auth overrides a configured header", async () => {
  process.env.AUTH_PROXY_ENABLED = "false";
  process.env.AUTH_PROXY_HEADER = "x-authentik-username";

  assert.equal(isProxyAuthEnabled(), false);
  assert.equal(
    await resolveProxyUser(proxyRequest({ "x-authentik-username": "mallory" })),
    null,
  );
  assert.equal((await userOps.getAllUsers()).length, 0);
});

test("the proxy auth switch ignores case and surrounding spaces", () => {
  process.env.AUTH_PROXY_ENABLED = " TRUE ";
  assert.equal(isProxyAuthEnabled(), true);
  process.env.AUTH_PROXY_ENABLED = "False";
  process.env.AUTH_PROXY_HEADER = "x-authentik-username";
  assert.equal(isProxyAuthEnabled(), false);
});

test("proxy auth grants admin via AUTH_PROXY_ADMIN_GROUPS membership", async () => {
  process.env.AUTH_PROXY_ROLE_HEADER = "remote-groups";
  process.env.AUTH_PROXY_ADMIN_GROUPS = "app-arrstack-admin";

  const resolved = await resolveProxyUser(
    proxyRequest({
      "x-forwarded-user": "bob",
      "remote-groups": "app-arrstack-admin,users",
    }),
  );

  assert.ok(resolved);
  assert.equal(resolved.role, "admin");
  assert.equal((await userOps.getUserByUsername("bob"))?.role, "admin");
});

test("proxy auth does not grant admin for a literal 'admin' group unless configured", async () => {
  process.env.AUTH_PROXY_ROLE_HEADER = "remote-groups";

  const resolved = await resolveProxyUser(
    proxyRequest({
      "x-forwarded-user": "carol",
      "remote-groups": "admin",
    }),
  );

  assert.ok(resolved);
  assert.equal(resolved.role, "user");
});

test("proxy auth issues one Aurral session that outlives the identity header", async () => {
  await completeOnboarding();
  const issued = await issueProxySession(proxyRequest({ "x-forwarded-user": "erin" }));

  assert.ok(issued?.token);
  assert.equal((await getSessionByToken(issued.token))?.user?.username, "erin");

  const headerlessRequest = proxyRequest({ authorization: `Bearer ${issued.token}` });
  assert.equal((await resolveRequestUser(headerlessRequest))?.username, "erin");

  assert.equal(await issueProxySession(headerlessRequest), null);
});

test("proxy auth issues no session without a trusted identity header", async () => {
  await completeOnboarding();
  assert.equal(await issueProxySession(proxyRequest()), null);

  process.env.AUTH_PROXY_TRUSTED_IPS = "10.0.0.1";
  assert.equal(
    await issueProxySession(proxyRequest({ "x-forwarded-user": "mallory" }, "192.168.1.10")),
    null,
  );
});

test("proxy auth issues no session while onboarding leaves authentication off", async () => {
  assert.equal(await issueProxySession(proxyRequest({ "x-forwarded-user": "frank" })), null);

  await completeOnboarding();
  assert.ok((await issueProxySession(proxyRequest({ "x-forwarded-user": "frank" })))?.token);
});

test("proxy auth re-syncs role on every request instead of only at creation", async () => {
  const created = await resolveProxyUser(proxyRequest({ "x-forwarded-user": "dave" }));
  assert.equal(created.role, "user");

  process.env.AUTH_PROXY_ADMIN_USERS = "dave";
  const promoted = await resolveProxyUser(proxyRequest({ "x-forwarded-user": "dave" }));
  assert.equal(promoted.role, "admin");
  assert.equal((await userOps.getUserByUsername("dave"))?.role, "admin");

  delete process.env.AUTH_PROXY_ADMIN_USERS;
  const demoted = await resolveProxyUser(proxyRequest({ "x-forwarded-user": "dave" }));
  assert.equal(demoted.role, "user");
  assert.equal((await userOps.getUserByUsername("dave"))?.role, "user");
});

test("proxy auth resolves no user for a suspended or disabled identity", async () => {
  await completeOnboarding();
  const created = await resolveProxyUser(proxyRequest({ "x-forwarded-user": "gina" }));
  assert.ok(created);

  await userOps.updateUser(created.id, { status: "suspended" });
  assert.equal(await resolveProxyUser(proxyRequest({ "x-forwarded-user": "gina" })), null);
  assert.equal(await issueProxySession(proxyRequest({ "x-forwarded-user": "gina" })), null);
  assert.equal(await resolveRequestUser(proxyRequest({ "x-forwarded-user": "gina" })), null);

  await userOps.updateUser(created.id, { status: "disabled" });
  assert.equal(await resolveProxyUser(proxyRequest({ "x-forwarded-user": "gina" })), null);
});

test("an existing session is invalidated once its user is suspended", async () => {
  await completeOnboarding();
  const issued = await issueProxySession(proxyRequest({ "x-forwarded-user": "hank" }));
  assert.ok(issued?.token);
  assert.equal((await getSessionByToken(issued.token))?.user?.username, "hank");

  const user = await userOps.getUserByUsername("hank");
  await userOps.updateUser(user.id, { status: "suspended" });

  assert.equal(await getSessionByToken(issued.token), null);
  await userOps.updateUser(user.id, { status: "active" });
  assert.equal(await getSessionByToken(issued.token), null, "the rejected session is deleted");
});

test("proxy auth never overwrites a protected account's role", async () => {
  const created = await resolveProxyUser(proxyRequest({ "x-forwarded-user": "admin" }));
  assert.equal(created.role, "user");
  await userOps.setProtected(created.id, true);

  process.env.AUTH_PROXY_ADMIN_USERS = "admin";
  const resolved = await resolveProxyUser(proxyRequest({ "x-forwarded-user": "admin" }));
  assert.equal(resolved.role, "user", "protected account role must not change via proxy auth");
  assert.equal((await userOps.getUserByUsername("admin"))?.role, "user");
});

test("proxy-provisioned users have no usable local password", async () => {
  const created = await resolveProxyUser(proxyRequest({ "x-forwarded-user": "ivy" }));
  const stored = await userOps.getUserById(created.id);
  assert.equal(stored.hasLocalPassword, false);
  assert.equal(stored.roleSource, "local");
  assert.equal(stored.status, "active");
});
