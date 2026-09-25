import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";

import {
  createMockHttpServer,
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, dbHelpers, authModule, sessionModule, oidcModule] =
  await setupIsolatedBackend(
    "oidc-auth",
    "backend/config/database.js",
    "backend/db/helpers/index.js",
    "backend/middleware/auth.js",
    "backend/config/session-helpers.js",
    "backend/services/oidcAuth.js",
  );

const { dbOps, userOps, userIdentityOps } = dbHelpers;
const { ensureExternalUser, isAuthRequiredByConfig, isOidcAuthEnabled } = authModule;
const { createSession, getSessionByToken } = sessionModule;
const {
  exchangeOidcCallback,
  isOidcEnabled,
  resolveOidcUsername,
  resolveOidcRole,
  getOidcBootstrapInfo,
  handleOidcCallback,
  resetOidcStateForTests,
  startOidcLogin,
} = oidcModule;

const completeOnboarding = () => dbOps.updateSettings({ onboardingComplete: true });
const countSessions = async () => (await db.get("SELECT COUNT(*) AS count FROM sessions")).count;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const oidcKey = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };

const createIdToken = (issuer, nonce, claimOverrides = {}) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: oidcKey.kid, typ: "JWT" });
  const payload = encode({
    iss: issuer,
    aud: "aurral",
    sub: "oidc-subject",
    preferred_username: "callback-user",
    nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claimOverrides,
  });
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
  return `${input}.${signature}`;
};

function resetOidcEnv() {
  delete process.env.OIDC_ENABLED;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_REDIRECT_URI;
  delete process.env.OIDC_SCOPES;
  delete process.env.OIDC_USERNAME_CLAIM;
  delete process.env.OIDC_DEFAULT_ROLE;
  delete process.env.OIDC_ADMIN_USERS;
  delete process.env.OIDC_GROUPS_CLAIM;
  delete process.env.OIDC_ADMIN_GROUPS;
  delete process.env.OIDC_LOGOUT_URL;
  delete process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD;
  delete process.env.AUTH_PROXY_ENABLED;
  delete process.env.AUTH_PROXY_HEADER;
  resetOidcStateForTests();
}

function enableOidcEnv(overrides = {}) {
  process.env.OIDC_ENABLED = "true";
  process.env.OIDC_ISSUER = "https://auth.example.com/application/o/aurral/";
  process.env.OIDC_CLIENT_ID = "aurral";
  process.env.OIDC_CLIENT_SECRET = "secret";
  process.env.OIDC_REDIRECT_URI = "https://aurral.example.com/sso/callback";
  Object.assign(process.env, overrides);
}

