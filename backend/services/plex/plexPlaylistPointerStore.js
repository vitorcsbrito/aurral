import { createJsonSettingStore } from "../../db/helpers/jsonSettingStore.js";

const store = createJsonSettingStore("plexPlaylistPointers");

const normalizePointer = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const ratingKey = raw.ratingKey != null ? String(raw.ratingKey) : null;
  const location = String(raw.location || "").trim();
  if (!ratingKey || !location) return null;
  return {
    location,
    ratingKey,
    title: String(raw.title || ""),
    description: raw.description != null ? String(raw.description) : null,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
};

export const plexPlaylistPointerStore = {
  async getPointer(entityId, targetKey) {
    const pointers = await store.read();
    return normalizePointer(pointers[entityId]?.[targetKey] || null);
  },

  async setPointer(entityId, targetKey, { location, ratingKey, title, description = null }) {
    const pointers = await store.read();
    if (!pointers[entityId]) pointers[entityId] = {};
    pointers[entityId][targetKey] = {
      location: String(location || ""),
      ratingKey: String(ratingKey),
      title: String(title || ""),
      description: description != null ? String(description) : null,
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

  async getPointersForTarget(targetKey) {
    const pointers = await store.read();
    const results = [];
    for (const [entityId, targets] of Object.entries(pointers)) {
      const pointer = normalizePointer(targets?.[targetKey]);
      if (pointer) results.push({ entityId, ...pointer });
    }
    return results;
  },

  async getPointersForEntity(entityId) {
    const pointers = await store.read();
    return Object.entries(pointers[entityId] || {})
      .map(([targetKey, raw]) => {
        const pointer = normalizePointer(raw);
        return pointer ? { targetKey, ...pointer } : null;
      })
      .filter(Boolean);
  },
};
