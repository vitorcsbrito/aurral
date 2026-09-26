import * as client from "openid-client";
import { db } from "../config/database.js";
import { createSession } from "../config/session-helpers.js";
import { createSystemProvisionedUser, toResolvedUser } from "../middleware/auth.js";
import { userOps, userIdentityOps } from "../db/helpers/index.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_TTL_MS = 60 * 1000;
const OIDC_TRANSACTION_COOKIE = "aurral_oidc_transaction";
const pendingLogins = new Map();
const pendingExchanges = new Map();
let discoveryConfig = null;
let discoveryKey = "";

function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function prunePendingLogins(now = Date.now()) {
  for (const [state, entry] of pendingLogins) {
    if (!entry || entry.expiresAt <= now) pendingLogins.delete(state);
  }
}

function prunePendingExchanges(now = Date.now()) {
  for (const [code, entry] of pendingExchanges) {
    if (!entry || entry.expiresAt <= now) pendingExchanges.delete(code);
  }
}

function getTransactionCookie(req) {
  const cookies = String(req.headers?.cookie || "").split(";");
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name !== OIDC_TRANSACTION_COOKIE) continue;
    try {
      return decodeURIComponent(parts.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

function setTransactionCookie(req, res, value, maxAge) {
  const secure = req.secure || req.protocol === "https";
  const attributes = [
    `${OIDC_TRANSACTION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  if (maxAge != null) attributes.push(`Max-Age=${maxAge}`);
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function getRequiredConfig() {
  const issuer = String(process.env.OIDC_ISSUER || "").trim();
  const clientId = String(process.env.OIDC_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.OIDC_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.OIDC_REDIRECT_URI || "").trim();
  const secretRequired = getTokenEndpointAuthMethod() !== "none";
  if (!issuer || !clientId || (secretRequired && !clientSecret) || !redirectUri) return null;
  return { issuer, clientId, clientSecret, redirectUri };
}

export function isOidcEnabled() {
  if (process.env.OIDC_ENABLED !== "true") return false;
  return !!getRequiredConfig();
}

export function getOidcBootstrapInfo() {
  if (!isOidcEnabled()) {
    return {
      oidcEnabled: false,
      oidcLogoutUrl: null,
    };
  }
  return {
    oidcEnabled: true,
    oidcLogoutUrl: process.env.OIDC_LOGOUT_URL || null,
  };
}

function getScopes() {
  const scopes = String(process.env.OIDC_SCOPES || "openid profile email")
    .trim()
    .replace(/\s+/g, " ");
  return scopes || "openid profile email";
}

function getUsernameClaim() {
  return String(process.env.OIDC_USERNAME_CLAIM || "preferred_username").trim() || "preferred_username";
}

function getGroupsClaim() {
  return String(process.env.OIDC_GROUPS_CLAIM || "").trim();
}

// OIDC Core's default is client_secret_basic.
function getTokenEndpointAuthMethod() {
  const method = String(process.env.OIDC_TOKEN_ENDPOINT_AUTH_METHOD || "client_secret_basic")
    .trim()
    .toLowerCase();
  return method || "client_secret_basic";
}

function buildClientAuthentication(method, clientSecret) {
  switch (method) {
    case "client_secret_post":
      return client.ClientSecretPost(clientSecret);
    case "none":
      return client.None();
    case "client_secret_basic":
      return client.ClientSecretBasic(clientSecret);
    default:
      throw new Error(
        `Unsupported OIDC_TOKEN_ENDPOINT_AUTH_METHOD "${method}" (expected client_secret_basic, client_secret_post, or none)`,
      );
  }
}

// First free name among base, base-2, base-3, ... for a new OIDC account.
async function generateUniqueUsername(base) {
  const trimmed = String(base || "").trim().toLowerCase();
  if (!trimmed) return trimmed;
  if (!(await userOps.getUserByUsername(trimmed))) return trimmed;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${trimmed}-${suffix}`;
    if (!(await userOps.getUserByUsername(candidate))) return candidate;
  }
  throw new Error("Could not generate a unique username for OIDC provisioning");
}

function normalizeGroups(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  }
  if (value == null) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveOidcRole(username, claims = {}) {
  const adminUsers = parseCsv(process.env.OIDC_ADMIN_USERS).map((u) => u.toLowerCase());
  if (adminUsers.includes(String(username || "").toLowerCase())) return "admin";

  const groupsClaim = getGroupsClaim();
  if (groupsClaim) {
    const groups = normalizeGroups(claims[groupsClaim]);
    const adminGroups = parseCsv(process.env.OIDC_ADMIN_GROUPS).map((g) => g.toLowerCase());
    if (groups.some((g) => adminGroups.includes(g))) return "admin";
  }

  return (process.env.OIDC_DEFAULT_ROLE || "user").trim().toLowerCase() === "admin"
    ? "admin"
    : "user";
}

export function resolveOidcUsername(claims = {}) {
  const claimName = getUsernameClaim();
  const primary = String(claims[claimName] || "").trim();
  if (primary) return primary.toLowerCase();
  const email = String(claims.email || "").trim();
  if (email) return email.toLowerCase();
  return "";
}

async function fetchEffectiveClaims(oidc, tokens, claims) {
  if (!claims.sub || !tokens.access_token) return claims;

  try {
    const userInfo = await client.fetchUserInfo(oidc, tokens.access_token, claims.sub);
    const effectiveClaims = { ...claims, ...userInfo };
    const groupsClaim = getGroupsClaim();
    if (groupsClaim) {
      effectiveClaims[groupsClaim] = claims[groupsClaim];
    }
    return effectiveClaims;
  } catch {
    return claims;
  }
}

async function getDiscoveryConfig() {
  const config = getRequiredConfig();
  if (!config) {
    throw new Error("OIDC is not configured");
  }
  const authMethod = getTokenEndpointAuthMethod();
  const key = `${config.issuer}|${config.clientId}|${config.clientSecret}|${config.redirectUri}|${authMethod}`;
  if (discoveryConfig && discoveryKey === key) return { config, oidc: discoveryConfig };
  const issuerUrl = new URL(config.issuer);
  const discoveryOptions =
    issuerUrl.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : undefined;
  discoveryConfig = await client.discovery(
    issuerUrl,
    config.clientId,
    config.clientSecret,
    buildClientAuthentication(authMethod, config.clientSecret),
    discoveryOptions,
  );
  discoveryKey = key;
  return { config, oidc: discoveryConfig };
}

function toDisplayName(claims) {
  return resolveOidcUsername(claims) || String(claims.email || "").trim() || null;
}

const httpError = (message, status) => Object.assign(new Error(message), { status });

// A pre-identity account may be claimed by the first OIDC login with its
// username, but only after an admin approved that account, and only once.
const isAdoptableLegacyUser = (user) =>
  !!user &&
  user.allowIdentityAdoption &&
  user.needsIdentityMigration &&
  user.status === "active" &&
  !user.isProtected;

// Links the identity to an approved legacy account. The account row is locked
// and every condition re-checked inside the transaction, so two concurrent
// logins cannot both claim it.
async function adoptLegacyUser(username, role, identity) {
  const candidate = await userOps.getUserByUsername(username);
  if (!isAdoptableLegacyUser(candidate)) return null;
  return db.transaction(async () => {
    await db.get("SELECT id FROM users WHERE id = ? FOR UPDATE", [candidate.id]);
    const legacyMatch = await userOps.getUserById(candidate.id);
    if (
      !isAdoptableLegacyUser(legacyMatch) ||
      legacyMatch.username !== candidate.username ||
      (await userIdentityOps.countForUser(legacyMatch.id)) !== 0
    ) {
      return null;
    }
    const updated = await userOps.updateUser(legacyMatch.id, {
      role,
      roleSource: "oidc",
      needsIdentityMigration: false,
      allowIdentityAdoption: false,
    });
    if (!updated) throw httpError("Failed to link the OIDC identity", 500);
    await userIdentityOps.link(legacyMatch.id, identity);
    return userOps.getUserById(legacyMatch.id);
  });
}

async function provisionOidcUser(baseUsername, role, identity) {
  const uniqueUsername = await generateUniqueUsername(baseUsername);
  return db.transaction(async () => {
    const created = await createSystemProvisionedUser(uniqueUsername, role);
    if (!created?.id || created.id < 0) {
      throw httpError("Failed to provision OIDC user", 500);
    }
    const updated = await userOps.updateUser(created.id, { roleSource: "oidc" });
    if (!updated) throw httpError("Failed to provision OIDC user", 500);
    await userIdentityOps.link(created.id, identity);
    return userOps.getUserById(created.id);
  });
}

// Resolves the account for an OIDC login by (issuer, subject). Usernames only
// name new accounts; they never select an existing one without admin approval.
async function resolveOidcSessionUser(config, claims) {
  const subject = String(claims.sub || "").trim();
  if (!subject) {
    throw httpError("OIDC identity did not include a usable subject", 400);
  }

  const existingIdentity = await userIdentityOps.findByProvider("oidc", config.issuer, subject);
  if (existingIdentity) {
    const user = await userOps.getUserById(existingIdentity.userId);
    if (!user) {
      throw httpError("Linked OIDC identity has no matching user", 500);
    }
    if (user.status !== "active") {
      throw httpError("This account has been suspended or disabled", 403);
    }
    if (user.isProtected) {
      return toResolvedUser(user);
    }
    const role = resolveOidcRole(resolveOidcUsername(claims) || user.username, claims);
    if (role !== user.role || user.roleSource !== "oidc") {
      await userOps.updateUser(user.id, { role, roleSource: "oidc" });
      return toResolvedUser(await userOps.getUserById(user.id));
    }
    return toResolvedUser(user);
  }

  const baseUsername = resolveOidcUsername(claims);
  if (!baseUsername) {
    throw httpError("OIDC identity did not include a usable username", 400);
  }

  const role = resolveOidcRole(baseUsername, claims);
  const identity = {
    providerType: "oidc",
    providerKey: config.issuer,
    subject,
    displayName: toDisplayName(claims),
  };

  try {
    const adopted = await adoptLegacyUser(baseUsername, role, identity);
    if (adopted) return toResolvedUser(adopted);
    return toResolvedUser(await provisionOidcUser(baseUsername, role, identity));
  } catch (error) {
    // A concurrent login claimed this subject or username first.
    if (error?.code === "23505") {
      throw httpError("This sign-in is already being set up; please try again", 409);
    }
    throw error;
  }
}

function buildCallbackUrl(req) {
  const redirectUri = getRequiredConfig()?.redirectUri;
  if (!redirectUri) throw new Error("OIDC_REDIRECT_URI is required");
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(req.query || {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value[0] != null) url.searchParams.set(key, String(value[0]));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

export async function startOidcLogin(req, res) {
  if (!isOidcEnabled()) {
    res.status(404).json({ error: "OIDC is not enabled" });
    return;
  }

  const { config, oidc } = await getDiscoveryConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const transactionId = client.randomState();

  prunePendingLogins();
  pendingLogins.set(state, {
    codeVerifier,
    nonce,
    transactionId,
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  const parameters = {
    redirect_uri: config.redirectUri,
    scope: getScopes(),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  };

  const redirectTo = client.buildAuthorizationUrl(oidc, parameters);
  setTransactionCookie(req, res, transactionId);
  res.redirect(302, redirectTo.href);
}

export async function handleOidcCallback(req) {
  if (!isOidcEnabled()) {
    throw Object.assign(new Error("OIDC is not enabled"), { status: 404 });
  }

  const state = String(req.query?.state || "");
  const transactionId = getTransactionCookie(req);
  prunePendingLogins();
  const pending = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!pending || pending.expiresAt <= Date.now() || pending.transactionId !== transactionId) {
    throw Object.assign(new Error("OIDC login session expired"), { status: 400 });
  }

  const { config, oidc } = await getDiscoveryConfig();
  const tokens = await client.authorizationCodeGrant(oidc, buildCallbackUrl(req), {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });

  const claims = await fetchEffectiveClaims(oidc, tokens, tokens.claims() || {});
  const user = await resolveOidcSessionUser(config, claims);

  const code = client.randomState();
  prunePendingExchanges();
  pendingExchanges.set(code, {
    expiresAt: Date.now() + EXCHANGE_TTL_MS,
    transactionId,
    user,
  });
  return {
    code,
    user,
  };
}

export async function exchangeOidcCallback(code, req) {
  if (!isOidcEnabled()) {
    throw Object.assign(new Error("OIDC is not enabled"), { status: 404 });
  }

  const transactionId = getTransactionCookie(req);
  const exchangeCode = String(code || "");
  prunePendingExchanges();
  const pending = pendingExchanges.get(exchangeCode);
  if (!pending || pending.expiresAt <= Date.now() || pending.transactionId !== transactionId) {
    throw Object.assign(new Error("OIDC login session expired"), { status: 400 });
  }

  pendingExchanges.delete(exchangeCode);
  // The account may have been suspended since the callback resolved it.
  const current = await userOps.getUserAuthById(pending.user.id);
  if (!current || current.status !== "active") {
    throw Object.assign(new Error("This account has been suspended or disabled"), { status: 403 });
  }
  const session = await createSession(pending.user.id, req.ip || null, req.headers["user-agent"] || null);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: pending.user,
  };
}

export function clearOidcTransactionCookie(req, res) {
  setTransactionCookie(req, res, "", 0);
}

export function resetOidcStateForTests() {
  pendingLogins.clear();
  pendingExchanges.clear();
  discoveryConfig = null;
  discoveryKey = "";
}
