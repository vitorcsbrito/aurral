import express from "express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../config/database.js";
import { getLastfmApiKey, getLastfmApiSecret, lastfmGetSession, listenbrainzValidateToken } from "../services/apiClients/index.js";
import { userOps } from "../db/helpers/index.js";
import { requireAuth, requirePermission } from "../middleware/requirePermission.js";
import { validateExternalUrl } from "../middleware/urlValidator.js";
import { getKoitoListenBrainzBaseUrl, normalizeKoitoBaseUrl } from "../services/koitoClient.js";
import { getScrobbleEncryptionKey, scrobbleConnectionStore } from "../services/scrobbleConnectionStore.js";
import { logger } from "../services/logger.js";

const router = express.Router();
const LASTFM_LINK_COOKIE = "aurral_lastfm_link";
const LASTFM_LINK_TTL_MS = 10 * 60 * 1000;
const providerErrorStatus = (error) => {
  const status = Number(error?.response?.status);
  return status >= 400 && status < 500 ? 400 : 502;
};
const encode = (value) => Buffer.from(value).toString("base64url");
const decode = (value) => Buffer.from(String(value || ""), "base64url").toString("utf8");
const hash = (value) => createHash("sha256").update(String(value || "")).digest("hex");

const INSERT_LINK_STATE_SQL = `
  INSERT INTO lastfm_link_states
    (token_hash, user_id, browser_nonce_hash, expires_at, created_at)
  VALUES (?, ?, ?, ?, ?)
`;
const PRUNE_LINK_STATES_SQL =
  "DELETE FROM lastfm_link_states WHERE expires_at <= ? OR consumed_at IS NOT NULL";
const CONSUME_LINK_STATE_SQL = `
  UPDATE lastfm_link_states
  SET consumed_at = ?
  WHERE token_hash = ? AND user_id = ? AND browser_nonce_hash = ?
    AND expires_at > ? AND consumed_at IS NULL
`;

const createLinkToken = (userId) => {
  const payload = `${userId}.${Date.now() + 10 * 60 * 1000}.${randomBytes(12).toString("hex")}`;
  const signature = createHmac("sha256", getScrobbleEncryptionKey()).update(payload).digest("base64url");
  return `${encode(payload)}.${signature}`;
};

const verifyLinkToken = (token) => {
  const [encodedPayload, signature] = String(token || "").split(".");
  if (!encodedPayload || !signature) return null;
  const payload = decode(encodedPayload);
  const expected = createHmac("sha256", getScrobbleEncryptionKey()).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const [userId, expiresAt] = payload.split(".");
  if (!Number.isFinite(Number(userId)) || Number(expiresAt) <= Date.now()) return null;
  return Math.trunc(Number(userId));
};

const createLinkState = async (userId) => {
  const token = createLinkToken(userId);
  const browserNonce = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + LASTFM_LINK_TTL_MS;
  await db.transaction(async () => {
    await db.run(PRUNE_LINK_STATES_SQL, [Date.now()]);
    await db.run(INSERT_LINK_STATE_SQL, [hash(token), userId, hash(browserNonce), expiresAt, Date.now()]);
  });
  return { token, browserNonce };
};

export const consumeLinkState = async (token, userId, browserNonce) => {
  if (!token || !Number.isFinite(Number(userId)) || !browserNonce) return false;
  const result = await db.run(CONSUME_LINK_STATE_SQL, [
    Date.now(),
    hash(token),
    Math.trunc(Number(userId)),
    hash(browserNonce),
    Date.now(),
  ]);
  return result.changes === 1;
};

const readCookie = (header, name) => {
  const entry = String(header || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return "";
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return "";
  }
};

