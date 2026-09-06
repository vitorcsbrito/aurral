import { AsyncLocalStorage } from "node:async_hooks";
import { db, dbHelpers } from "../config/database.js";
import { invalidateCanonicalLibraryCache } from "./libraryQueryService.js";
import {
  findLibrarySearchDocumentGaps,
  libraryAlbumTrackIds,
  libraryArtistAlbumIds,
  removeLibrarySearchDocument,
  syncLibrarySearchAlbum,
  syncLibrarySearchArtist,
  syncLibrarySearchArtistDocument,
  syncLibrarySearchTrack,
} from "./librarySearchIndex.js";

const now = () => Date.now();

const stringify = (value) => dbHelpers.stringifyJSON(value) || null;

const normalizeText = (value) => String(value || "").trim();

const normalizeKeyPart = (value) =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const LIDARR_METADATA_KEYS = [
  "librarySource",
  "id",
  "monitored",
  "monitor",
  "monitorNewItems",
  "addOptions",
  "path",
  "qualityProfile",
  "rootFolderPath",
  "statistics",
];

let libraryScanDepth = 0;
let libraryCacheInvalidationPending = false;
const libraryScanContext = new AsyncLocalStorage();
const SEARCH_SYNC_BATCH_SIZE = 500;
const WRITE_YIELD_MS = 10;
// Between write batches, so request handling gets the event loop back.
export const yieldWriteLock = () => new Promise((resolve) => setTimeout(resolve, WRITE_YIELD_MS));

const invalidateLibraryCache = async () => {
  const scan = libraryScanContext.getStore();
  if (scan) {
    scan.changed = true;
    libraryCacheInvalidationPending = true;
    return;
  }
  await invalidateCanonicalLibraryCache();
};

const createSearchSyncSet = () => ({ artist: new Set(), album: new Set(), track: new Set() });

// Scans defer document syncs into end-of-scan batches.
const deferSearchSync = (kind, id) => {
  const scan = libraryScanContext.getStore();
  if (scan && Number.isSafeInteger(Number(id))) scan.search[kind].add(Number(id));
};

const syncSearchArtist = async (artistId, syncSearch) => {
  if (syncSearch) await syncLibrarySearchArtist(artistId);
  else deferSearchSync("artist", artistId);
};

const syncSearchAlbumTracks = async (albumId) => {
  const tracks = await db.all("SELECT track_id FROM library_album_tracks WHERE album_id = ?", [
    Number(albumId),
  ]);
  for (const track of tracks) await syncLibrarySearchTrack(track.track_id);
};

const syncSearchAlbum = async (albumId, syncSearch) => {
  if (!syncSearch) {
    deferSearchSync("album", albumId);
    return;
  }
  if (await syncLibrarySearchAlbum(albumId)) await syncSearchAlbumTracks(albumId);
};

const syncSearchTrack = async (trackId, syncSearch) => {
  if (syncSearch) await syncLibrarySearchTrack(trackId);
  else deferSearchSync("track", trackId);
};

const mergeSearchSyncSets = (target, source) => {
  for (const kind of ["artist", "album", "track"]) {
    for (const id of source[kind]) target[kind].add(id);
  }
};

// Artist and album cascades are deferred to the next phase, so no
// transaction exceeds SEARCH_SYNC_BATCH_SIZE documents.
export async function syncLibrarySearchEntities(search) {
  const albumIds = new Set(search.album);
  const trackIds = new Set(search.track);
  let synced = 0;
  const runBatches = async (ids, run) => {
    const list = [...ids];
    for (let index = 0; index < list.length; index += SEARCH_SYNC_BATCH_SIZE) {
      const batch = list.slice(index, index + SEARCH_SYNC_BATCH_SIZE);
      await db.transaction(async () => {
        for (const id of batch) await run(id);
      });
      synced += batch.length;
      await yieldWriteLock();
    }
  };
  await runBatches(search.artist, async (id) => {
    if (!(await syncLibrarySearchArtistDocument(id))) return;
    for (const albumId of await libraryArtistAlbumIds(id)) albumIds.add(albumId);
  });
  await runBatches(albumIds, async (id) => {
    if (!(await syncLibrarySearchAlbum(id))) return;
    for (const trackId of await libraryAlbumTrackIds(id)) trackIds.add(trackId);
  });
  await runBatches(trackIds, (id) => syncLibrarySearchTrack(id));
  return synced;
}

