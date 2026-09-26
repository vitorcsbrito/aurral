import { dbOps } from "./settings.js";

// Object stores persisted as one JSON settings row (connections, pointers).
// Writes go through update(), which runs each read-modify-write after the
// previous one, so concurrent callers cannot overwrite each other's changes.
export function createJsonSettingStore(settingsKey) {
  let pending = Promise.resolve();
  const read = async () => {
    const parsed = await dbOps.readJSONSetting(settingsKey);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  };
  // `mutate` edits the store in place and returns the caller's result;
  // returning false leaves the stored value untouched.
  const update = (mutate) => {
    const run = pending.then(async () => {
      const store = await read();
      const result = await mutate(store);
      if (result !== false) await dbOps.setJSONSetting(settingsKey, store);
      return result;
    });
    pending = run.catch(() => {});
    return run;
  };
  return { read, update };
}