const setLinkCookie = (res, req, value, maxAge = Math.floor(LASTFM_LINK_TTL_MS / 1000)) => {
  const attributes = [
    "Path=/api/scrobbling/lastfm/link/callback",
    `Max-Age=${Math.max(0, Math.trunc(maxAge))}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (req.protocol === "https") attributes.push("Secure");
  res.append("Set-Cookie", `${LASTFM_LINK_COOKIE}=${encodeURIComponent(value)}; ${attributes.join("; ")}`);
};

const normalizeLinkToken = (value) => {
  const token = String(value || "").trim();
  return token.includes(".") ? token : decode(token);
};

export const callbackUrl = (req, token) => {
  const configuredOrigin = String(process.env.AURRAL_PUBLIC_URL || "").trim();
  if (configuredOrigin) {
    try {
      const url = new URL(configuredOrigin);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        return `${url.origin}/api/scrobbling/lastfm/link/callback?uid=${encodeURIComponent(token)}`;
      }
    } catch {}
  }
  const protocol = String(req.protocol || "http").trim();
  const host = String(req.get("host") || "").trim();
  return `${protocol}://${host}/api/scrobbling/lastfm/link/callback?uid=${encodeURIComponent(token)}`;
};

router.get("/status", requireAuth, async (req, res, next) => {
  try {
    const status = await scrobbleConnectionStore.getPublicStatus(req.user.id);
    status.lastfm.configured = Boolean(getLastfmApiKey() && getLastfmApiSecret());
    res.json(status);
  } catch (error) {
    next(error);
  }
});

router.get("/lastfm/link", requireAuth, async (req, res, next) => {
  try {
    const configured = Boolean(getLastfmApiKey() && getLastfmApiSecret());
    if (!configured) {
      return res.status(400).json({ error: "Last.fm API key and secret are required first." });
    }
    const { token, browserNonce } = await createLinkState(req.user.id);
    setLinkCookie(res, req, browserNonce);
    res.json({
      configured: true,
      connected: (await scrobbleConnectionStore.getConnection(req.user.id, "lastfm")) != null,
      authorizeUrl: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(getLastfmApiKey())}&cb=${encodeURIComponent(callbackUrl(req, token))}`,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/lastfm/link/callback", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const clearCookie = () => setLinkCookie(res, req, "", 0);
  const stateToken = normalizeLinkToken(req.query.uid);
  const token = String(req.query.token || "").trim();
  if (!stateToken || !token) {
    clearCookie();
    return res.status(400).send("Invalid Last.fm link state");
  }

  let userId;
  try {
    userId = verifyLinkToken(stateToken);
  } catch (error) {
    logger.error("scrobbling", "Last.fm link state verification failed", {
      message: error?.message || String(error),
    });
    clearCookie();
    return res.status(500).send("Last.fm connection failed");
  }
  if (
    userId == null ||
    !(await consumeLinkState(stateToken, userId, readCookie(req.headers.cookie, LASTFM_LINK_COOKIE)))
  ) {
    clearCookie();
    return res.status(400).send("Invalid Last.fm link state");
  }

  let session;
  try {
    session = await lastfmGetSession(token);
  } catch (error) {
    logger.error("scrobbling", "Last.fm session exchange failed", {
      message: error?.message || String(error),
      status: error?.response?.status || null,
    });
    clearCookie();
    const status = providerErrorStatus(error);
    return res.status(status).send(status === 400 ? "Last.fm authorization failed" : "Last.fm is unavailable");
  }
  const key = session?.session?.key;
  if (!key) {
    clearCookie();
    return res.status(400).send("Last.fm did not return a session");
  }
  try {
    await scrobbleConnectionStore.saveConnection(userId, "lastfm", {
      token: key,
      displayName: session.session.name,
    });
  } catch (error) {
    logger.error("scrobbling", "Last.fm connection could not be saved", {
      message: error?.message || String(error),
    });
    clearCookie();
    return res.status(500).send("Last.fm connection could not be saved");
  }
  clearCookie();
  return res.type("html").send("<p>Last.fm connected. You can close this window.</p>");
});

const deleteProviderLink = (provider) => async (req, res, next) => {
  try {
    await scrobbleConnectionStore.deleteConnection(req.user.id, provider);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};

router.delete("/lastfm/link", requireAuth, deleteProviderLink("lastfm"));

router.get("/listenbrainz/link", requireAuth, async (req, res, next) => {
  try {
    const connection = await scrobbleConnectionStore.getConnection(req.user.id, "listenbrainz");
    res.json({ connected: Boolean(connection), displayName: connection?.displayName || null });
  } catch (error) {
    next(error);
  }
});

router.put("/listenbrainz/link", requireAuth, async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "Token is required" });
  let validation;
  try {
    validation = await listenbrainzValidateToken(token);
  } catch (error) {
    logger.warn("scrobbling", "ListenBrainz token validation failed", {
      message: error?.message || String(error),
      status: error?.response?.status || null,
    });
    return res.status(providerErrorStatus(error)).json({
      error: providerErrorStatus(error) === 400 ? "Invalid token" : "ListenBrainz is unavailable",
    });
  }
  if (!validation?.valid) return res.status(400).json({ error: "Invalid token" });
  try {
    const connection = await scrobbleConnectionStore.saveConnection(req.user.id, "listenbrainz", {
      token,
      displayName: validation.user_name,
    });
    return res.json({ connected: true, displayName: connection.displayName });
  } catch (error) {
    logger.error("scrobbling", "ListenBrainz connection could not be saved", {
      message: error?.message || String(error),
    });
    return res.status(500).json({ error: "ListenBrainz connection could not be saved" });
  }
});

router.delete("/listenbrainz/link", requireAuth, deleteProviderLink("listenbrainz"));

router.put("/koito/link", requirePermission("accessSettings"), async (req, res) => {
  const rawUrl = String(
    req.body?.url || (await userOps.getUserById(req.user.id))?.listenHistoryUrl || "",
  ).trim();
  const validation = validateExternalUrl(rawUrl);
  const token = String(req.body?.token || "").trim();
  if (!validation.valid || !token) return res.status(400).json({ error: validation.error || "Token is required" });
  const baseUrl = normalizeKoitoBaseUrl(validation.url);
  try {
    const tokenValidation = await listenbrainzValidateToken(
      token,
      getKoitoListenBrainzBaseUrl(baseUrl),
    );
    if (!tokenValidation?.valid) return res.status(400).json({ error: "Invalid Koito API key" });
  } catch (error) {
    logger.warn("scrobbling", "Koito token validation failed", {
      message: error?.message || String(error),
      status: error?.response?.status || null,
    });
    const status = providerErrorStatus(error);
    return res.status(status).json({ error: status === 400 ? "Invalid Koito API key" : "Koito is unavailable" });
  }
  try {
    const connection = await scrobbleConnectionStore.saveConnection(req.user.id, "koito", {
      token,
      baseUrl,
      displayName: new URL(baseUrl).host,
    });
    return res.json({ connected: true, displayName: connection.displayName });
  } catch (error) {
    logger.error("scrobbling", "Koito connection could not be saved", {
      message: error?.message || String(error),
    });
    return res.status(500).json({ error: "Koito connection could not be saved" });
  }
});

router.delete("/koito/link", requireAuth, deleteProviderLink("koito"));

export default router;
