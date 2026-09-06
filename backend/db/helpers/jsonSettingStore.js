import { dbOps } from "./settings.js";

// Object stores persisted as one JSON settings row (connections, pointers).
export function createJsonSettingStore(settingsKey) {
  const read = async () => {
    const parsed = await dbOps.readJSONSetting(settingsKey);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  };
  const write = async (store) => {
    await dbOps.setJSONSetting(settingsKey, store);
  };
  return { read, write };
}
