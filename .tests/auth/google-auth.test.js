import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";

import {
  createMockHttpServer,
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, dbHelpers, sessionModule, googleModule] = await setupIsolatedBackend(
  "google-auth",
  "backend/config/database.js",
  "backend/db/helpers/index.js",
  "backend/config/session-helpers.js",
  "backend/services/googleAuth.js",
);

const { dbOps, userOps, userIdentityOps } = dbHelpers;
const { getSessionByToken } = sessionModule;
const {
  startGoogleAuth,
  handleGoogleCallback,
  exchangeGoogleCallback,
  isGoogleLoginEnabled,
  resetGoogleStateForTests,
  setGoogleIssuerForTests,
} = googleModule;

const completeOnboarding = () => dbOps.updateSettings({ onboardingComplete: true });

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleKey = { ...publicKey.export({ format: "jwk" }), kid: "google-test-key", use: "sig", alg: "RS256" };

const createIdToken = (issuer, nonce, claimOverrides = {}) => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: googleKey.kid, typ: "JWT" });
  const payload = encode({
    iss: issuer,
    aud: "google-client-id",
    sub: "google-subject",
    email: "person@example.com",
    nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claimOverrides,
  });
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
  return `${input}.${signature}`;
};

function enableGoogleConfig(issuer) {
  return dbOps.updateSettings({
    integrations: {
      google: {
        enabled: true,
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        redirectUri: `${issuer}callback`,
      },
    },
  });
}

async function createPendingGoogleAuth(mode, claimOverrides = {}) {
  let issuer;
  let nonce;
  const discoveryServer = await createMockHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [googleKey] }));
      return;
    }
    if (request.method === "POST" && request.url === "/token") {
      response.end(
        JSON.stringify({
          access_token: "access-token",
          token_type: "Bearer",
          id_token: createIdToken(issuer, nonce, claimOverrides),
        }),
      );
      return;
    }
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
  setGoogleIssuerForTests(issuer);
  await enableGoogleConfig(issuer);

  const response = {
    headers: {},
    body: null,
    redirect(_status, location) {
      this.location = location;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(value) {
      this.body = value;
    },
  };
  await startGoogleAuth({ headers: {} }, response, mode);
  const redirect = new URL(response.location || response.body?.authUrl);
  const state = redirect.searchParams.get("state");
  nonce = redirect.searchParams.get("nonce");
  const cookie = response.headers["Set-Cookie"].split(";", 1)[0];
  return { state, cookie, response, close: discoveryServer.close };
}

async function completeGoogleAuth(pending) {
  const callback = await handleGoogleCallback({
    query: { state: pending.state, code: "authorization-code" },
    headers: { cookie: pending.cookie },
    ip: "127.0.0.1",
  });
  return exchangeGoogleCallback(callback.code, {
    headers: { cookie: pending.cookie, "user-agent": "test-agent" },
    ip: "127.0.0.1",
  });
}

test.beforeEach(async () => {
  await resetDatabase();
  resetGoogleStateForTests();
  await dbOps.updateSettings({ onboardingComplete: false });
});

test.after(async () => {
  resetGoogleStateForTests();
  await cleanupIsolatedState(isolatedState);
});

test("Google login is disabled until enabled, clientId, clientSecret and redirectUri are all set", async () => {
  assert.equal(isGoogleLoginEnabled(), false);
  await dbOps.updateSettings({
    integrations: { google: { enabled: true, clientId: "id", clientSecret: "secret" } },
  });
  assert.equal(isGoogleLoginEnabled(), false, "missing redirectUri must keep it disabled");
  await dbOps.updateSettings({
    integrations: {
      google: {
        enabled: true,
        clientId: "id",
        clientSecret: "secret",
        redirectUri: "https://aurral.example.com/sso/google/callback",
      },
    },
  });
  assert.equal(isGoogleLoginEnabled(), true);
});

test("the Google client secret is encrypted at rest", async () => {
  await dbOps.updateSettings({
    integrations: {
      google: {
        enabled: true,
        clientId: "id",
        clientSecret: "plain-google-secret",
        redirectUri: "https://aurral.example.com/sso/google/callback",
      },
    },
  });
  const row = await db.get("SELECT value FROM settings WHERE key = 'integrations'");
  assert.doesNotMatch(row.value, /plain-google-secret/);
  assert.equal(dbOps.getSettings().integrations.google.clientSecret, "plain-google-secret");
});

test("Google account linking can return an authorization URL to an authenticated API caller", async () => {
  const pending = await createPendingGoogleAuth({
    mode: "link",
    linkUserId: 42,
    returnUrl: true,
  });
  try {
    assert.match(pending.response.body?.authUrl || "", /^http/);
    assert.equal(pending.response.location, undefined);
    assert.ok(pending.cookie.startsWith("aurral_google_transaction="));
  } finally {
    await pending.close();
  }
});

test("logging in with an unrecognized Google identity is rejected and never provisions an account", async () => {
  await completeOnboarding();
  const pending = await createPendingGoogleAuth({ mode: "login" });
  try {
    await assert.rejects(() => completeGoogleAuth(pending), {
      status: 403,
    });
    assert.equal((await userOps.getAllUsers()).length, 0);
    assert.equal(await userIdentityOps.findByProvider("google", "google", "google-subject"), null);
  } finally {
    await pending.close();
  }
});

