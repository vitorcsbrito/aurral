import crypto from "crypto";
import { db, dbHelpers } from "../../config/database.js";
import { decryptIntegrations, encryptIntegrations } from "../../config/encryption.js";
import {
  normalizePathMappings,
  syncPathMappings,
} from "../../services/pathMappings.js";
import {
  syncDownloadFolderPath,
  validateDownloadFolderPath,
} from "../../services/downloadFolderConfig.js";
import { normalizeExistingFileMode } from "../../services/weeklyFlow/weeklyFlowFileReuseMode.js";
import { normalizeDateTimeFormat } from "../../config/constants.js";
import { normalizeQualityProfile } from "../../services/qualityProfileModel.js";

const PLAYLIST_WORKER_RETRY_CYCLE_MINUTES = 360;

// getSettings() stays synchronous: it is read from request middleware and
// default parameters all over the backend. All settings rows are mirrored in
// memory; writes go through the database first, then update the mirror.
const settingsRows = new Map();
let settingsLoaded = false;
let settingsCache = null;
const UPSERT_SETTING_SQL =
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";

const readRow = (key) => settingsRows.get(key);

const assertLoaded = () => {
  if (!settingsLoaded) {
    throw new Error("Settings are not loaded yet; call loadSettingsCache() during startup");
  }
};

async function writeRow(key, value) {
  await db.run(UPSERT_SETTING_SQL, [key, value]);
  settingsRows.set(key, value);
  settingsCache = null;
}

async function deleteRow(key) {
  await db.run("DELETE FROM settings WHERE key = ?", [key]);
  settingsRows.delete(key);
  settingsCache = null;
}

export async function loadSettingsCache() {
  const rows = await db.all("SELECT key, value FROM settings");
  settingsRows.clear();
  for (const row of rows) settingsRows.set(row.key, row.value);
  settingsLoaded = true;
  settingsCache = null;
  if (!settingsRows.has("_encryptionKey")) {
    await writeRow("_encryptionKey", crypto.randomBytes(32).toString("base64"));
  }
  return settingsRows.size;
}

// Other threads and processes write settings too; refresh the mirror.
export async function refreshSettingsCache() {
  return loadSettingsCache();
}

function readStoredSettingJson(primaryKey, legacyKeys = []) {
  const primary = dbHelpers.parseJSON(readRow(primaryKey));
  if (primary != null) return primary;
  for (const legacyKey of legacyKeys) {
    const legacy = dbHelpers.parseJSON(readRow(legacyKey));
    if (legacy != null) return legacy;
  }
  return null;
}

function normalizePlaylistArtworkSettings(raw) {
  const artwork = raw && typeof raw === "object" ? raw : {};
  const style = String(artwork.style || "photo").trim().toLowerCase();
  return {
    style: style === "aurral" ? "aurral" : "photo",
  };
}

function normalizePlaylistWorkerSettings(raw) {
  const worker = raw && typeof raw === "object" ? raw : {};
  const parsedConcurrency = Number(worker.concurrency);
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
      ? Math.min(3, Math.floor(parsedConcurrency))
      : 2;
  const retryCycleMinutes = PLAYLIST_WORKER_RETRY_CYCLE_MINUTES;
  const retryPausedPlaylistIds = Array.isArray(worker.retryPausedPlaylistIds)
    ? [
        ...new Set(
          worker.retryPausedPlaylistIds
            .map((entry) => String(entry || "").trim())
            .filter(Boolean),
        ),
      ]
    : [];
  return {
    concurrency,
    retryCycleMinutes,
    retryPausedPlaylistIds,
    existingFileMode: normalizeExistingFileMode(worker.existingFileMode),
  };
}

function getEncryptionKey() {
  assertLoaded();
  const value = readRow("_encryptionKey");
  if (!value) throw new Error("Settings encryption key is missing");
  return Buffer.from(value, "base64");
}

