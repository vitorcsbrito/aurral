import { decryptWithKey, encryptWithKey } from "../../config/encryption.js";
import { createJsonSettingStore } from "../../db/helpers/jsonSettingStore.js";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.js";

const store = createJsonSettingStore("spotifyConnections");

const userKey = (userId) => String(Math.trunc(Number(userId)));

const encryptToken = (value) => {
  const key = getSettingsEncryptionKey();
  return encryptWithKey(String(value || ""), key);
};

const decryptToken = (value) => {
  const key = getSettingsEncryptionKey();
  return decryptWithKey(value, key);
};

const normalizeConnection = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const accessToken = decryptToken(raw.accessToken);
  const refreshToken = decryptToken(raw.refreshToken);
  if (!accessToken || !refreshToken) return null;
  const expiresAt = Number(raw.expiresAt);
  return {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    displayName: String(raw.displayName || "").trim() || null,
    connectedAt:
      raw.connectedAt != null && Number.isFinite(Number(raw.connectedAt))
        ? Number(raw.connectedAt)
        : Date.now(),
  };
};

export const spotifyConnectionStore = {
  async getConnection(userId) {
    const connections = await store.read();
    return normalizeConnection(connections[userKey(userId)] || null);
  },

  async getPublicStatus(userId) {
    const connection = await this.getConnection(userId);
    if (!connection) {
      return { connected: false, displayName: null, connectedAt: null };
    }
    return {
      connected: true,
      displayName: connection.displayName,
      connectedAt: connection.connectedAt,
    };
  },

  async saveConnection(userId, { accessToken, refreshToken, expiresAt, displayName = null } = {}) {
    const safeAccessToken = String(accessToken || "").trim();
    const safeRefreshToken = String(refreshToken || "").trim();
    if (!safeAccessToken || !safeRefreshToken) {
      throw new Error("Spotify tokens are required");
    }
    const connections = await store.read();
    const now = Date.now();
    const parsedExpiresAt = Number(expiresAt);
    connections[userKey(userId)] = {
      accessToken: encryptToken(safeAccessToken),
      refreshToken: encryptToken(safeRefreshToken),
      expiresAt:
        Number.isFinite(parsedExpiresAt) && parsedExpiresAt > 0
          ? parsedExpiresAt
          : now + 3600 * 1000,
      displayName: String(displayName || "").trim() || null,
      connectedAt: now,
    };
    await store.write(connections);
    return this.getConnection(userId);
  },

  async updateTokens(userId, { accessToken, refreshToken, expiresAt } = {}) {
    const current = await this.getConnection(userId);
    if (!current) return null;
    return this.saveConnection(userId, {
      accessToken: accessToken || current.accessToken,
      refreshToken: refreshToken || current.refreshToken,
      expiresAt: expiresAt ?? current.expiresAt,
      displayName: current.displayName,
    });
  },

  async clearConnection(userId) {
    const connections = await store.read();
    const key = userKey(userId);
    if (!connections[key]) return false;
    delete connections[key];
    await store.write(connections);
    return true;
  },

  async clearConnectionIfMatches(userId, expected = {}) {
    const connections = await store.read();
    const key = userKey(userId);
    const current = normalizeConnection(connections[key] || null);
    if (
      !current ||
      current.accessToken !== expected.accessToken ||
      current.refreshToken !== expected.refreshToken
    ) {
      return false;
    }
    delete connections[key];
    await store.write(connections);
    return true;
  },
};
