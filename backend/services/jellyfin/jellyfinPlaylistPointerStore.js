import { createJsonSettingStore } from "../../db/helpers/jsonSettingStore.js";

const store = createJsonSettingStore("jellyfinPlaylistPointers");

const normalizePointer = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const playlistId = raw.playlistId != null ? String(raw.playlistId) : null;
  if (!playlistId) return null;
  return {
    playlistId,
    title: String(raw.title || ""),
    serverUrl: String(raw.serverUrl || ""),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
};

export const jellyfinPlaylistPointerStore = {
  async getPointer(entityId, targetKey) {
    const pointers = await store.read();
    return normalizePointer(pointers[entityId]?.[targetKey] || null);
  },

  async setPointer(entityId, targetKey, { playlistId, title, serverUrl }) {
    const pointers = await store.read();
    if (!pointers[entityId]) pointers[entityId] = {};
    pointers[entityId][targetKey] = {
      playlistId: String(playlistId),
      title: String(title || ""),
      serverUrl: String(serverUrl || ""),
      updatedAt: Date.now(),
    };
    await store.write(pointers);
  },

  async deletePointer(entityId, targetKey) {
    const pointers = await store.read();
    if (!pointers[entityId]?.[targetKey]) return false;
    delete pointers[entityId][targetKey];
    if (!Object.keys(pointers[entityId]).length) delete pointers[entityId];
    await store.write(pointers);
    return true;
  },
};