async function createPendingOidcLogin(options = {}) {
  let issuer;
  let nonce;
  const idTokenClaims = options.idTokenClaims || options.claimOverrides || {};
  const userInfo = options.userInfo || null;
  const userInfoError = options.userInfoError === true;
  const capturedTokenRequest = {};
  const discoveryServer = await createMockHttpServer((request, response) => {
    if (request.url === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [oidcKey] }));
      return;
    }
    if (request.method === "POST" && request.url === "/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        capturedTokenRequest.authorizationHeader = request.headers.authorization || null;
        capturedTokenRequest.body = body;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "access-token",
            token_type: "Bearer",
            id_token: createIdToken(issuer, nonce, idTokenClaims),
          }),
        );
      });
      return;
    }
    if (request.url === "/userinfo") {
      response.writeHead(userInfoError ? 500 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(userInfoError ? { error: "userinfo_unavailable" } : userInfo));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        ...(userInfo ? { userinfo_endpoint: `${issuer}userinfo` } : {}),
        jwks_uri: `${issuer}jwks`,
      }),
    );
  });
  issuer = `${discoveryServer.url}/`;
  enableOidcEnv({
    OIDC_ISSUER: issuer,
    OIDC_REDIRECT_URI: `${issuer}callback`,
    ...(options.envOverrides || {}),
  });

  const response = {
    headers: {},
    redirect(_status, location) {
      this.location = location;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  await startOidcLogin({}, response);
  const redirect = new URL(response.location);
  const state = redirect.searchParams.get("state");
  nonce = redirect.searchParams.get("nonce");
  assert.ok(state, "OIDC login redirect must include state");
  const setCookie = response.headers["Set-Cookie"];
  assert.ok(setCookie, "OIDC login must set a transaction cookie");
  return {
    state,
    nonce,
    cookie: setCookie.split(";", 1)[0],
    close: discoveryServer.close,
    capturedTokenRequest,
  };
}

async function completeOidcLogin(pending) {
  const callback = await handleOidcCallback({
    query: { state: pending.state, code: "authorization-code" },
    headers: { cookie: pending.cookie },
    ip: "127.0.0.1",
  });
  return exchangeOidcCallback(callback.code, {
    headers: { cookie: pending.cookie, "user-agent": "test-agent" },
    ip: "127.0.0.1",
  });
}

// Runs repeated (or concurrent) logins against one mock IdP. Each login gets
// its own authorization code, which the token endpoint maps back to that
// login's nonce and ID-token claims. With tokenBarrier set, token responses
// are held until that many token requests arrived, so concurrent callbacks
// resolve their accounts at the same time.
async function createReusableOidcProvider({ tokenBarrier = 1 } = {}) {
  let issuer;
  let loginCount = 0;
  const loginsByCode = new Map();
  const heldTokenResponses = [];
  const provider = { claimOverrides: {} };
  const discoveryServer = await createMockHttpServer((request, response) => {
    if (request.url === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [oidcKey] }));
      return;
    }
    if (request.method === "POST" && request.url === "/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const login = loginsByCode.get(new URLSearchParams(body).get("code"));
        heldTokenResponses.push(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              access_token: "access-token",
              token_type: "Bearer",
              id_token: createIdToken(issuer, login?.nonce, login?.claims),
            }),
          );
        });
        if (heldTokenResponses.length >= tokenBarrier) {
          for (const respond of heldTokenResponses.splice(0)) respond();
        }
      });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
      }),
    );
  });
  issuer = `${discoveryServer.url}/`;
  enableOidcEnv({ OIDC_ISSUER: issuer, OIDC_REDIRECT_URI: `${issuer}callback` });

  provider.login = async (claimOverrides = provider.claimOverrides) => {
    const code = `authorization-code-${++loginCount}`;
    const response = {
      headers: {},
      redirect(_status, location) {
        this.location = location;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
    };
    await startOidcLogin({}, response);
    const redirect = new URL(response.location);
    loginsByCode.set(code, { nonce: redirect.searchParams.get("nonce"), claims: claimOverrides });
    const state = redirect.searchParams.get("state");
    const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
    const callback = await handleOidcCallback({
      query: { state, code },
      headers: { cookie },
      ip: "127.0.0.1",
    });
    const session = await exchangeOidcCallback(callback.code, {
      headers: { cookie, "user-agent": "test-agent" },
      ip: "127.0.0.1",
    });
    return (await getSessionByToken(session.token))?.user;
  };
  provider.close = discoveryServer.close;
  return provider;
}

async function createApprovedLegacyUser(username, role = "user") {
  const legacy = await userOps.createUser(username, "random-unknown-hash", role, null, false);
  await userOps.updateUser(legacy.id, {
    needsIdentityMigration: true,
    allowIdentityAdoption: true,
  });
  return legacy;
}

test.beforeEach(async () => {
  await resetDatabase();
  resetOidcEnv();
  await dbOps.updateSettings({ onboardingComplete: false });
});

test.after(async () => {
  resetOidcEnv();
  await cleanupIsolatedState(isolatedState);
});

test("OIDC username prefers configured claim then email", () => {
  assert.equal(
    resolveOidcUsername({ preferred_username: "Alice", email: "alice@example.com" }),
    "alice",
  );
  assert.equal(resolveOidcUsername({ email: "Alice@example.com" }), "alice@example.com");

  process.env.OIDC_USERNAME_CLAIM = "nickname";
  assert.equal(resolveOidcUsername({ nickname: "Bob", email: "bob@example.com" }), "bob");
  assert.equal(resolveOidcUsername({}), "");
});