export function buildIdentityKey(prefix, value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return `${prefix}:${normalized}`;
}

export function buildFallbackIdentityKey(...parts) {
  const normalized = parts.map(normalizeKeyPart).filter(Boolean);
  return normalized.length ? `name:${normalized.join(":")}` : null;
}

export async function beginLibraryScan({ source, rootPath = null } = {}) {
  const row = await db.get(
    `INSERT INTO library_scan_runs (source, root_path, status, started_at)
     VALUES (?, ?, 'running', ?)
     RETURNING id`,
    [normalizeText(source), rootPath ? normalizeText(rootPath) : null, now()],
  );
  return Number(row.id);
}

// Scans are serialized, so a still-running run means a dead worker.
export async function failInterruptedLibraryScans() {
  const result = await db.run(
    `UPDATE library_scan_runs
     SET status = 'failed', completed_at = ?, error = 'interrupted'
     WHERE status = 'running'`,
    [now()],
  );
  return result.changes;
}

export async function finishLibraryScan(scanId, {
  status = "complete",
  error = null,
  filesSeen = 0,
  filesIndexed = 0,
  filesFailed = 0,
} = {}) {
  await db.run(
    `UPDATE library_scan_runs
     SET status = ?, completed_at = ?, error = ?, files_seen = ?, files_indexed = ?, files_failed = ?
     WHERE id = ?`,
    [
      status,
      now(),
      error ? String(error) : null,
      Number(filesSeen) || 0,
      Number(filesIndexed) || 0,
      Number(filesFailed) || 0,
      scanId,
    ],
  );
}

