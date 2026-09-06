import { decryptWithKey, encryptWithKey } from "../../config/encryption.js";
import { createJsonSettingStore } from "../../db/helpers/jsonSettingStore.js";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.js";

const store = createJsonSettingStore("plexConnections");

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
  const token = decryptToken(raw.token);
  const clientId = String(raw.clientId || "").trim();
  if (!token || !clientId) return null;
  const linkType = raw.linkType === "managed" ? "managed" : "self";
  return {
    linkType,
    token,
    clientId,
    plexAccountId: raw.plexAccountId ?? null,
    plexUuid: raw.plexUuid || null,
    plexUsername: raw.plexUsername || null,
    linkedByAdminId:
      raw.linkedByAdminId != null && Number.isFinite(Number(raw.linkedByAdminId))
        ? Number(raw.linkedByAdminId)
        : null,
    connectedAt:
      raw.connectedAt != null && Number.isFinite(Number(raw.connectedAt))
        ? Number(raw.connectedAt)
        : Date.now(),
    lastError:
      raw.lastError && typeof raw.lastError === "object" && raw.lastError.message
        ? {
            message: String(raw.lastError.message),
            at: Number(raw.lastError.at) || Date.now(),
          }
        : null,
  };
};

export const plexConnectionStore = {
  async getConnection(userId) {
    const connections = await store.read();
    return normalizeConnection(connections[userKey(userId)] || null);
  },

  async getPublicStatus(userId) {
    const connection = await this.getConnection(userId);
    if (!connection) {
      return { connected: false, linkType: null, plexUsername: null, connectedAt: null, lastError: null };
    }
    return {
      connected: true,
      linkType: connection.linkType,
      plexUsername: connection.plexUsername,
      connectedAt: connection.connectedAt,
      lastError: connection.lastError,
    };
  },

  async saveConnection(
    userId,
    {
      linkType,
      token,
      clientId,
      plexAccountId = null,
      plexUuid = null,
      plexUsername = null,
      linkedByAdminId = null,
    } = {},
  ) {
    const safeToken = String(token || "").trim();
    const safeClientId = String(clientId || "").trim();
    if (!safeToken || !safeClientId) {
      throw new Error("Plex token and clientId are required");
    }
    if (linkType !== "managed" && linkType !== "self") {
      throw new Error('linkType must be "managed" or "self"');
    }
    const connections = await store.read();
    connections[userKey(userId)] = {
      linkType,
      token: encryptToken(safeToken),
      clientId: safeClientId,
      plexAccountId,
      plexUuid,
      plexUsername,
      linkedByAdminId:
        linkedByAdminId != null && Number.isFinite(Number(linkedByAdminId))
          ? Number(linkedByAdminId)
          : null,
      connectedAt: Date.now(),
      lastError: null,
    };
    await store.write(connections);
    return this.getConnection(userId);
  },

  async updateToken(userId, { token, clientId } = {}) {
    const connections = await store.read();
    const key = userKey(userId);
    const existing = connections[key];
    if (!existing) return null;
    existing.token = encryptToken(token || decryptToken(existing.token));
    if (clientId) existing.clientId = clientId;
    existing.lastError = null;
    await store.write(connections);
    return this.getConnection(userId);
  },

  async setLastError(userId, message) {
    const connections = await store.read();
    const key = userKey(userId);
    const existing = connections[key];
    if (!existing) return null;
    existing.lastError = { message: String(message || "Unknown error"), at: Date.now() };
    await store.write(connections);
    return this.getConnection(userId);
  },

  async clearConnection(userId) {
    const connections = await store.read();
    const key = userKey(userId);
    if (!connections[key]) return false;
    delete connections[key];
    await store.write(connections);
    return true;
  },

  async getAllLinkedPlexAccountIds() {
    const connections = await store.read();
    const ids = new Set();
    for (const entry of Object.values(connections)) {
      if (entry?.plexAccountId != null) ids.add(String(entry.plexAccountId));
    }
    return ids;
  },
};
