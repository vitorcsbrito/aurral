// Scan worker entry; gets its own Postgres pool from DATABASE_URL.
import { parentPort, workerData } from "node:worker_threads";
import { closeDatabase, db } from "../config/database.js";
import { migrateDatabase } from "../db/pg/schema.js";
import { loadSettingsCache } from "../db/helpers/settings.js";

const toPlain = (value) => JSON.parse(JSON.stringify(value ?? null));

try {
  // Advisory-locked, so racing the main thread is safe.
  await migrateDatabase(db, { logger: {} });
  // The settings mirror is per-thread; nothing else populates it here.
  await loadSettingsCache();
  const { lidarrClient } = await import("./lidarrClient.js");
  const { scanConfiguredLibrary } = await import("./libraryIndexService.js");
  const result = await scanConfiguredLibrary({
    ...(workerData?.musicRoot ? { musicRoot: String(workerData.musicRoot) } : {}),
    lidarrClient,
    includeLidarr: workerData?.includeLidarr === true,
    artistIds: Array.isArray(workerData?.artistIds) ? workerData.artistIds : null,
    force: workerData?.force === true,
    includeLocal: workerData?.includeLocal === true,
  });
  parentPort.postMessage({ type: "done", result: toPlain(result) });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
} finally {
  await closeDatabase().catch(() => {});
}
