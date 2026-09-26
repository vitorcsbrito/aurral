import test from "node:test";
import assert from "node:assert/strict";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { dbOps, userOps, userIdentityOps }, plexModule, plexLogin] =
  await setupIsolatedBackend(
    "plex-login-auth",
    "backend/db/helpers/index.js",
    "backend/services/plex.js",
    "backend/services/plexLoginAuth.js",
  );

const { PlexClient } = plexModule;
const { completePlexLogin, resetPlexLoginStateForTests, startPlexLogin } = plexLogin;

const createResponse = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  append(name, value) {
    this.headers[name] = value;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

async function startLogin(t, { validateToken }) {
  t.mock.method(PlexClient, "generateClientId", () => "login-client");
  t.mock.method(PlexClient, "generatePin", async () => ({ id: 10, code: "login-code" }));
  t.mock.method(PlexClient, "buildAuthUrl", () => "https://plex.example/auth");
  t.mock.method(PlexClient, "checkPin", async () => "authorized-token");
  t.mock.method(PlexClient, "validateToken", validateToken);
  const startResponse = createResponse();
  await startPlexLogin({ body: {}, headers: {}, secure: false }, startResponse);
  return String(startResponse.headers["Set-Cookie"]).split(";", 1)[0];
}

test.beforeEach(async () => {
  await resetDatabase();
  resetPlexLoginStateForTests();
  await dbOps.updateSettings({
    onboardingComplete: true,
    integrations: {
      plex: {
        loginEnabled: true,
        url: "http://plex.example.com:32400",
        token: "configured-token",
      },
    },
  });
});

test.after(async () => cleanupIsolatedState(isolatedState));

test("transient Plex validation failures retain the login transaction for retry", async (t) => {
  const user = await userOps.createUser("plex-retry-user", "unused", "user");
  await userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "retry-subject",
  });
  let validations = 0;
  const cookie = await startLogin(t, {
    validateToken: async () => {
      validations += 1;
      if (validations === 1) {
        throw Object.assign(new Error("temporary outage"), { response: { status: 503 } });
      }
      return { id: "retry-subject", username: "plex-retry-user" };
    },
  });

  const firstResponse = createResponse();
  await completePlexLogin({ headers: { cookie }, ip: "127.0.0.1" }, firstResponse);
  assert.equal(firstResponse.statusCode, 503);
  assert.equal(firstResponse.body.retryable, true);
  assert.equal(firstResponse.headers["Set-Cookie"], undefined);

  const retryResponse = createResponse();
  await completePlexLogin(
    { headers: { cookie, "user-agent": "test-agent" }, ip: "127.0.0.1" },
    retryResponse,
  );
  assert.equal(retryResponse.statusCode, 200);
  assert.ok(retryResponse.body.token);
  assert.equal(retryResponse.body.user.id, user.id);
  assert.equal(validations, 2);
});

test("definitive Plex validation failures consume the login transaction", async (t) => {
  const cookie = await startLogin(t, { validateToken: async () => null });

  const invalidResponse = createResponse();
  await completePlexLogin({ headers: { cookie } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.match(String(invalidResponse.headers["Set-Cookie"]), /Max-Age=0/);

  const retryResponse = createResponse();
  await completePlexLogin({ headers: { cookie } }, retryResponse);
  assert.equal(retryResponse.statusCode, 400);
  assert.equal(retryResponse.body.error, "Plex login session expired");
});

test("a Plex account that is not linked never signs in or provisions an account", async (t) => {
  const cookie = await startLogin(t, {
    validateToken: async () => ({ id: "unlinked-subject", username: "stranger" }),
  });

  const response = createResponse();
  await completePlexLogin({ headers: { cookie } }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "not_linked");
  assert.equal((await userOps.getAllUsers()).length, 0);
});

test("a suspended user cannot sign in with a linked Plex account", async (t) => {
  const user = await userOps.createUser("plex-suspended-user", "unused", "user");
  await userIdentityOps.link(user.id, {
    providerType: "plex",
    providerKey: "plex",
    subject: "suspended-subject",
  });
  await userOps.updateUser(user.id, { status: "suspended" });
  const cookie = await startLogin(t, {
    validateToken: async () => ({ id: "suspended-subject", username: "plex-suspended-user" }),
  });

  const response = createResponse();
  await completePlexLogin({ headers: { cookie } }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "This account has been suspended or disabled");
  assert.equal(response.body.token, undefined);
});