export async function upsertLibraryArtist({
  identityKey,
  mbid = null,
  name,
  sortName = null,
  metadata = null,
  syncSearch = true,
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const artistName = normalizeText(name);
  const artistMbid = mbid || null;
  const artistSortName = sortName || null;
  const metadataText = stringify(metadata);
  if (!key || !artistName) throw new Error("Library artist identityKey and name are required");
  let libraryChanged = false;
  const artist = await db.transaction(async () => {
    const fallbackKey = buildFallbackIdentityKey("artist", artistName);
    const findFallbackArtist = () =>
      db.get(
        "SELECT id, identity_key FROM library_artists WHERE identity_key = ? AND mbid IS NULL",
        [fallbackKey],
      );
    const findResolvedArtist = async () => {
      const exact = await db.all(
        `SELECT * FROM library_artists
         WHERE mbid IS NOT NULL AND lower(name) = lower(?)
         ORDER BY id
         LIMIT 2`,
        [artistName],
      );
      if (exact.length === 1) return exact[0];
      // ponytail: full artist scan; persist a normalized name if hot.
      const matches = (await db.all("SELECT * FROM library_artists WHERE mbid IS NOT NULL"))
        .filter((row) => buildFallbackIdentityKey("artist", row.name) === fallbackKey);
      return matches.length === 1 ? matches[0] : null;
    };
    const moveArtistStars = async (fromKey, toKey) => {
      const copied = await db.run(
        `INSERT INTO subsonic_stars (user_id, entity_kind, entity_key, created_at)
         SELECT user_id, entity_kind, ?, created_at
         FROM subsonic_stars
         WHERE entity_kind = 'artist' AND entity_key = ?
         ON CONFLICT DO NOTHING`,
        [toKey, fromKey],
      );
      const removed = await db.run(
        "DELETE FROM subsonic_stars WHERE entity_kind = 'artist' AND entity_key = ?",
        [fromKey],
      );
      return copied.changes > 0 || removed.changes > 0;
    };
    const mergeFallbackArtist = async (fallback, resolved) => {
      if (!fallback || !resolved || fallback.id === resolved.id) return;
      libraryChanged =
        (await moveArtistStars(fallback.identity_key, resolved.identity_key)) || libraryChanged;
      const movedAlbumIds = (
        await db.all("SELECT id FROM library_albums WHERE artist_id = ?", [fallback.id])
      ).map((row) => row.id);
      libraryChanged =
        (await db.run("UPDATE library_albums SET artist_id = ? WHERE artist_id = ?", [
          resolved.id,
          fallback.id,
        ])).changes > 0 || libraryChanged;
      libraryChanged =
        (await db.run("DELETE FROM library_artists WHERE id = ?", [fallback.id])).changes > 0 ||
        libraryChanged;
      await removeLibrarySearchDocument("artist", fallback.id);
      for (const albumId of movedAlbumIds) await syncSearchAlbum(albumId, syncSearch);
    };
    if (mbid) {
      const resolved = await db.get(
        "SELECT id, identity_key FROM library_artists WHERE identity_key = ?",
        [key],
      );
      const fallback = fallbackKey === key ? null : await findFallbackArtist();
      if (fallback && !resolved) {
        libraryChanged = (await moveArtistStars(fallback.identity_key, key)) || libraryChanged;
        libraryChanged =
          (await db.run("UPDATE library_artists SET identity_key = ? WHERE id = ?", [
            key,
            fallback.id,
          ])).changes > 0 || libraryChanged;
      } else if (fallback && resolved && fallback.id !== resolved.id) {
        await mergeFallbackArtist(fallback, resolved);
      }
    } else if (key === fallbackKey) {
      const resolved = await findResolvedArtist();
      if (resolved) {
        await mergeFallbackArtist(await findFallbackArtist(), resolved);
        await syncSearchArtist(resolved.id, syncSearch);
        return resolved;
      }
    }
    const existing = await db.get("SELECT * FROM library_artists WHERE identity_key = ?", [key]);
    if (
      existing &&
      (artistMbid == null || artistMbid === existing.mbid) &&
      artistName === existing.name &&
      (artistSortName == null || artistSortName === existing.sort_name) &&
      (metadataText == null || metadataText === existing.metadata_json)
    ) {
      if (syncSearch) await syncLibrarySearchArtist(existing.id);
      return existing;
    }
    const row = await db.get(
      `INSERT INTO library_artists (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_artists.mbid),
         name = excluded.name,
         sort_name = COALESCE(excluded.sort_name, library_artists.sort_name),
         metadata_json = COALESCE(excluded.metadata_json, library_artists.metadata_json),
         updated_at = excluded.updated_at
       RETURNING *`,
      [key, artistMbid, artistName, artistSortName, metadataText, timestamp, timestamp],
    );
    libraryChanged = true;
    await syncSearchArtist(row?.id, syncSearch);
    return row;
  });
  if (libraryChanged) await invalidateLibraryCache();
  return artist;
}

async function clearLidarrMetadata(table, where, parameters) {
  const row = await db.get(
    `SELECT id, metadata_json FROM ${table} WHERE ${where} LIMIT 1`,
    parameters,
  );
  if (!row) return false;
  let metadata = {};
  try {
    const parsed = JSON.parse(row.metadata_json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {}
  for (const key of LIDARR_METADATA_KEYS) delete metadata[key];
  await db.run(`UPDATE ${table} SET metadata_json = ?, updated_at = ? WHERE id = ?`, [
    stringify(metadata),
    now(),
    row.id,
  ]);
  await invalidateLibraryCache();
  return true;
}

export async function clearCanonicalLidarrArtist(reference) {
  const value = normalizeText(reference);
  if (!value) return false;
  return clearLidarrMetadata(
    "library_artists",
    "mbid = ? OR identity_key = ? OR aurral_json(metadata_json) ->> 'foreignArtistId' = ?",
    [value, value, value],
  );
}

export async function clearCanonicalLidarrAlbum(reference) {
  const value = normalizeText(reference);
  if (!value) return false;
  return clearLidarrMetadata(
    "library_albums",
    `mbid = ? OR release_group_mbid = ? OR identity_key = ?
     OR aurral_json(metadata_json) ->> 'id' = ?`,
    [value, value, value, value],
  );
}

export async function upsertLibraryAlbum({
  identityKey,
  mbid = null,
  releaseGroupMbid = null,
  artistId,
  title,
  albumArtist = null,
  releaseDate = null,
  metadata = null,
  syncSearch = true,
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const albumTitle = normalizeText(title);
  const albumMbid = mbid || null;
  const albumReleaseGroupMbid = releaseGroupMbid || null;
  const albumArtistName = albumArtist || null;
  const albumReleaseDate = releaseDate || null;
  const metadataText = stringify(metadata);
  if (!key || !Number.isSafeInteger(Number(artistId)) || !albumTitle) {
    throw new Error("Library album identityKey, artistId, and title are required");
  }
  let libraryChanged = false;
  const album = await db.transaction(async () => {
    const existing = await db.get("SELECT * FROM library_albums WHERE identity_key = ?", [key]);
    if (
      existing &&
      (albumMbid == null || albumMbid === existing.mbid) &&
      (albumReleaseGroupMbid == null || albumReleaseGroupMbid === existing.release_group_mbid) &&
      Number(artistId) === existing.artist_id &&
      albumTitle === existing.title &&
      (albumArtistName == null || albumArtistName === existing.album_artist) &&
      (albumReleaseDate == null || albumReleaseDate === existing.release_date) &&
      (metadataText == null || metadataText === existing.metadata_json)
    ) {
      if (syncSearch) await syncSearchAlbum(existing.id, true);
      return existing;
    }
    const row = await db.get(
      `INSERT INTO library_albums
        (identity_key, mbid, release_group_mbid, artist_id, title, album_artist, release_date, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_albums.mbid),
         release_group_mbid = COALESCE(excluded.release_group_mbid, library_albums.release_group_mbid),
         artist_id = excluded.artist_id,
         title = excluded.title,
         album_artist = COALESCE(excluded.album_artist, library_albums.album_artist),
         release_date = COALESCE(excluded.release_date, library_albums.release_date),
         metadata_json = COALESCE(excluded.metadata_json, library_albums.metadata_json),
         updated_at = excluded.updated_at
       RETURNING *`,
      [
        key,
        albumMbid,
        albumReleaseGroupMbid,
        Number(artistId),
        albumTitle,
        albumArtistName,
        albumReleaseDate,
        metadataText,
        timestamp,
        timestamp,
      ],
    );
    libraryChanged = true;
    if (row?.id) await syncSearchAlbum(row.id, syncSearch);
    return row;
  });
  if (libraryChanged) await invalidateLibraryCache();
  return album;
}

export async function upsertLibraryTrack({
  identityKey,
  mbid = null,
  title,
  artistName = null,
  metadata = null,
  syncSearch = true,
}) {
  const timestamp = now();
  const key = normalizeText(identityKey);
  const trackTitle = normalizeText(title);
  const trackMbid = mbid || null;
  const trackArtistName = artistName || null;
  const metadataText = stringify(metadata);
  if (!key || !trackTitle) throw new Error("Library track identityKey and title are required");
  let libraryChanged = false;
  const track = await db.transaction(async () => {
    const existing = await db.get("SELECT * FROM library_tracks WHERE identity_key = ?", [key]);
    if (
      existing &&
      (trackMbid == null || trackMbid === existing.mbid) &&
      trackTitle === existing.title &&
      (trackArtistName == null || trackArtistName === existing.artist_name) &&
      (metadataText == null || metadataText === existing.metadata_json)
    ) {
      if (syncSearch) await syncLibrarySearchTrack(existing.id);
      return existing;
    }
    const row = await db.get(
      `INSERT INTO library_tracks (identity_key, mbid, title, artist_name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity_key) DO UPDATE SET
         mbid = COALESCE(excluded.mbid, library_tracks.mbid),
         title = excluded.title,
         artist_name = COALESCE(excluded.artist_name, library_tracks.artist_name),
         metadata_json = COALESCE(excluded.metadata_json, library_tracks.metadata_json),
         updated_at = excluded.updated_at
       RETURNING *`,
      [key, trackMbid, trackTitle, trackArtistName, metadataText, timestamp, timestamp],
    );
    libraryChanged = true;
    await syncSearchTrack(row?.id, syncSearch);
    return row;
  });
  if (libraryChanged) await invalidateLibraryCache();
  return track;
}

export async function linkLibraryAlbumTrack({
  albumId,
  trackId,
  discNumber = 1,
  trackNumber = 0,
  syncSearch = true,
}) {
  const changed = await db.transaction(async () => {
    const result = await db.run(
      `INSERT INTO library_album_tracks
        (album_id, track_id, disc_number, track_number, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [Number(albumId), Number(trackId), Number(discNumber) || 1, Number(trackNumber) || 0, now()],
    );
    if (syncSearch) await syncLibrarySearchTrack(trackId);
    else if (result.changes > 0) deferSearchSync("track", trackId);
    return result.changes > 0;
  });
  if (changed) await invalidateLibraryCache();
}

export async function removeLibraryTrackIfNoAvailableMedia(trackId) {
  const normalizedTrackId = Number(trackId);
  if (!Number.isSafeInteger(normalizedTrackId)) return false;
  const removed = await db.transaction(async () => {
    const mediaFiles = await db.all(
      "SELECT album_id, available FROM library_media_files WHERE track_id = ?",
      [normalizedTrackId],
    );
    if (!mediaFiles.length || mediaFiles.some((file) => file.available === 1)) return false;

    const linkedAlbums = await db.all(
      "SELECT album_id FROM library_album_tracks WHERE track_id = ?",
      [normalizedTrackId],
    );
    const albumIds = new Set([
      ...linkedAlbums.map((row) => row.album_id),
      ...mediaFiles.map((file) => file.album_id).filter((albumId) => albumId != null),
    ]);
    const artistIds = new Set(
      (
        await db.all("SELECT artist_id FROM library_albums WHERE id = ANY(?::bigint[])", [
          [...albumIds],
        ])
      ).map((row) => row.artist_id),
    );

    await removeLibrarySearchDocument("track", normalizedTrackId);
    await db.run("DELETE FROM library_media_files WHERE track_id = ?", [normalizedTrackId]);
    await db.run("DELETE FROM library_album_tracks WHERE track_id = ?", [normalizedTrackId]);
    await db.run("DELETE FROM library_tracks WHERE id = ?", [normalizedTrackId]);

    for (const albumId of albumIds) {
      const result = await db.run(
        `DELETE FROM library_albums
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM library_album_tracks WHERE album_id = ?)`,
        [albumId, albumId],
      );
      if (result.changes > 0) await removeLibrarySearchDocument("album", albumId);
    }
    for (const artistId of artistIds) {
      const result = await db.run(
        `DELETE FROM library_artists
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = ?)`,
        [artistId, artistId],
      );
      if (result.changes > 0) await removeLibrarySearchDocument("artist", artistId);
    }
    return true;
  });
  if (removed) await invalidateLibraryCache();
  return removed;
}

export async function removeLibraryAlbumTracksWithoutMedia(albumId, source, { syncSearch = true } = {}) {
  const mediaSource = normalizeText(source);
  const changed = await db.transaction(async () => {
    const trackIds = (
      await db.all("SELECT track_id FROM library_album_tracks WHERE album_id = ?", [Number(albumId)])
    ).map((row) => row.track_id);
    const result = await db.run(
      `DELETE FROM library_album_tracks
       WHERE album_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM library_media_files AS media
           WHERE media.track_id = library_album_tracks.track_id
             AND media.album_id = library_album_tracks.album_id
             AND media.source = ?
             AND media.available = 1
         )
         AND NOT EXISTS (
           SELECT 1
           FROM library_media_files AS media
           WHERE media.track_id = library_album_tracks.track_id
             AND media.album_id = library_album_tracks.album_id
             AND media.source != ?
             AND media.available = 1
         )`,
      [Number(albumId), mediaSource, mediaSource],
    );
    if (syncSearch || result.changes > 0) {
      for (const trackId of trackIds) await syncSearchTrack(trackId, syncSearch);
    }
    return result.changes > 0;
  });
  if (changed) await invalidateLibraryCache();
}

export async function upsertLibraryMediaFile({
  trackId,
  albumId = null,
  source,
  path,
  format = null,
  size = 0,
  mtimeMs = null,
  durationMs = null,
  quality = null,
  available = true,
  scanId,
}) {
  const filePath = normalizeText(path);
  const fileSource = normalizeText(source);
  if (!Number.isSafeInteger(Number(trackId)) || !fileSource || !filePath) {
    throw new Error("Library media file trackId, source, and path are required");
  }
  const normalizedAlbumId = Number.isSafeInteger(Number(albumId)) && Number(albumId) > 0
    ? Number(albumId)
    : null;
  const normalizedFormat = format || null;
  // BIGINT columns: fs.stat gives fractional mtimeMs, Lidarr fractional durations.
  const normalizedSize = Math.round(Number(size)) || 0;
  const normalizedMtimeMs = Number.isFinite(Number(mtimeMs)) ? Math.round(Number(mtimeMs)) : null;
  const normalizedDurationMs = Number.isFinite(Number(durationMs))
    ? Math.round(Number(durationMs))
    : null;
  const qualityText = stringify(quality);
  const normalizedAvailable = available === true ? 1 : 0;
  // BIGINT column rejects NaN; callers outside a scan omit scanId.
  const normalizedScanId = Number.isSafeInteger(Number(scanId)) ? Number(scanId) : null;
  const existing = await db.get(
    "SELECT * FROM library_media_files WHERE source = ? AND path = ?",
    [fileSource, filePath],
  );
  if (
    existing &&
    Number(trackId) === existing.track_id &&
    (normalizedAlbumId == null || normalizedAlbumId === existing.album_id) &&
    normalizedFormat === existing.format &&
    normalizedSize === existing.size &&
    normalizedMtimeMs === existing.mtime_ms &&
    normalizedDurationMs === existing.duration_ms &&
    (qualityText == null || qualityText === existing.quality_json) &&
    normalizedAvailable === existing.available
  ) {
    return existing;
  }
  const timestamp = now();
  const row = await db.get(
    `INSERT INTO library_media_files
      (track_id, album_id, source, path, format, size, mtime_ms, duration_ms, quality_json, available, last_seen_scan_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, path) DO UPDATE SET
       track_id = excluded.track_id,
       album_id = COALESCE(excluded.album_id, library_media_files.album_id),
       source = excluded.source,
       format = excluded.format,
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       duration_ms = excluded.duration_ms,
       quality_json = COALESCE(excluded.quality_json, library_media_files.quality_json),
       available = excluded.available,
       last_seen_scan_id = excluded.last_seen_scan_id,
       updated_at = excluded.updated_at
     RETURNING *`,
    [
      Number(trackId),
      normalizedAlbumId,
      fileSource,
      filePath,
      normalizedFormat,
      normalizedSize,
      normalizedMtimeMs,
      normalizedDurationMs,
      qualityText,
      normalizedAvailable,
      normalizedScanId,
      timestamp,
      timestamp,
    ],
  );
  await invalidateLibraryCache();
  return row;
}

export async function getAvailableLibraryMediaPaths(source) {
  const rows = await db.all(
    "SELECT path FROM library_media_files WHERE source = ? AND available = 1",
    [normalizeText(source)],
  );
  return new Set(rows.map((row) => row.path));
}

// Available media paths for the given canonical artists only, used by scoped
// Lidarr re-indexes so they never mark other artists' files unavailable.
export async function getAvailableLibraryMediaPathsForArtists(source, artistIds) {
  const ids = [...new Set((Array.isArray(artistIds) ? artistIds : []).map(Number))]
    .filter((id) => Number.isSafeInteger(id));
  if (!ids.length) return new Set();
  const rows = await db.all(
    `SELECT DISTINCT media.path
     FROM library_media_files AS media
     JOIN library_albums AS album ON album.id = media.album_id
     WHERE media.source = ? AND media.available = 1
       AND album.artist_id = ANY(?::bigint[])`,
    [normalizeText(source), ids],
  );
  return new Set(rows.map((row) => row.path));
}

export async function markLibraryMediaFilesUnavailable(source, paths) {
  const mediaSource = normalizeText(source);
  const missingPaths = [...new Set(paths)].map(normalizeText).filter(Boolean);
  if (!mediaSource || missingPaths.length === 0) return 0;
  const result = await db.run(
    `UPDATE library_media_files
     SET available = 0, updated_at = ?
     WHERE source = ? AND path = ANY(?::text[]) AND available = 1`,
    [now(), mediaSource, missingPaths],
  );
  if (result.changes > 0) await invalidateLibraryCache();
  return result.changes;
}

export async function withLibraryScan(source, rootPath, run) {
  const parentScan = libraryScanContext.getStore();
  const scan = { changed: false, search: createSearchSyncSet() };
  return libraryScanContext.run(scan, async () => {
    libraryScanDepth += 1;
    let scanId;
    try {
      scanId = await beginLibraryScan({ source, rootPath });
      const result = await run(scanId);
      await finishLibraryScan(scanId, { ...result, status: "complete" });
      return { scanId, ...result, changed: scan.changed, status: "complete" };
    } catch (error) {
      if (scanId) await finishLibraryScan(scanId, { status: "failed", error: error.message });
      throw error;
    } finally {
      if (scan.changed && parentScan) parentScan.changed = true;
      // Rows written before a failure are committed; sync on both paths.
      if (parentScan) mergeSearchSyncSets(parentScan.search, scan.search);
      else await syncLibrarySearchEntities(scan.search);
      libraryScanDepth -= 1;
      if (libraryScanDepth === 0 && libraryCacheInvalidationPending) {
        libraryCacheInvalidationPending = false;
        await invalidateCanonicalLibraryCache();
      }
    }
  });
}

// Reconciles documents after a failed scan without a full rebuild.
export async function repairLibrarySearchDocuments() {
  return syncLibrarySearchEntities(await findLibrarySearchDocumentGaps());
}

export async function getLibrarySnapshot() {
  const [artists, albums, tracks, albumTracks, files] = await Promise.all([
    db.all("SELECT * FROM library_artists ORDER BY name"),
    db.all("SELECT * FROM library_albums ORDER BY title"),
    db.all("SELECT * FROM library_tracks ORDER BY title"),
    db.all("SELECT * FROM library_album_tracks"),
    db.all("SELECT * FROM library_media_files ORDER BY path"),
  ]);
  return { artists, albums, tracks, albumTracks, files };
}

export async function getLibraryMediaFile({ source, path }) {
  return db.get(
    `SELECT *
     FROM library_media_files
     WHERE source = ? AND path = ?
     LIMIT 1`,
    [normalizeText(source), normalizeText(path)],
  );
}
