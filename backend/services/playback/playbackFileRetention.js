import fs from "node:fs/promises";
import path from "node:path";
import { dbOps } from "../../db/helpers/index.js";
import { logger } from "../logger.js";
import { localFileKey } from "./playlistUsage.js";
import { isPathInsideRoot, resolvePlaylistRoot } from "../playlistPaths.js";

const SETTINGS_KEY = "playbackRetainedFiles";

function readRetainedFiles() {
  const value = dbOps.getJSONSetting(SETTINGS_KEY);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function isPlaybackRetainedFile(file) {
  return Boolean(readRetainedFiles()[localFileKey(file)]);
}

// The settings mirror only changes after the database write completes, so
// read-modify-write updates are chained: each one reads the result of the
// previous write instead of racing it and dropping its entry.
let retentionWrites = Promise.resolve();

function updateRetainedFiles(mutate) {
  const write = retentionWrites.then(async () => {
    const retained = readRetainedFiles();
    if (mutate(retained) === false) return;
    await dbOps.setJSONSetting(SETTINGS_KEY, retained);
  });
  retentionWrites = write.catch(() => {});
  return write;
}

function recordRetention(file, reason, excludeEntityIds, playlistRoot) {
  const key = localFileKey(file);
  return updateRetainedFiles((retained) => {
    retained[key] = { reason, excludeEntityIds, playlistRoot, checkedAt: Date.now() };
  });
}

export function forgetPlaybackRetainedFile(file) {
  const key = localFileKey(file);
  return updateRetainedFiles((retained) => {
    if (!(key in retained)) return false;
    delete retained[key];
  });
}

// One fresh playlist snapshot per cleanup batch, never a cached "unused"
// decision carried from an earlier reset. Failures retain files in place.
export function createPlaybackDeletionGuard({
  excludeEntityIds = [], registry = null, playlistRoot = resolvePlaylistRoot(),
} = {}) {
  const retentionRoot = path.resolve(playlistRoot);
  let snapshot;
  // Plex connections count by account only: token rotation and sync errors
  // rewrite them without changing whose playlists the snapshot read.
  const configKey = () => {
    const settings = dbOps.getSettings();
    const plexConnections = Object.entries(dbOps.getJSONSetting("plexConnections") || {})
      .map(([userId, connection]) => [
        userId,
        connection?.linkType ?? null,
        connection?.clientId ?? null,
        connection?.plexAccountId ?? null,
        connection?.plexUuid ?? null,
      ])
      .sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([settings.integrations, settings.pathMappings, plexConnections]);
  };
  let checkedConfig;
  const load = async () => {
    checkedConfig = configKey();
    let currentRegistry = registry;
    if (!currentRegistry) {
      const { playlistManager } = await import("../weeklyFlow/weeklyFlowPlaylistManager.js");
      playlistManager.updateConfig(false);
      currentRegistry = playlistManager.destinationRegistry;
    }
    const results = await currentRegistry.run("getReferencedPaths", { excludeEntityIds });
    const paths = new Set();
    for (const result of results) {
      if (!result.ok || !Array.isArray(result.paths)) {
        throw new Error(`${result.destination}: playlist usage could not be verified`);
      }
      for (const file of result.paths) paths.add(localFileKey(file));
    }
    return paths;
  };
  return {
    async canDelete(file) {
      snapshot ??= load().then((paths) => ({ paths })).catch((error) => {
        logger.warn("playback", "Deferring file cleanup: playlist usage could not be verified", {
          reason: error.message,
        });
        return { error };
      });
      const result = await snapshot;
      const reason = result.error || checkedConfig !== configKey() ? "usage-unknown"
        : result.paths.has(localFileKey(file)) ? "playlist-reference" : null;
      // An approval supersedes an earlier retention; a stale record would
      // later make the retry treat a new file at this path as retained.
      if (reason) await recordRetention(file, reason, excludeEntityIds, retentionRoot);
      else await forgetPlaybackRetainedFile(file);
      return reason == null;
    },
  };
}

export async function retryPlaybackRetainedFiles() {
  const files = Object.entries(readRetainedFiles());
  if (!files.length) return;
  const { downloadTracker } = await import("../weeklyFlow/weeklyFlowDownloadTracker.js");
  const stillOwned = (file) => downloadTracker.getAll().some((job) =>
    job.finalPath && localFileKey(job.finalPath) === file);
  const guards = new Map();
  for (const [file, metadata] of files) {
    // Older records have no root; only retry those within the current root.
    const playlistRoot = metadata?.playlistRoot ?? resolvePlaylistRoot();
    if (typeof playlistRoot !== "string" || !path.isAbsolute(playlistRoot)
      || !isPathInsideRoot(file, playlistRoot) || stillOwned(file)) continue;
    const excludeEntityIds = [...new Set((Array.isArray(metadata?.excludeEntityIds)
      ? metadata.excludeEntityIds : []).filter((id) => typeof id === "string" && id.trim()))].sort();
    const guardKey = JSON.stringify([localFileKey(playlistRoot), excludeEntityIds]);
    if (!guards.has(guardKey)) {
      guards.set(guardKey, createPlaybackDeletionGuard({ excludeEntityIds, playlistRoot }));
    }
    const guard = guards.get(guardKey);
    try {
      const original = await fs.lstat(file);
      if (!original.isFile() || !(await guard.canDelete(file)) || stillOwned(file)) continue;
      if (!isPathInsideRoot(await fs.realpath(file), await fs.realpath(playlistRoot))) continue;
      const current = await fs.lstat(file);
      if (current.ino !== original.ino || current.size !== original.size || current.mtimeMs !== original.mtimeMs) continue;
      await fs.rm(file, { force: true });
      await forgetPlaybackRetainedFile(file);
    } catch (error) {
      if (error.code === "ENOENT") await forgetPlaybackRetainedFile(file);
      else logger.warn("playback", "Could not retry retained file cleanup", { file, reason: error.message });
    }
  }
}

// Never recursively remove a directory containing a protected track. Keep its
// original path so a server's track ID and external playlist entries survive.
export async function removeUnusedPlaybackFiles(
  directory, guard = createPlaybackDeletionGuard(), { protectPlayback = true } = {},
) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    if (!protectPlayback) {
      await fs.unlink(directory);
      await forgetPlaybackRetainedFile(directory);
    }
    return;
  }
  if (!stat.isDirectory()) {
    if (await guard.canDelete(directory)) {
      await fs.rm(directory, { force: true });
      await forgetPlaybackRetainedFile(directory);
    }
    return;
  }
  for (const name of await fs.readdir(directory)) {
    await removeUnusedPlaybackFiles(path.join(directory, name), guard, { protectPlayback });
  }
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code)) throw error;
  }
}