test("OIDC role mapping uses admin users and groups claim", () => {
  assert.equal(resolveOidcRole("carol", {}), "user");

  process.env.OIDC_ADMIN_USERS = "carol";
  assert.equal(resolveOidcRole("carol", {}), "admin");

  delete process.env.OIDC_ADMIN_USERS;
  process.env.OIDC_GROUPS_CLAIM = "groups";
  process.env.OIDC_ADMIN_GROUPS = "aurral-admins";
  assert.equal(resolveOidcRole("dave", { groups: ["users", "aurral-admins"] }), "admin");
  assert.equal(resolveOidcRole("erin", { groups: "users,aurral-admins" }), "admin");
  assert.equal(resolveOidcRole("frank", { groups: ["users"] }), "user");
  assert.equal(resolveOidcRole("gina", { groups: ["admin"] }), "user");

  process.env.OIDC_DEFAULT_ROLE = "admin";
  assert.equal(resolveOidcRole("hank", { groups: ["users"] }), "admin");
});

test("ensureExternalUser JIT-creates and re-syncs role", async () => {
  const created = await ensureExternalUser("oidc-user", "user");
  assert.ok(created);
  assert.equal(created.username, "oidc-user");
  assert.equal(created.role, "user");
  assert.equal((await userOps.getAllUsers()).length, 1);

  const promoted = await ensureExternalUser("oidc-user", "admin");
  assert.equal(promoted.id, created.id);
  assert.equal(promoted.role, "admin");
  assert.equal((await userOps.getUserByUsername("oidc-user"))?.role, "admin");
  assert.equal((await userOps.getAllUsers()).length, 1);
});

test("OIDC enablement requires full config and marks auth required after onboarding", async () => {
  process.env.OIDC_ENABLED = "true";
  assert.equal(isOidcEnabled(), false);
  assert.equal(getOidcBootstrapInfo().oidcEnabled, false);

  enableOidcEnv();
  assert.equal(isOidcEnabled(), true);
  assert.equal(isOidcAuthEnabled(), true);
  assert.equal(getOidcBootstrapInfo().oidcEnabled, true);

  assert.equal(await isAuthRequiredByConfig(), false);
  await completeOnboarding();
  assert.equal(await isAuthRequiredByConfig(), true);
});

test("OIDC bootstrap exposes logout URL when configured", () => {
  enableOidcEnv({ OIDC_LOGOUT_URL: "https://auth.example.com/logout" });
  assert.deepEqual(getOidcBootstrapInfo(), {
    oidcEnabled: true,
    oidcLogoutUrl: "https://auth.example.com/logout",
  });
});

test("OIDC-provisioned users get normal Aurral sessions", async () => {
  await completeOnboarding();
  const user = await ensureExternalUser("sso-erin", "user");
  const session = await createSession(user.id, "127.0.0.1", "test-agent");
  assert.ok(session?.token);
  assert.equal((await getSessionByToken(session.token))?.user?.username, "sso-erin");
});

test("OIDC callback issues a cookie-bound one-time session exchange", async () => {
  const pending = await createPendingOidcLogin();

  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    assert.ok(callback.code);
    assert.equal(await countSessions(), 0);

    await assert.rejects(
      () => exchangeOidcCallback(callback.code, { headers: { cookie: "aurral_oidc_transaction=wrong" } }),
      { status: 400, message: "OIDC login session expired" },
    );
    assert.equal(await countSessions(), 0);

    const session = await exchangeOidcCallback(callback.code, {
      headers: { cookie: pending.cookie, "user-agent": "test-agent" },
      ip: "127.0.0.1",
    });
    assert.ok(session.token);
    assert.equal((await getSessionByToken(session.token))?.user?.username, "callback-user");
    await assert.rejects(
      () => exchangeOidcCallback(callback.code, { headers: { cookie: pending.cookie } }),
      { status: 400, message: "OIDC login session expired" },
    );
  } finally {
    await pending.close();
  }
});

