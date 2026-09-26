import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { userOps } from "../../db/helpers/index.js";
import { logger } from "../logger.js";
import { PlexClient } from "../plex.js";
import { plexConnectionStore } from "../plex/plexConnectionStore.js";
import { plexPlaylistPointerStore } from "../plex/plexPlaylistPointerStore.js";
import { isPlaybackRetainedFile } from "./playbackFileRetention.js";
import { getPathMappings, resolveLocalPath } from "../pathMappings.js";
import {
  AURRAL_FLOWS_DIR,
  isPathInsideRoot,
  resolvePlaylistRoot,
} from "../playlistPaths.js";
import {
  createPlaybackPlaylistIdentity,
  createPlaybackPlaylistSnapshot,
  playbackOperationFailure,
  playbackOperationSuccess,
} from "./playbackDestination.js";

const SYNC_SKIPPED = Symbol("plex-sync-skipped");

export const plexSettings = Object.freeze({
  key: "plex",
  label: "Plex",
  subtitle: "Plexamp",
  customUi: "plex",
  fields: Object.freeze([
    Object.freeze({ key: "url", label: "Server URL", type: "url", required: true }),
    Object.freeze({ key: "token", label: "Account token", type: "password", secret: true, hidden: true }),
  ]),
  defaults: Object.freeze({ url: "", token: "" }),
  validation: Object.freeze({ required: ["url"], url: ["url"] }),
  testConnection: true,
});

export class PlexPlaybackDestination {
  constructor(weeklyFlowRoot = resolvePlaylistRoot(), { client = null } = {}) {
    this.key = "plex";
    this.name = "Plex";
    this.weeklyFlowRoot = resolvePlaylistRoot(weeklyFlowRoot);
    this.playlistLibraryRoot = this.weeklyFlowRoot;
    this.client = client;
    this._configKey = "";
    this._downloadsPath = "";
    this._mainLibrarySectionId = "";
    this._configuredByUserId = null;
    this._sectionId = null;
    this._libraryTracks = null;
    this._mainLibraryTracks = null;
    this._syncHashes = new Map();
    // Snapshots whose files Plex has not indexed yet; republished after a scan.
    this._pendingSnapshots = new Map();
    this._catchupRunning = false;
    this._catchupPromise = null;
  }

  updateConfig(config = {}) {
    const key = JSON.stringify({
      url: config.url || "",
      token: config.token || "",
      clientId: config.clientId || "",
      downloadsPath: config.downloadsPath || "",
      mainLibrarySectionId: config.mainLibrarySectionId || "",
      configuredByUserId: config.configuredByUserId ?? null,
    });
    if (key === this._configKey) return;
    this._configKey = key;
    this._downloadsPath = config.downloadsPath || "";
    this._mainLibrarySectionId = String(config.mainLibrarySectionId || "").trim();
    this._configuredByUserId =
      config.configuredByUserId != null ? Number(config.configuredByUserId) : null;
    this.client = config.url && config.token
      ? new PlexClient(config.url, config.token, config.clientId)
      : null;
    this._sectionId = null;
    this._libraryTracks = null;
    this._mainLibraryTracks = null;
    this._syncHashes.clear();
    this._pendingSnapshots.clear();
  }

  setWeeklyFlowRoot(weeklyFlowRoot) {
    const root = resolvePlaylistRoot(weeklyFlowRoot);
    if (root === this.weeklyFlowRoot) return;
    this.weeklyFlowRoot = root;
    this.playlistLibraryRoot = root;
    // The Plex library location derives from the root; force re-reconcile.
    this._sectionId = null;
    this._libraryTracks = null;
    this._mainLibraryTracks = null;
    this._syncHashes.clear();
    this._pendingSnapshots.clear();
  }

  isConfigured() {
    return Boolean(this.client?.isConfigured());
  }