test("linking attaches the identity to the authenticated user, and logging in afterward resolves it without touching role", async () => {
  await completeOnboarding();
  const user = await userOps.createUser("gordon", "unused-hash", "user");

  const linkPending = await createPendingGoogleAuth({ mode: "link", linkUserId: user.id });
  try {
    const linkResult = await completeGoogleAuth(linkPending);
    assert.equal(linkResult.linked, true);
    assert.equal(linkResult.user.id, user.id);
    assert.equal(linkResult.token, undefined, "linking must not issue a session");
  } finally {
    await linkPending.close();
  }

  const identity = await userIdentityOps.findByProvider("google", "google", "google-subject");
  assert.equal(identity.userId, user.id);

  const loginPending = await createPendingGoogleAuth({ mode: "login" });
  try {
    const loginResult = await completeGoogleAuth(loginPending);
    assert.equal(loginResult.linked, false);
    assert.ok(loginResult.token);
    const sessionUser = (await getSessionByToken(loginResult.token))?.user;
    assert.equal(sessionUser?.id, user.id);
    assert.equal(sessionUser?.role, "user", "Google must never grant or change role");
  } finally {
    await loginPending.close();
  }
});

test("linking a Google identity already claimed by another user is rejected with 409", async () => {
  await completeOnboarding();
  const userA = await userOps.createUser("user-a", "unused-hash", "user");
  const userB = await userOps.createUser("user-b", "unused-hash", "user");

  const firstLink = await createPendingGoogleAuth({ mode: "link", linkUserId: userA.id });
  try {
    await completeGoogleAuth(firstLink);
  } finally {
    await firstLink.close();
  }

  const secondLink = await createPendingGoogleAuth({ mode: "link", linkUserId: userB.id });
  try {
    await assert.rejects(
      () =>
        handleGoogleCallback({
          query: { state: secondLink.state, code: "authorization-code" },
          headers: { cookie: secondLink.cookie },
          ip: "127.0.0.1",
        }),
      { status: 409 },
    );
  } finally {
    await secondLink.close();
  }

  const identity = await userIdentityOps.findByProvider("google", "google", "google-subject");
  assert.equal(identity.userId, userA.id, "the conflicting link attempt must not steal the identity");
});

test("a suspended user cannot log in via a linked Google identity", async () => {
  await completeOnboarding();
  const user = await userOps.createUser("suspended-google-user", "unused-hash", "user");
  await userIdentityOps.link(user.id, {
    providerType: "google",
    providerKey: "google",
    subject: "google-subject",
  });
  await userOps.updateUser(user.id, { status: "suspended" });

  const pending = await createPendingGoogleAuth({ mode: "login" });
  try {
    await assert.rejects(() => completeGoogleAuth(pending), {
      status: 403,
      message: "This account has been suspended or disabled",
    });
  } finally {
    await pending.close();
  }
});

test("a Google login exchange refuses an account suspended after the callback", async () => {
  await completeOnboarding();
  const user = await userOps.createUser("late-suspended-google-user", "unused-hash", "user");
  await userIdentityOps.link(user.id, {
    providerType: "google",
    providerKey: "google",
    subject: "google-subject",
  });

  const pending = await createPendingGoogleAuth({ mode: "login" });
  try {
    const callback = await handleGoogleCallback({
      query: { state: pending.state, code: "authorization-code" },
      headers: { cookie: pending.cookie },
      ip: "127.0.0.1",
    });
    await userOps.updateUser(user.id, { status: "disabled" });
    await assert.rejects(
      () => exchangeGoogleCallback(callback.code, { headers: { cookie: pending.cookie } }),
      { status: 403, message: "This account has been suspended or disabled" },
    );
    assert.equal((await db.get("SELECT COUNT(*) AS count FROM sessions")).count, 0);
  } finally {
    await pending.close();
  }
});

test("a suspended user cannot complete a Google link", async () => {
  await completeOnboarding();
  const user = await userOps.createUser("suspended-linker", "unused-hash", "user");
  await userOps.updateUser(user.id, { status: "suspended" });

  const pending = await createPendingGoogleAuth({ mode: "link", linkUserId: user.id });
  try {
    await assert.rejects(
      () =>
        handleGoogleCallback({
          query: { state: pending.state, code: "authorization-code" },
          headers: { cookie: pending.cookie },
          ip: "127.0.0.1",
        }),
      { status: 403, message: "This account has been suspended or disabled" },
    );
  } finally {
    await pending.close();
  }
  assert.equal(await userIdentityOps.findByProvider("google", "google", "google-subject"), null);
});

test("Google exchange never leaks passwordHash, for linking or login", async () => {
  await completeOnboarding();
  const user = await userOps.createUser("gordon-sanitize", "unused-hash", "user");

  const linkPending = await createPendingGoogleAuth({ mode: "link", linkUserId: user.id });
  try {
    const linkResult = await completeGoogleAuth(linkPending);
    assert.equal(linkResult.user.passwordHash, undefined);
  } finally {
    await linkPending.close();
  }

  const loginPending = await createPendingGoogleAuth({ mode: "login" });
  try {
    const loginResult = await completeGoogleAuth(loginPending);
    assert.equal(loginResult.user.passwordHash, undefined);
  } finally {
    await loginPending.close();
  }
});

test("exchangeGoogleCallback rejects a code that was never issued", async () => {
  await assert.rejects(() => exchangeGoogleCallback("bogus-code", { headers: {} }), {
    status: 400,
    message: "Google login session expired",
  });
});