test("OIDC exchange never leaks passwordHash, for new or returning users", async () => {
  const first = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(first);
    assert.equal(session.user.passwordHash, undefined, "newly provisioned user must be sanitized");
  } finally {
    await first.close();
  }

  const second = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(second);
    assert.equal(session.user.passwordHash, undefined, "returning user must also be sanitized");
  } finally {
    await second.close();
  }
});

test("OIDC exchange refuses an account suspended after the callback resolved it", async () => {
  const pending = await createPendingOidcLogin();
  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    await userOps.updateUser(callback.user.id, { status: "suspended" });
    await assert.rejects(
      () =>
        exchangeOidcCallback(callback.code, {
          headers: { cookie: pending.cookie },
          ip: "127.0.0.1",
        }),
      { status: 403, message: "This account has been suspended or disabled" },
    );
    assert.equal(await countSessions(), 0);
  } finally {
    await pending.close();
  }
});

test("OIDC callback combines UserInfo with ID-token claims", async () => {
  process.env.OIDC_GROUPS_CLAIM = "groups";
  process.env.OIDC_ADMIN_GROUPS = "aurral-admins";
  const pending = await createPendingOidcLogin({
    idTokenClaims: { preferred_username: undefined, groups: ["aurral-admins"] },
    userInfo: {
      sub: "oidc-subject",
      preferred_username: "userinfo-user",
      groups: ["regular-users"],
    },
  });

  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    assert.equal(callback.user.username, "userinfo-user");
    assert.equal(callback.user.role, "admin");
  } finally {
    await pending.close();
  }
});

test("OIDC callback falls back to ID-token claims when UserInfo fails", async () => {
  const pending = await createPendingOidcLogin({
    idTokenClaims: { preferred_username: "id-token-user" },
    userInfo: { sub: "oidc-subject" },
    userInfoError: true,
  });

  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    assert.equal(callback.user.username, "id-token-user");
  } finally {
    await pending.close();
  }
});

test("OIDC groups claim ignores UserInfo-only admin groups", async () => {
  process.env.OIDC_GROUPS_CLAIM = "groups";
  process.env.OIDC_ADMIN_GROUPS = "aurral-admins";
  const pending = await createPendingOidcLogin({
    idTokenClaims: { preferred_username: "id-token-user" },
    userInfo: {
      sub: "oidc-subject",
      preferred_username: "userinfo-user",
      groups: ["aurral-admins"],
    },
  });

  try {
    const callback = await handleOidcCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    assert.equal(callback.user.username, "userinfo-user");
    assert.equal(callback.user.role, "user");
  } finally {
    await pending.close();
  }
});

test("OIDC callback rejects an expired state without creating a session", async () => {
  const pending = await createPendingOidcLogin();
  const now = Date.now();
  const clock = mock.method(Date, "now", () => now + 11 * 60 * 1000);

  try {
    await assert.rejects(
      () =>
        handleOidcCallback({
          query: { state: pending.state },
          headers: { cookie: pending.cookie },
          ip: "127.0.0.1",
        }),
      { status: 400, message: "OIDC login session expired" },
    );
    assert.equal(await countSessions(), 0);
  } finally {
    clock.mock.restore();
    await pending.close();
  }
});

test("OIDC callback rejects a mismatched state without creating a session", async () => {
  const pending = await createPendingOidcLogin();

  try {
    await assert.rejects(
      () =>
        handleOidcCallback({
          query: { state: `${pending.state}-mismatched` },
          headers: { cookie: pending.cookie },
          ip: "127.0.0.1",
        }),
      { status: 400, message: "OIDC login session expired" },
    );
    assert.equal(await countSessions(), 0);
  } finally {
    await pending.close();
  }
});