export const dbOps = {
  getJSONSetting(key) {
    assertLoaded();
    return dbHelpers.parseJSON(readRow(key)) || null;
  },

  async readJSONSetting(key) {
    const row = await db.get("SELECT value FROM settings WHERE key = ?", [key]);
    if (row) settingsRows.set(key, row.value);
    else settingsRows.delete(key);
    return dbHelpers.parseJSON(row?.value) || null;
  },

  async setJSONSetting(key, value) {
    await writeRow(key, dbHelpers.stringifyJSON(value));
  },

  async deleteSetting(key) {
    await deleteRow(key);
  },

  getUserDiscoverLayout(userId) {
    return dbOps.getJSONSetting(`user:${parseInt(userId, 10)}:discoverLayout`);
  },

  async setUserDiscoverLayout(userId, layout) {
    await dbOps.setJSONSetting(`user:${parseInt(userId, 10)}:discoverLayout`, layout);
  },

  getSettings() {
    assertLoaded();
    if (settingsCache) return settingsCache;

    const integrations = dbHelpers.parseJSON(readRow("integrations"));
    const encKey = getEncryptionKey();
    const quality = readRow("quality");
    const dateTimeFormat = readRow("dateTimeFormat");
    const queueCleaner = dbHelpers.parseJSON(readRow("queueCleaner"));
    const security = dbHelpers.parseJSON(readRow("security"));
    const rootFolderPath = readRow("rootFolderPath");
    const downloadFolderPath = readRow("downloadFolderPath") || null;
    syncDownloadFolderPath(downloadFolderPath);
    const pathMappings = normalizePathMappings(
      dbHelpers.parseJSON(readRow("pathMappings")) || [],
    );
    syncPathMappings(pathMappings);
    const releaseTypes = dbHelpers.parseJSON(readRow("releaseTypes"));
    const flows = readStoredSettingJson("flows", ["weeklyFlows"]);
    const sharedPlaylists = readStoredSettingJson("sharedPlaylists", [
      "sharedFlowPlaylists",
    ]);
    const subsonic = readStoredSettingJson("subsonic") || {};
    const playlistWorker = normalizePlaylistWorkerSettings(
      readStoredSettingJson("playlistWorker", ["weeklyFlowWorker"]),
    );
    const playlistArtwork = normalizePlaylistArtworkSettings(
      readStoredSettingJson("playlistArtwork"),
    );
    const inbox = dbHelpers.parseJSON(readRow("inbox")) || {};
    const blocklist = dbHelpers.parseJSON(readRow("blocklist"));
    const onboardingComplete = readRow("onboardingComplete") === "true";

    const decryptedIntegrations = decryptIntegrations(integrations, encKey) || {};
    const storedQualityProfile = dbHelpers.parseJSON(readRow("qualityProfile"));
    const qualityProfile = normalizeQualityProfile(
      storedQualityProfile,
      decryptedIntegrations.slskd,
    );
    if (storedQualityProfile == null) {
      const serialized = dbHelpers.stringifyJSON(qualityProfile);
      settingsRows.set("qualityProfile", serialized);
      db.run(UPSERT_SETTING_SQL, ["qualityProfile", serialized]).catch((error) => {
        console.warn(`[settings] Failed to persist default quality profile: ${error?.message || error}`);
      });
    }
    const result = {
      integrations: decryptedIntegrations,
      quality: quality || "standard",
      dateTimeFormat: normalizeDateTimeFormat(dateTimeFormat),
      qualityProfile,
      queueCleaner: queueCleaner || {},
      security:
        security && typeof security === "object"
          ? security
          : { localNetworkBypass: { enabled: false } },
      rootFolderPath: rootFolderPath || null,
      downloadFolderPath: downloadFolderPath || null,
      pathMappings,
      releaseTypes: releaseTypes || [],
      flows: flows || null,
      sharedPlaylists: sharedPlaylists || null,
      subsonic: {
        favoriteAutoKeep: subsonic.favoriteAutoKeep !== false,
      },
      playlistWorker,
      playlistArtwork,
      inbox: {
        enabled: inbox.enabled !== false,
        releases: inbox.releases !== false,
        shows: inbox.shows !== false,
        news: inbox.news !== false,
        recommendedNews: inbox.recommendedNews === true,
        discoveries: inbox.discoveries !== false,
      },
      blocklist:
        blocklist && typeof blocklist === "object"
          ? blocklist
          : { artists: [], tags: [] },
      onboardingComplete: !!onboardingComplete,
    };
    if (result.integrations?.navidrome) {
      delete result.integrations.navidrome.m3uPathMode;
      delete result.integrations.navidrome.pathMappings;
    }
    settingsCache = result;
    return result;
  },

  async updateSettings(settings) {
    assertLoaded();
    const writes = new Map();
    const deletes = new Set();
    const put = (key, value) => {
      writes.set(key, value);
      deletes.delete(key);
    };

    if (settings.integrations) {
      const encKey = getEncryptionKey();
      const existingIntegrations =
        decryptIntegrations(dbHelpers.parseJSON(readRow("integrations")), encKey) || {};
      const nextIntegrations = { ...settings.integrations };
      if (existingIntegrations.soulseek && nextIntegrations.soulseek === undefined) {
        nextIntegrations.soulseek = existingIntegrations.soulseek;
      }
      if (nextIntegrations.navidrome) {
        nextIntegrations.navidrome = { ...nextIntegrations.navidrome };
        delete nextIntegrations.navidrome.m3uPathMode;
        delete nextIntegrations.navidrome.pathMappings;
      }
      put("integrations", dbHelpers.stringifyJSON(encryptIntegrations(nextIntegrations, encKey)));
    }
    if (settings.quality) put("quality", settings.quality);
    if (settings.dateTimeFormat !== undefined) {
      put("dateTimeFormat", normalizeDateTimeFormat(settings.dateTimeFormat));
    }
    if (settings.qualityProfile !== undefined) {
      put(
        "qualityProfile",
        dbHelpers.stringifyJSON(
          normalizeQualityProfile(settings.qualityProfile, settings.integrations?.slskd),
        ),
      );
    }
    if (settings.queueCleaner) put("queueCleaner", dbHelpers.stringifyJSON(settings.queueCleaner));
    if (settings.security !== undefined) put("security", dbHelpers.stringifyJSON(settings.security));
    if (settings.inbox !== undefined) {
      put(
        "inbox",
        dbHelpers.stringifyJSON({
          enabled: settings.inbox.enabled !== false,
          releases: settings.inbox.releases !== false,
          shows: settings.inbox.shows !== false,
          news: settings.inbox.news !== false,
          recommendedNews: settings.inbox.recommendedNews === true,
          discoveries: settings.inbox.discoveries !== false,
        }),
      );
    }
    if (settings.rootFolderPath !== undefined && settings.rootFolderPath !== null) {
      put("rootFolderPath", settings.rootFolderPath);
    }
    let downloadFolderSync;
    if (settings.downloadFolderPath !== undefined) {
      const normalized = String(settings.downloadFolderPath || "").trim();
      if (!normalized) {
        deletes.add("downloadFolderPath");
        writes.delete("downloadFolderPath");
        downloadFolderSync = null;
      } else {
        const validation = validateDownloadFolderPath(normalized, undefined, { create: true });
        if (!validation.valid) throw new Error(validation.error);
        put("downloadFolderPath", validation.path);
        downloadFolderSync = validation.path;
      }
    }
    let pathMappingsSync;
    if (settings.pathMappings !== undefined) {
      const normalizedMappings = normalizePathMappings(settings.pathMappings);
      put("pathMappings", dbHelpers.stringifyJSON(normalizedMappings));
      pathMappingsSync = normalizedMappings;
    }
    if (settings.releaseTypes) put("releaseTypes", dbHelpers.stringifyJSON(settings.releaseTypes));
    if (settings.flows !== undefined) put("flows", dbHelpers.stringifyJSON(settings.flows));
    if (settings.sharedPlaylists !== undefined) {
      put("sharedPlaylists", dbHelpers.stringifyJSON(settings.sharedPlaylists));
    }
    if (settings.subsonic !== undefined) {
      put(
        "subsonic",
        dbHelpers.stringifyJSON({ favoriteAutoKeep: settings.subsonic.favoriteAutoKeep !== false }),
      );
    }
    if (settings.playlistWorker !== undefined) {
      put(
        "playlistWorker",
        dbHelpers.stringifyJSON(normalizePlaylistWorkerSettings(settings.playlistWorker)),
      );
    }
    if (settings.playlistArtwork !== undefined) {
      put(
        "playlistArtwork",
        dbHelpers.stringifyJSON(normalizePlaylistArtworkSettings(settings.playlistArtwork)),
      );
    }
    if (settings.blocklist !== undefined) put("blocklist", dbHelpers.stringifyJSON(settings.blocklist));
    if (settings.onboardingComplete !== undefined) {
      put("onboardingComplete", settings.onboardingComplete ? "true" : "false");
    }

    await db.transaction(async () => {
      for (const [key, value] of writes) await db.run(UPSERT_SETTING_SQL, [key, value]);
      for (const key of deletes) await db.run("DELETE FROM settings WHERE key = ?", [key]);
    });
    for (const [key, value] of writes) settingsRows.set(key, value);
    for (const key of deletes) settingsRows.delete(key);
    settingsCache = null;
    if (downloadFolderSync !== undefined) syncDownloadFolderPath(downloadFolderSync);
    if (pathMappingsSync !== undefined) syncPathMappings(pathMappingsSync);
  },
};

export function getSettingsEncryptionKey() {
  return getEncryptionKey();
}
