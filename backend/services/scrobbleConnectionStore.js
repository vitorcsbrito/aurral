import crypto from "node:crypto";
import { decryptWithKey, encryptWithKey } from "../config/encryption.js";
import { createJsonSettingStore } from "../db/helpers/jsonSettingStore.js";
import { getSettingsEncryptionKey } from "../db/helpers/settings.js";

const PROVIDERS = new Set(["lastfm", "listenbrainz", "koito"]);
const store = createJsonSettingStore("scrobbleConnections");

// Same `_encryptionKey` row the settings mirror initializes at startup.
const getEncryptionKey = () => {
  const key = getSettingsEncryptionKey();
  if (key.length !== 32) throw new Error("Scrobble encryption key is invalid");
  return key;
};

const userKey = (userId) => String(Math.trunc(Number(userId)));
const encryptToken = (token) => encryptWithKey(String(token || ""), getEncryptionKey());
const decryptToken = (token) => decryptWithKey(token, getEncryptionKey());

export const getScrobbleEncryptionKey = getEncryptionKey;

const normalize = (provider, raw) => {
  if (!PROVIDERS.has(provider) || !raw || typeof raw !== "object") return null;
  const token = decryptToken(raw.token);
  if (!token) return null;
  return {
    provider,
    token,
    connectionRevision: String(raw.connectionRevision || raw.connectedAt || "").trim() || null,
    displayName: String(raw.displayName || "").trim() || null,
    baseUrl: String(raw.baseUrl || "").trim() || null,
    connectedAt: Number(raw.connectedAt) || null,
  };
};

export const scrobbleConnectionStore = {
  async getConnection(userId, provider) {
    const connections = await store.read();
    return normalize(provider, connections[userKey(userId)]?.[provider]);
  },

  async getConnections(userId) {
    const connections = await store.read();
    const raw = connections[userKey(userId)] || {};
    return Object.fromEntries(
      [...PROVIDERS]
        .map((provider) => {
          const connection = normalize(provider, raw[provider]);
          return connection ? [provider, connection] : null;
        })
        .filter(Boolean),
    );
  },

  async getPublicStatus(userId) {
    const connections = await this.getConnections(userId);
    return Object.fromEntries(
      [...PROVIDERS].map((provider) => {
        const connection = connections[provider];
        return [
          provider,
          connection
            ? { connected: true, displayName: connection.displayName, connectedAt: connection.connectedAt }
            : { connected: false, displayName: null, connectedAt: null },
        ];
      }),
    );
  },

  async saveConnection(userId, provider, { token, displayName = null, baseUrl = null } = {}) {
    if (!PROVIDERS.has(provider)) throw new Error("Unsupported scrobble provider");
    const safeToken = String(token || "").trim();
    if (!safeToken) throw new Error("Scrobble token is required");
    const connections = await store.read();
    const key = userKey(userId);
    connections[key] = connections[key] || {};
    connections[key][provider] = {
      token: encryptToken(safeToken),
      connectionRevision: crypto.randomUUID(),
      displayName: String(displayName || "").trim() || null,
      baseUrl: String(baseUrl || "").trim() || null,
      connectedAt: Date.now(),
    };
    await store.write(connections);
    return this.getConnection(userId, provider);
  },

  async deleteConnection(userId, provider) {
    const connections = await store.read();
    const key = userKey(userId);
    if (!connections[key]?.[provider]) return false;
    delete connections[key][provider];
    if (Object.keys(connections[key]).length === 0) delete connections[key];
    await store.write(connections);
    return true;
  },
};