test("OIDC login falls back to the UserInfo endpoint when the ID token omits profile claims", async () => {
  let issuer;
  let nonce;
  const discoveryServer = await createMockHttpServer((request, response) => {
    if (request.url === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [oidcKey] }));
      return;
    }
    if (request.method === "POST" && request.url === "/token") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: "access-token",
          token_type: "Bearer",
          id_token: createIdToken(issuer, nonce, { preferred_username: undefined, email: undefined }),
        }),
      );
      return;
    }
    if (request.url === "/userinfo") {
      assert.equal(request.headers.authorization, "Bearer access-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sub: "oidc-subject", preferred_username: "authelia-user" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        userinfo_endpoint: `${issuer}userinfo`,
        jwks_uri: `${issuer}jwks`,
      }),
    );
  });

  try {
    issuer = `${discoveryServer.url}/`;
    enableOidcEnv({ OIDC_ISSUER: issuer, OIDC_REDIRECT_URI: `${issuer}callback` });

    const response = {
      headers: {},
      redirect(_status, location) {
        this.location = location;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
    };
    await startOidcLogin({}, response);
    const redirect = new URL(response.location);
    nonce = redirect.searchParams.get("nonce");
    const state = redirect.searchParams.get("state");
    const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
    const callback = await handleOidcCallback({
      query: { state, code: "authorization-code" },
      headers: { cookie },
      ip: "127.0.0.1",
    });
    const session = await exchangeOidcCallback(callback.code, {
      headers: { cookie, "user-agent": "test-agent" },
      ip: "127.0.0.1",
    });
    const loggedInUser = (await getSessionByToken(session.token))?.user;
    assert.equal(
      loggedInUser?.username,
      "authelia-user",
      "must resolve the username from UserInfo when the ID token carries none",
    );
  } finally {
    await discoveryServer.close();
  }
});

test("OIDC login resolves returning users by issuer+subject, not by username claim", async () => {
  const provider = await createReusableOidcProvider();
  try {
    const firstUser = await provider.login();
    assert.ok(firstUser?.id);
    assert.equal((await userOps.getAllUsers()).length, 1);

    provider.claimOverrides = { preferred_username: "renamed-user" };
    const secondUser = await provider.login();
    assert.equal(secondUser?.id, firstUser.id, "same subject must resolve to the same user");
    assert.equal(
      secondUser?.username,
      "callback-user",
      "username claim changing after first login must not rename or re-provision the user",
    );
    assert.equal(
      (await userOps.getAllUsers()).length,
      1,
      "returning login must not create a second user",
    );
  } finally {
    await provider.close();
  }
});

test("OIDC provisioning auto-suffixes a colliding username instead of linking to the existing account", async () => {
  const first = await createPendingOidcLogin({ claimOverrides: { sub: "subject-one" } });
  let firstUserId;
  try {
    const session = await completeOidcLogin(first);
    firstUserId = (await getSessionByToken(session.token))?.user?.id;
  } finally {
    await first.close();
  }

  const second = await createPendingOidcLogin({ claimOverrides: { sub: "subject-two" } });
  try {
    const session = await completeOidcLogin(second);
    const loggedInUser = (await getSessionByToken(session.token))?.user;
    assert.notEqual(
      loggedInUser?.id,
      firstUserId,
      "a different subject with a colliding username must never log in as the existing account",
    );
    assert.equal(loggedInUser?.username, "callback-user-2");
  } finally {
    await second.close();
  }

  assert.equal((await userOps.getAllUsers()).length, 2);
  assert.equal((await userOps.getUserByUsername("callback-user"))?.id, firstUserId);
});

test("OIDC login adopts a legacy account only once an admin has approved that specific account", async () => {
  await completeOnboarding();
  const legacy = await createApprovedLegacyUser("callback-user");

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = (await getSessionByToken(session.token))?.user;
    assert.equal(loggedInUser?.id, legacy.id, "must adopt the legacy account, not provision a new one");
    assert.equal(loggedInUser?.username, "callback-user");
  } finally {
    await pending.close();
  }

  assert.equal((await userOps.getAllUsers()).length, 1, "no duplicate account should be created");
  const identities = await userIdentityOps.getForUser(legacy.id);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].providerType, "oidc");
  const adopted = await userOps.getUserById(legacy.id);
  assert.equal(adopted.needsIdentityMigration, false);
  assert.equal(adopted.roleSource, "oidc");
  assert.equal(
    adopted.allowIdentityAdoption,
    false,
    "approval must be consumed so it authorizes exactly one adoption",
  );
});

