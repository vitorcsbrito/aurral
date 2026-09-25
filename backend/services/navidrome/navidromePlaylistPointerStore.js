import { createJsonSettingStore } from "../../db/helpers/jsonSettingStore.js";

const store = createJsonSettingStore("navidromePlaylistPointers");

const normalizePointer = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const playlistId = raw.playlistId != null ? String(raw.playlistId) : null;
  if (!playlistId) return null;
  return {
    playlistId,
    title: String(raw.title || ""),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
};

export const navidromePlaylistPointerStore = {
  async getPointersForEntity(entityId) {
    const pointers = await store.read();
    return Object.values(pointers[entityId] || {}).map(normalizePointer).filter(Boolean);
  },

  async getPointer(entityId, targetKey) {
    const pointers = await store.read();
    return normalizePointer(pointers[entityId]?.[targetKey] || null);
  },

  async setPointer(entityId, targetKey, { playlistId, title }) {
    await store.update((pointers) => {
      if (!pointers[entityId]) pointers[entityId] = {};
      pointers[entityId][targetKey] = {
        playlistId: String(playlistId),
        title: String(title || ""),
        updatedAt: Date.now(),
      };
    });
  },

  async deletePointer(entityId, targetKey) {
    return store.update((pointers) => {
      if (!pointers[entityId]?.[targetKey]) return false;
      delete pointers[entityId][targetKey];
      if (!Object.keys(pointers[entityId]).length) delete pointers[entityId];
      return true;
    });
  },

  async hasPlaylistId(playlistId) {
    const expected = String(playlistId);
    const pointers = await store.read();
    return Object.values(pointers).some((targets) =>
      Object.values(targets || {}).some((raw) => normalizePointer(raw)?.playlistId === expected),
    );
  },
};