  // Every file referenced by an audio playlist the server owner or a linked
  // Aurral user can see, except the playlists published for excludeEntityIds.
  // Any account whose playlists cannot be read makes the whole answer unknown.
  async getReferencedPaths({ excludeEntityIds = [] } = {}) {
    const excluded = new Set();
    for (const entityId of excludeEntityIds) {
      for (const pointer of await plexPlaylistPointerStore.getPointersForEntity(entityId)) {
        if (pointer.ratingKey != null) excluded.add(String(pointer.ratingKey));
      }
    }
    const cache = new Map();
    const owners = [null, ...(await userOps.getAllUsers()).map((user) => user.id)];
    const readTokens = new Set();
    const mappings = getPathMappings("plex");
    const paths = new Set();
    for (const ownerUserId of owners) {
      const client = await this._ownerClient(ownerUserId, cache);
      if (!client || readTokens.has(client.token)) continue;
      readTokens.add(client.token);
      const files = await this._withOwnerClient(ownerUserId, cache, (ownerClient) =>
        ownerClient.getPlaylistTrackPaths(excluded));
      if (files === SYNC_SKIPPED) {
        throw new Error(`Plex playlists for user ${ownerUserId} could not be read; the Plex link needs reconnecting`);
      }
      for (const file of files) {
        const relative = this._relativeManagedPath(file);
        paths.add(relative == null
          ? path.resolve(resolveLocalPath(file, mappings))
          : path.resolve(this.weeklyFlowRoot, relative));
      }
    }
    return { ok: true, paths: [...paths] };
  }