test("concurrent OIDC logins with different subjects adopt an approved legacy account only once", async () => {
  await completeOnboarding();
  const legacy = await createApprovedLegacyUser("callback-user");

  // Hold both logins after their adoption pre-check read the approved account,
  // so both reach the claim before either has committed it.
  const readUserByUsername = userOps.getUserByUsername;
  const heldReads = [];
  const lookup = mock.method(userOps, "getUserByUsername", async (username) => {
    const user = await readUserByUsername.call(userOps, username);
    if (username === "callback-user" && lookup.mock.callCount() <= 2) {
      await new Promise((resolve) => {
        heldReads.push(resolve);
        if (heldReads.length === 2) for (const release of heldReads) release();
      });
    }
    return user;
  });
  const provider = await createReusableOidcProvider({ tokenBarrier: 2 });
  try {
    const users = await Promise.all([
      provider.login({ sub: "race-subject-one" }),
      provider.login({ sub: "race-subject-two" }),
    ]);
    assert.equal(heldReads.length, 2, "both logins must have read the approved account");
    assert.equal(
      users.filter((user) => user?.id === legacy.id).length,
      1,
      "exactly one of the racing logins may claim the approved account",
    );
  } finally {
    lookup.mock.restore();
    await provider.close();
  }

  assert.equal((await userIdentityOps.getForUser(legacy.id)).length, 1);
  assert.equal((await userOps.getAllUsers()).length, 2);
  assert.ok(await userOps.getUserByUsername("callback-user-2"));
});

test("OIDC login never adopts a legacy account the admin has not approved, even though the migration leaves has_local_password unset", async () => {
  await completeOnboarding();
  const legacyLocalAccount = await userOps.createUser(
    "callback-user",
    "real-local-password-hash",
    "user",
    null,
    false,
  );
  await userOps.updateUser(legacyLocalAccount.id, { needsIdentityMigration: true });

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = (await getSessionByToken(session.token))?.user;
    assert.notEqual(
      loggedInUser?.id,
      legacyLocalAccount.id,
      "a username match alone must never hand an OIDC identity someone else's account",
    );
    assert.equal(loggedInUser?.username, "callback-user-2");
  } finally {
    await pending.close();
  }

  assert.equal((await userOps.getAllUsers()).length, 2);
  assert.equal((await userIdentityOps.getForUser(legacyLocalAccount.id)).length, 0);
});

test("OIDC login does not adopt an approved legacy account that is already linked to another identity", async () => {
  await completeOnboarding();
  const legacy = await createApprovedLegacyUser("callback-user");
  await userIdentityOps.link(legacy.id, {
    providerType: "oidc",
    providerKey: "https://already-linked.example/",
    subject: "some-other-subject",
  });

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = (await getSessionByToken(session.token))?.user;
    assert.notEqual(loggedInUser?.id, legacy.id);
    assert.equal(loggedInUser?.username, "callback-user-2");
  } finally {
    await pending.close();
  }
});

test("OIDC login does not adopt the protected bootstrap admin", async () => {
  await completeOnboarding();
  const legacy = await createApprovedLegacyUser("callback-user", "admin");
  await userOps.setProtected(legacy.id, true);

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = (await getSessionByToken(session.token))?.user;
    assert.notEqual(loggedInUser?.id, legacy.id);
  } finally {
    await pending.close();
  }
});

test("OIDC login does not adopt an approved legacy account that is suspended", async () => {
  await completeOnboarding();
  const legacy = await createApprovedLegacyUser("callback-user");
  await userOps.updateUser(legacy.id, { status: "suspended" });

  const pending = await createPendingOidcLogin();
  try {
    const session = await completeOidcLogin(pending);
    const loggedInUser = (await getSessionByToken(session.token))?.user;
    assert.notEqual(loggedInUser?.id, legacy.id);
    assert.equal((await userIdentityOps.getForUser(legacy.id)).length, 0);
  } finally {
    await pending.close();
  }
});

