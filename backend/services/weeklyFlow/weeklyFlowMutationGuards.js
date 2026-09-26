import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { withHonkerLock } from "../honkerDb.js";
import { logger } from "../logger.js";

const normalizePlaylistTypes = (playlistTypes) => [
  ...new Set(
    (Array.isArray(playlistTypes) ? playlistTypes : [playlistTypes])
      .map((playlistType) => String(playlistType || "").trim())
      .filter(Boolean),
  ),
];

async function withPlaylistLocks(playlistTypes, operation) {
  const sortedTypes = [...playlistTypes].sort();
  const runAtIndex = async (index) => {
    if (index >= sortedTypes.length) {
      return operation();
    }
    const playlistType = sortedTypes[index];
    return withHonkerLock(`playlist-mutation:${playlistType}`, () => runAtIndex(index + 1), {
      ttlSeconds: 180,
      waitTimeoutMs: 15 * 60 * 1000,
      retryDelayMs: 250,
    });
  };
  return runAtIndex(0);
}

export async function beginPlaylistMutation(playlistTypes, { clearPending = true } = {}) {
  const types = normalizePlaylistTypes(playlistTypes);
  // Only playlists this call blocked are rolled back if setup fails partway.
  const blocked = [];
  try {
    for (const playlistType of types) {
      weeklyFlowWorker.blockPlaylist(playlistType);
      blocked.push(playlistType);
      weeklyFlowWorker.clearIncompleteRetry(playlistType);
      if (clearPending) {
        downloadTracker.clearPendingByPlaylistType(playlistType);
      }
    }
    await Promise.all(
      types.map((playlistType) => weeklyFlowWorker.waitForPlaylistIdle(playlistType)),
    );
  } catch (error) {
    for (const playlistType of blocked) {
      try {
        weeklyFlowWorker.unblockPlaylist(playlistType);
      } catch (unblockError) {
        logger.warn("playlists", "Could not unblock playlist after mutation setup failed", {
          playlistId: playlistType,
          reason: unblockError?.message || String(unblockError),
        });
      }
    }
    throw error;
  }
  // Release every playlist and prune even if one unblock fails, then report
  // the first failure.
  return () => {
    let firstError = null;
    for (const playlistType of types) {
      try {
        weeklyFlowWorker.unblockPlaylist(playlistType);
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      weeklyFlowWorker.pruneOrphanedJobState();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  };
}

export async function withPlaylistMutation(playlistTypes, operation, options = {}) {
  const types = normalizePlaylistTypes(playlistTypes);
  return withPlaylistLocks(types, async () => {
    const releaseMutation = await beginPlaylistMutation(types, options);
    try {
      return await operation();
    } finally {
      releaseMutation();
    }
  });
}

export async function restartWorkerIfPending() {
  const stillPending = downloadTracker.getNextPending();
  if (stillPending && !weeklyFlowWorker.running) {
    await weeklyFlowWorker.start();
  }
}

export async function wakeDownloadWorker() {
  if (!weeklyFlowWorker.running) {
    await weeklyFlowWorker.start();
  } else {
    weeklyFlowWorker.wake();
  }
}
