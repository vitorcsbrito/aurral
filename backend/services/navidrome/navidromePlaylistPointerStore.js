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
  async getPointer(entityId, targetKey) {
    const pointers = await store.read();
    return normalizePointer(pointers[entityId]?.[targetKey] || null);
  },

  async setPointer(entityId, targetKey, { playlistId, title }) {
    const pointers = await store.read();
    if (!pointers[entityId]) pointers[entityId] = {};
    pointers[entityId][targetKey] = {
      playlistId: String(playlistId),
      title: String(title || ""),
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

  async hasPlaylistId(playlistId) {
    const expected = String(playlistId);
    const pointers = await store.read();
    return Object.values(pointers).some((targets) =>
      Object.values(targets || {}).some((raw) => normalizePointer(raw)?.playlistId === expected),
    );
  },
};
