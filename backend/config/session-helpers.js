import crypto from "crypto";
import { db } from "./database.js";
import { userOps } from "../db/helpers/index.js";

const DEFAULT_EXPIRY_HOURS = 24 * 30;

const INSERT_SESSION_SQL =
  "INSERT INTO sessions (user_id, token, created_at, expires_at, ip_address, user_agent, reauthenticated_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
const GET_SESSION_BY_TOKEN_SQL = "SELECT * FROM sessions WHERE token = ? LIMIT 1";
const DELETE_SESSION_BY_TOKEN_SQL = "DELETE FROM sessions WHERE token = ?";
const DELETE_SESSIONS_BY_USER_ID_SQL = "DELETE FROM sessions WHERE user_id = ?";
const DELETE_EXPIRED_SESSIONS_SQL = "DELETE FROM sessions WHERE expires_at <= ?";
const TOUCH_REAUTH_SQL = "UPDATE sessions SET reauthenticated_at = ? WHERE token = ?";
const TOUCH_REAUTH_FOR_USER_SQL =
  "UPDATE sessions SET reauthenticated_at = ? WHERE token = ? AND user_id = ?";

const getSessionExpiryMs = () => {
  const hours = Number(process.env.SESSION_EXPIRY_HOURS);
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_EXPIRY_HOURS;
  return safeHours * 60 * 60 * 1000;
};

const toUserPayload = (user) => {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: user.permissions,
  };
};

// A new session counts as a fresh authentication for requireRecentAuth().
export const createSession = async (userId, ipAddress = null, userAgent = null) => {
  const now = Date.now();
  const expiresAt = now + getSessionExpiryMs();
  const token = crypto.randomBytes(32).toString("hex");
  await db.run(INSERT_SESSION_SQL, [
    Number(userId),
    token,
    now,
    expiresAt,
    ipAddress ? String(ipAddress).slice(0, 255) : null,
    userAgent ? String(userAgent).slice(0, 1024) : null,
    now,
  ]);
  return {
    token,
    expiresAt,
  };
};

// Re-arms the recent-authentication window of one session. With a userId, a
// token that belongs to another user is left alone.
export const touchReauth = async (token, userId = null) => {
  const rawToken = String(token || "").trim();
  if (!rawToken) return false;
  const result =
    userId == null
      ? await db.run(TOUCH_REAUTH_SQL, [Date.now(), rawToken])
      : await db.run(TOUCH_REAUTH_FOR_USER_SQL, [Date.now(), rawToken, Number(userId)]);
  return result.changes > 0;
};

export const getSessionByToken = async (token) => {
  const rawToken = String(token || "").trim();
  if (!rawToken) return null;
  const row = await db.get(GET_SESSION_BY_TOKEN_SQL, [rawToken]);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await db.run(DELETE_SESSION_BY_TOKEN_SQL, [rawToken]);
    return null;
  }
  const user = await userOps.getUserAuthById(row.user_id);
  if (!user || user.status !== "active") {
    await db.run(DELETE_SESSION_BY_TOKEN_SQL, [rawToken]);
    return null;
  }
  return {
    id: row.id,
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    reauthenticatedAt: row.reauthenticated_at || row.created_at,
    user: toUserPayload(user),
  };
};

export const deleteSession = async (token) => {
  const result = await db.run(DELETE_SESSION_BY_TOKEN_SQL, [String(token || "").trim()]);
  return result.changes > 0;
};

export const deleteSessionsByUserId = async (userId) => {
  const result = await db.run(DELETE_SESSIONS_BY_USER_ID_SQL, [Number(userId)]);
  return result.changes;
};

export const cleanExpiredSessions = async () => {
  const result = await db.run(DELETE_EXPIRED_SESSIONS_SQL, [Date.now()]);
  return result.changes;
};