test("OIDC login owns role changes, preserves local permissions, and protects recovery accounts", async () => {
  const provider = await createReusableOidcProvider();
  try {
    const user = await provider.login();
    assert.equal(user?.role, "user");
    assert.equal((await userOps.getUserById(user.id))?.roleSource, "oidc");

    const localPermissions = {
      accessSettings: false,
      accessFlow: true,
      requestDownloads: false,
    };
    await userOps.updateUser(user.id, {
      role: "admin",
      roleSource: "local",
      permissions: localPermissions,
    });
    const storedLocalPermissions = (await userOps.getUserById(user.id))?.permissions;
    const demotedByOidc = await provider.login();
    assert.equal(demotedByOidc?.role, "user");
    assert.equal((await userOps.getUserById(user.id))?.roleSource, "oidc");
    assert.deepEqual((await userOps.getUserById(user.id))?.permissions, storedLocalPermissions);

    process.env.OIDC_ADMIN_USERS = "callback-user";
    await userOps.updateUser(user.id, { role: "user", roleSource: "local" });
    const promotedByOidc = await provider.login();
    assert.equal(promotedByOidc?.role, "admin");
    assert.equal((await userOps.getUserById(user.id))?.roleSource, "oidc");
    assert.deepEqual((await userOps.getUserById(user.id))?.permissions, storedLocalPermissions);

    await userOps.setProtected(user.id, true);
    delete process.env.OIDC_ADMIN_USERS;
    const loggedInAgain = await provider.login();
    assert.equal(
      loggedInAgain?.role,
      "admin",
      "OIDC must never demote or otherwise change a protected account's role",
    );

    await userOps.updateUser(user.id, { status: "suspended" });
    await assert.rejects(() => provider.login(), {
      status: 403,
      message: "This account has been suspended or disabled",
    });
  } finally {
    await provider.close();
  }
});

test("OIDC token exchange defaults to client_secret_basic and honors OIDC_TOKEN_ENDPOINT_AUTH_METHOD", async () => {
  const basicPending = await createPendingOidcLogin();
  try {
    await completeOidcLogin(basicPending);
    assert.ok(
      basicPending.capturedTokenRequest.authorizationHeader?.startsWith("Basic "),
      "default token endpoint auth method must be client_secret_basic",
    );
    assert.ok(
      !String(basicPending.capturedTokenRequest.body || "").includes("client_secret="),
      "client_secret_basic must not put the secret in the request body",
    );
  } finally {
    await basicPending.close();
  }

  const postPending = await createPendingOidcLogin({
    claimOverrides: { sub: "subject-post" },
    envOverrides: { OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "client_secret_post" },
  });
  try {
    await completeOidcLogin(postPending);
    assert.ok(
      String(postPending.capturedTokenRequest.body || "").includes("client_secret="),
      "client_secret_post must include the secret in the request body",
    );
  } finally {
    await postPending.close();
  }
});

test("OIDC token exchange supports the none auth method with an empty client secret", async () => {
  const nonePending = await createPendingOidcLogin({
    claimOverrides: { sub: "subject-none" },
    envOverrides: { OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "none", OIDC_CLIENT_SECRET: "" },
  });
  try {
    assert.equal(isOidcEnabled(), true, "OIDC must stay enabled with an empty secret for none");
    const session = await completeOidcLogin(nonePending);
    assert.ok(session.token);
    assert.equal(nonePending.capturedTokenRequest.authorizationHeader, null);
    const tokenRequestParams = new URLSearchParams(nonePending.capturedTokenRequest.body || "");
    assert.equal(tokenRequestParams.get("client_secret"), null);
    assert.equal(
      tokenRequestParams.get("client_id"),
      "aurral",
      "a public client must still identify itself with client_id in the request body",
    );
  } finally {
    await nonePending.close();
  }
});

test("OIDC rejects an unrecognized token endpoint auth method instead of silently defaulting", async () => {
  enableOidcEnv({ OIDC_TOKEN_ENDPOINT_AUTH_METHOD: "client_secert_basic" });
  const response = {
    headers: {},
    redirect() {},
    setHeader() {},
    status() {
      return this;
    },
    json() {},
  };
  await assert.rejects(() => startOidcLogin({}, response), /Unsupported OIDC_TOKEN_ENDPOINT_AUTH_METHOD/);
});