  _libraryPath() {
    const override = String(this._downloadsPath || "").trim();
    return (override || this.weeklyFlowRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  }

  async testConnection() {
    if (!this.isConfigured()) {
      return playbackOperationFailure({
        code: "DESTINATION_NOT_CONFIGURED",
        message: "Plex is not configured",
      });
    }
    try {
      await this.client.ping();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "DESTINATION_UNAVAILABLE",
        message: error?.message || "Plex did not respond",
        retryable: true,
      });
    }
  }

  async ensureLibrary() {
    if (!this.isConfigured()) return playbackOperationSuccess();
    try {
      if (this._sectionId == null) {
        this._sectionId = (await this.client.ensureWeeklyFlowLibrary(this._libraryPath()))?.key ?? null;
      }
      if (this._sectionId == null) throw new Error("Could not create or find the Aurral Plex library");
      await this._loadTracks();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "LIBRARY_SETUP_FAILED",
        message: error?.message || "Could not prepare the Plex library",
        retryable: true,
      });
    }
  }

  async _loadTracks() {
    this._libraryTracks = await this.client.getTracks(this._sectionId);
    this._mainLibraryTracks = null;
    if (!this._mainLibrarySectionId) return;
    try {
      this._mainLibraryTracks = await this.client.getTracks(this._mainLibrarySectionId);
    } catch (error) {
      console.warn(
        "[PlexPlaybackDestination] Failed to read configured main Plex library section:",
        error?.message,
      );
      this._mainLibraryTracks = [];
    }
  }

  async _ownerClient(ownerUserId, cache) {
    if (ownerUserId == null) return this.client;
    const key = String(ownerUserId);
    if (cache.has(key)) return cache.get(key);
    const connection = await plexConnectionStore.getConnection(ownerUserId);
    if (!connection) {
      cache.set(key, this.client);
      return this.client;
    }
    if (!this.client) {
      cache.set(key, null);
      return null;
    }
    const client = new PlexClient(this.client.url, connection.token, connection.clientId);
    client._machineIdentifier = this.client._machineIdentifier || null;
    cache.set(key, client);
    return client;
  }

  async _recoverOwnerToken(ownerUserId) {
    const connection = await plexConnectionStore.getConnection(ownerUserId);
    if (!connection || !this.isConfigured()) return null;
    try {
      let freshToken;
      if (connection.linkType === "managed") {
        if (connection.plexAccountId == null) return null;
        freshToken = await PlexClient.switchHomeUser(
          connection.plexAccountId,
          this.client.token,
          this.client.clientId,
          connection.clientId,
        );
      } else {
        // Self links: Plex rotates server-scoped tokens; re-derive from the account token.
        if (!connection.accountToken) return null;
        freshToken = connection.accountToken;
      }
      if (!freshToken) throw new Error("Plex did not return a refreshed token");
      let serverToken = freshToken;
      try {
        const machineIdentifier = await this.client.getMachineIdentifier();
        const { servers } = await PlexClient.getResources(freshToken, connection.clientId);
        const match = (servers || []).find(
          (server) => server.clientIdentifier === machineIdentifier,
        );
        if (match?.accessToken) serverToken = match.accessToken;
      } catch {}
      if (serverToken === connection.token) {
        throw new Error("Plex returned the same rejected token");
      }
      await plexConnectionStore.updateToken(ownerUserId, {
        token: serverToken,
        clientId: connection.clientId,
      });
      const client = new PlexClient(this.client.url, serverToken, connection.clientId);
      client._machineIdentifier = this.client._machineIdentifier || null;
      return client;
    } catch (error) {
      await plexConnectionStore.setLastError(ownerUserId, error?.message || "Plex reconnect failed");
      return null;
    }
  }

  async _withOwnerClient(ownerUserId, cache, run) {
    const client = await this._ownerClient(ownerUserId, cache);
    try {
      return await run(client);
    } catch (error) {
      if (error?.response?.status !== 401 || client === this.client || ownerUserId == null) {
        throw error;
      }
      const recovered = await this._recoverOwnerToken(ownerUserId);
      if (recovered) {
        cache.set(String(ownerUserId), recovered);
        try {
          return await run(recovered);
        } catch (retryError) {
          await plexConnectionStore.setLastError(
            ownerUserId,
            retryError?.message || "Plex sync failed after reconnect",
          );
          console.warn(
            `[PlexPlaybackDestination] Plex sync skipped for owner ${ownerUserId}: still failing after reconnect`,
          );
          return SYNC_SKIPPED;
        }
      }
      await plexConnectionStore.setLastError(ownerUserId, error?.message || "Plex sync failed (401)");
      console.warn(
        `[PlexPlaybackDestination] Plex sync skipped for owner ${ownerUserId}: reconnect needed`,
      );
      return SYNC_SKIPPED;
    }
  }

  async _ownerUser(ownerUserId, cache) {
    const key = String(ownerUserId);
    if (!cache.has(key)) cache.set(key, await userOps.getUserById(ownerUserId));
    return cache.get(key);
  }

  _ownsGlobalFallback(ownerUserId, owner) {
    if (this._configuredByUserId != null) {
      return Number(ownerUserId) === this._configuredByUserId;
    }
    return !owner || owner.role === "admin";
  }

  async _isOwnerBlocked(ownerUserId, clientCache, userCache = new Map()) {
    if (ownerUserId == null) return false;
    if ((await this._ownerClient(ownerUserId, clientCache)) !== this.client) return false;
    if (this._configuredByUserId != null) {
      return Number(ownerUserId) !== this._configuredByUserId;
    }
    const owner = await this._ownerUser(ownerUserId, userCache);
    return Boolean(owner) && owner.role !== "admin";
  }

  async _title(ownerUserId, desired, clientCache, userCache = new Map()) {
    if (ownerUserId == null) return desired;
    if ((await this._ownerClient(ownerUserId, clientCache)) !== this.client) return desired;
    const owner = await this._ownerUser(ownerUserId, userCache);
    if (this._ownsGlobalFallback(ownerUserId, owner)) return desired;
    return `${desired} (${owner?.username || "unlinked"})`;
  }

  async _location(ownerUserId) {
    if (ownerUserId == null) return "global";
    const connection = await plexConnectionStore.getConnection(ownerUserId);
    if (!connection) return "global";
    return `${connection.linkType}:${connection.plexAccountId ?? connection.plexUuid ?? ownerUserId}`;
  }

  _targetKey(ownerUserId) {
    return String(ownerUserId ?? "global");
  }

  _relativeManagedPath(file) {
    const normalized = String(file || "").replace(/\\/g, "/");
    const root = this._libraryPath();
    const marker = `${root}/`;
    if (!normalized.startsWith(marker)) return null;
    const relative = normalized.slice(marker.length);
    const normalizedRelative = path.posix.normalize(relative);
    if (
      !normalizedRelative ||
      normalizedRelative === "." ||
      normalizedRelative === ".." ||
      normalizedRelative.startsWith("../") ||
      path.posix.isAbsolute(normalizedRelative)
    ) {
      return null;
    }
    return normalizedRelative;
  }

  async _resolveRatingKeys(snapshot) {
    return (await this._resolvePlaylist(snapshot)).ratingKeys;
  }

  async _resolvePlaylist(snapshot) {
    const managedByPath = new Map();
    for (const track of this._libraryTracks || []) {
      for (const file of track.files || []) {
        const relative = this._relativeManagedPath(file);
        if (!relative) continue;
        const localPath = path.resolve(this.weeklyFlowRoot, relative);
        if (!managedByPath.has(localPath)) managedByPath.set(localPath, []);
        managedByPath.get(localPath).push(track);
      }
    }
    const mainByPath = new Map();
    const mappings = getPathMappings("plex");
    for (const track of this._mainLibraryTracks || []) {
      if (!track.ratingKey) continue;
      for (const file of track.files || []) {
        const localPath = path.resolve(resolveLocalPath(file, mappings));
        if (!mainByPath.has(localPath)) mainByPath.set(localPath, track.ratingKey);
      }
    }
    const keys = [];
    let unresolved = 0;
    for (const track of snapshot.tracks) {
      const localPath = path.resolve(track.path);
      const ratingKey = managedByPath.get(localPath)?.[0]?.ratingKey || mainByPath.get(localPath);
      if (ratingKey) keys.push(ratingKey);
      else unresolved += 1;
    }
    const entityRoot = path.join(this.weeklyFlowRoot, AURRAL_FLOWS_DIR, snapshot.entityId);
    for (const [localPath, group] of managedByPath) {
      if (!isPathInsideRoot(localPath, entityRoot)) continue;
      if (isPlaybackRetainedFile(localPath)) continue;
      try {
        await fs.access(localPath);
      } catch {
        continue;
      }
      const ratingKey = group[0]?.ratingKey;
      if (ratingKey) keys.push(ratingKey);
    }
    return { ratingKeys: [...new Set(keys.map(String))], unresolved };
  }

  _hash(snapshot, ratingKeys, title) {
    const keys = [...ratingKeys].sort().join(",");
    return crypto
      .createHash("sha256")
      .update(`${snapshot.entityId}|${snapshot.ownerUserId ?? "global"}|${title}|${keys}|${snapshot.description || ""}`)
      .digest("hex");
  }

  async _cleanupRelocatedPointer(pointer) {
    if (pointer.location !== "global") return;
    if (!this.client) return;
    try {
      await this.client.deletePlaylist(pointer.ratingKey);
    } catch (error) {
      if (error?.response?.status !== 404) {
        console.warn("[PlexPlaybackDestination] Failed to clean up relocated playlist:", error?.message);
      }
    }
  }

  async _deletePointer(entityId, ownerUserId, pointer, clientCache) {
    const targetKey = this._targetKey(ownerUserId);
    const client = pointer.location === "global"
      ? this.client
      : await this._ownerClient(ownerUserId, clientCache);
    if (client === this.client && pointer.location !== "global") {
      await plexPlaylistPointerStore.deletePointer(entityId, targetKey);
      return;
    }
    try {
      await client?.deletePlaylist(pointer.ratingKey);
    } catch (error) {
      if (error?.response?.status !== 404) {
        console.warn("[PlexPlaybackDestination] Failed to delete playlist:", error?.message);
      }
    }
    await plexPlaylistPointerStore.deletePointer(entityId, targetKey);
  }

  async _deleteCurrent(identity, clientCache = new Map()) {
    const targetKey = this._targetKey(identity.ownerUserId);
    this._pendingSnapshots.delete(`${identity.entityId}:${targetKey}`);
    const pointer = await plexPlaylistPointerStore.getPointer(identity.entityId, targetKey);
    if (!pointer) return;
    const location = await this._location(identity.ownerUserId);
    if (pointer.location === location) {
      await this._withOwnerClient(identity.ownerUserId, clientCache, async (client) => {
        if (!client) return;
        try {
          await client.deletePlaylist(pointer.ratingKey);
        } catch (error) {
          if (error?.response?.status !== 404) throw error;
        }
      });
    } else {
      await this._cleanupRelocatedPointer(pointer);
    }
    await plexPlaylistPointerStore.deletePointer(identity.entityId, targetKey);
    this._syncHashes.delete(`${identity.entityId}:${targetKey}`);
  }

  async publishPlaylist(value) {
    try {
      const snapshot = createPlaybackPlaylistSnapshot(value);
      if (!this.isConfigured()) return playbackOperationSuccess();
      if (this._libraryTracks == null) {
        const ensured = await this.ensureLibrary();
        if (!ensured.ok) return ensured;
      }
      const targetKey = this._targetKey(snapshot.ownerUserId);
      const cacheKey = `${snapshot.entityId}:${targetKey}`;
      if (!this._libraryTracks.length) {
        // Empty after weekly reset trash or fresh library; retry post-scan.
        if (snapshot.tracks.length) {
          this._pendingSnapshots.set(cacheKey, snapshot);
          logger.info(
            "plex",
            `Plex playlist "${snapshot.displayName}" deferred: Aurral library has no indexed tracks yet (${snapshot.tracks.length} local)`,
          );
        }
        return playbackOperationSuccess();
      }
      const clientCache = new Map();
      const userCache = new Map();
      if (await this._isOwnerBlocked(snapshot.ownerUserId, clientCache, userCache)) {
        await this._deleteCurrent(snapshot, clientCache);
        return playbackOperationSuccess();
      }
      const title = await this._title(
        snapshot.ownerUserId,
        snapshot.displayName.trim(),
        clientCache,
        userCache,
      );
      const { ratingKeys, unresolved } = await this._resolvePlaylist(snapshot);
      if (!ratingKeys.length) {
        if (snapshot.tracks.length) {
          // Deleting here would drop a playlist Plex merely hasn't scanned yet.
          this._pendingSnapshots.set(cacheKey, snapshot);
          logger.info(
            "plex",
            `Plex playlist "${title}" deferred: none of ${snapshot.tracks.length} local track(s) found in Plex yet`,
          );
          return playbackOperationSuccess();
        }
        await this._deleteCurrent(snapshot, clientCache);
        return playbackOperationSuccess();
      }
      if (unresolved > 0) this._pendingSnapshots.set(cacheKey, snapshot);
      else this._pendingSnapshots.delete(cacheKey);
      const hash = this._hash(snapshot, ratingKeys, title);
      if (this._syncHashes.get(cacheKey) === hash) return playbackOperationSuccess();
      logger.info(
        "plex",
        `Plex playlist "${title}": syncing ${ratingKeys.length} track(s), ${unresolved} not indexed yet`,
      );
      const location = await this._location(snapshot.ownerUserId);
      const pointer = await plexPlaylistPointerStore.getPointer(snapshot.entityId, targetKey);
      if (pointer && pointer.location !== location) await this._cleanupRelocatedPointer(pointer);
      const reusable = pointer?.location === location ? pointer : null;
      const result = await this._withOwnerClient(snapshot.ownerUserId, clientCache, (client) =>
        client.syncPlaylist({
          ratingKey: reusable?.ratingKey ?? null,
          previousTitle: reusable?.title ?? null,
          previousDescription: reusable?.description ?? null,
          title,
          description: snapshot.description || null,
          ratingKeys,
        }),
      );
      if (result === SYNC_SKIPPED) return playbackOperationSuccess();
      if (result?.ratingKey) {
        await plexPlaylistPointerStore.setPointer(snapshot.entityId, targetKey, {
          location,
          ratingKey: result.ratingKey,
          title,
          description: snapshot.description || null,
        });
      } else {
        await plexPlaylistPointerStore.deletePointer(snapshot.entityId, targetKey);
      }
      this._syncHashes.set(cacheKey, hash);
      return playbackOperationSuccess();
    } catch (error) {
      logger.warn("plex", `Plex playlist publish failed: ${error?.message || error}`);
      return playbackOperationFailure({
        code: "PLAYLIST_PUBLISH_FAILED",
        message: error?.message || "Could not publish the Plex playlist",
        retryable: true,
      });
    }
  }

  async deletePlaylist(value) {
    try {
      await this._deleteCurrent(createPlaybackPlaylistIdentity(value));
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "PLAYLIST_DELETE_FAILED",
        message: error?.message || "Could not delete the Plex playlist",
        retryable: true,
      });
    }
  }

  // `connection` overrides the stored one, e.g. the previous Plex account's
  // token after a relink replaced it.
  async deleteOwnerPlaylists(ownerUserId, connection = null) {
    const targetKey = this._targetKey(ownerUserId);
    const clientCache = new Map();
    if (connection && this.client) {
      const client = new PlexClient(this.client.url, connection.token, connection.clientId);
      client._machineIdentifier = this.client._machineIdentifier || null;
      clientCache.set(String(ownerUserId), client);
    }
    for (const pointer of await plexPlaylistPointerStore.getPointersForTarget(targetKey)) {
      await this._deletePointer(pointer.entityId, ownerUserId, pointer, clientCache);
    }
  }

  async deleteEntityPlaylists(entityId) {
    const clientCache = new Map();
    for (const pointer of await plexPlaylistPointerStore.getPointersForEntity(entityId)) {
      const ownerUserId = pointer.targetKey === "global" ? null : Number(pointer.targetKey);
      await this._deletePointer(entityId, ownerUserId, pointer, clientCache);
    }
  }

  async requestScan() {
    if (!this.isConfigured()) return playbackOperationSuccess();
    try {
      const ensured = await this.ensureLibrary();
      if (!ensured.ok) return ensured;
      await this.client.scanLibrary(this._sectionId);
      // Plex scans asynchronously; tracks loaded above predate the scan.
      this._scheduleCatchup();
      return playbackOperationSuccess();
    } catch (error) {
      return playbackOperationFailure({
        code: "SCAN_FAILED",
        message: error?.message || "Could not scan the Plex library",
        retryable: true,
      });
    }
  }

  async syncNow(snapshots, loadSnapshots) {
    if (!this.isConfigured()) return { configured: false };
    const startedAt = Date.now();
    // ensureLibrary() reads both sections; re-reading doubled the slowest step.
    const ensured = await this.ensureLibrary();
    if (!ensured.ok) throw new Error(ensured.error.message);
    await this.client.scanLibrary(this._sectionId);
    this._syncHashes.clear();
    logger.info(
      "plex",
      `Plex sync started: ${this._libraryTracks.length} track(s) indexed in the Aurral library, ${(this._mainLibraryTracks || []).length} in the main library, ${snapshots.length} playlist(s)`,
    );
    for (const snapshot of snapshots) {
      const result = await this.publishPlaylist(snapshot);
      if (!result.ok) throw new Error(result.error.message);
    }
    const playlists = await this.client.getPlaylists();
    logger.info(
      "plex",
      `Plex sync completed in ${Math.round((Date.now() - startedAt) / 1000)}s; ${this._pendingSnapshots.size} playlist(s) waiting on the scan`,
    );
    const clientCache = new Map();
    const userCache = new Map();
    const managedNames = new Set();
    for (const snapshot of snapshots) {
      if (await this._isOwnerBlocked(snapshot.ownerUserId, clientCache, userCache)) continue;
      managedNames.add(
        await this._title(snapshot.ownerUserId, snapshot.displayName, clientCache, userCache),
      );
    }
    this._scheduleCatchup(loadSnapshots);
    return {
      configured: true,
      sectionId: this._sectionId,
      indexedTracks: this._libraryTracks.length,
      scanInProgress: this._libraryTracks.length === 0,
      playlists: playlists
        .filter((playlist) => managedNames.has(playlist.title))
        .map((playlist) => ({ title: playlist.title, count: playlist.leafCount ?? null })),
    };
  }

  _scheduleCatchup(loadSnapshots = null, delaysMs = [30000, 90000, 180000]) {
    if (this._catchupRunning) return;
    if (typeof loadSnapshots !== "function" && !this._pendingSnapshots.size) return;
    this._catchupRunning = true;
    const run = async () => {
      try {
        for (const delay of delaysMs) {
          await wait(delay, undefined, { ref: false });
          if (!this.isConfigured()) break;
          const snapshots =
            typeof loadSnapshots === "function"
              ? await loadSnapshots()
              : [...this._pendingSnapshots.values()];
          if (!snapshots.length) break;
          await this._loadTracks();
          for (const snapshot of snapshots) {
            const key = `${snapshot.entityId}:${this._targetKey(snapshot.ownerUserId)}`;
            // Hash can match while Plex emptied the playlist; force real diff.
            this._syncHashes.delete(key);
            await this.publishPlaylist(snapshot);
          }
        }
      } catch (error) {
        console.warn("[PlexPlaybackDestination] Plex catch-up failed:", error?.message);
      } finally {
        this._catchupRunning = false;
      }
    };
    this._catchupPromise = run();
    return this._catchupPromise;
  }
}
