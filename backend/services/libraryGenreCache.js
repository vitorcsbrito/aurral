import { db } from "../config/database.js";

// Genre stats come from a persisted snapshot in settings rows.
// Library mutations never drop it; a debounced refresh replaces it.
// Readers keep seeing the old snapshot until then.

export const GENRE_STATS_SETTING_PREFIX = "libraryGenreStats:";
export const GENRE_LIST_SETTING_PREFIX = "libraryGenreList:";
export const genreCacheKey = (sourceFilter, availableOnly) =>
  `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;

const REFRESH_DEBOUNCE_MS = 15_000;
const REFRESH_RETRY_MS = 60_000;

const statsCache = new Map();
const listCache = new Map();
let refreshTimer = null;
let activeRefresh = null;
let refreshRequested = false;

const genreMediaExists = (kind, sourceFilter, availableOnly) => {
  const filters = [];
  const parameters = [];
  if (sourceFilter) {
    filters.push("page_media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly) filters.push("page_media.available = 1");
  const filterSql = filters.length ? filters.join(" AND ") : "1 = 1";
  if (kind === "artists") {
    return {
      sql: `EXISTS (
        SELECT 1 FROM library_albums AS page_album
        JOIN library_album_tracks AS page_album_track ON page_album_track.album_id = page_album.id
        JOIN library_media_files AS page_media
          ON page_media.track_id = page_album_track.track_id
          AND (page_media.album_id = page_album_track.album_id OR page_media.album_id IS NULL)
        WHERE page_album.artist_id = artist.id AND ${filterSql}
      )`,
      parameters,
    };
  }
  if (kind === "albums") {
    return {
      sql: `EXISTS (
        SELECT 1 FROM library_album_tracks AS page_album_track
        JOIN library_media_files AS page_media
          ON page_media.track_id = page_album_track.track_id
          AND (page_media.album_id = page_album_track.album_id OR page_media.album_id IS NULL)
        WHERE page_album_track.album_id = album.id AND ${filterSql}
      )`,
      parameters,
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM library_media_files AS page_media
      WHERE page_media.track_id = track.id AND ${filterSql}
    )`,
    parameters,
  };
};

// Genre membership is read from the trigger-maintained library_genres table
// (backend/db/pg/schema.js); only media existence is evaluated here.
export async function computeLibraryGenreStats({ sourceFilter = null, availableOnly = false } = {}) {
  const entities = [
    ["artists", "artist", "library_artists AS artist"],
    ["albums", "album", "library_albums AS album"],
    ["tracks", "track", "library_tracks AS track"],
  ];
  const parameters = [];
  const rows = entities.map(([kind, entityKind, from]) => {
    const media = genreMediaExists(kind, sourceFilter, availableOnly);
    parameters.push(...media.parameters);
    return `SELECT '${kind}' AS entity_kind, genre.entity_id, genre.genre AS name
      FROM library_genres AS genre
      JOIN ${from} ON ${entityKind}.id = genre.entity_id
      WHERE genre.entity_kind = '${entityKind}'
        AND ${media.sql}`;
  });
  const result = await db.all(
    `WITH genre_entities AS (
       SELECT entity_kind, entity_id, name
       FROM (${rows.join(" UNION ALL ")}) AS entity_rows
     )
     SELECT name,
       COUNT(*) FILTER (WHERE entity_kind = 'artists') AS artists,
       COUNT(*) FILTER (WHERE entity_kind = 'albums') AS albums,
       COUNT(*) FILTER (WHERE entity_kind = 'tracks') AS tracks
     FROM genre_entities
     GROUP BY name
     ORDER BY lower(name)`,
    parameters,
  );
  return result.map((row) => ({
    name: row.name,
    artists: Number(row.artists || 0),
    albums: Number(row.albums || 0),
    tracks: Number(row.tracks || 0),
  }));
}

export async function computeLibraryGenreList({ sourceFilter = null, availableOnly = false } = {}) {
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    "(media.album_id = album_track.album_id OR media.album_id IS NULL)",
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  const genreRows = (entityKind, idColumn) => `
    SELECT eligible.album_id, eligible.track_id, genre.genre
    FROM eligible_tracks AS eligible
    JOIN library_genres AS genre
      ON genre.entity_kind = '${entityKind}' AND genre.entity_id = eligible.${idColumn}`;
  const rows = await db.all(
    `WITH eligible_tracks AS MATERIALIZED (
       SELECT DISTINCT
         album.id AS album_id,
         album.artist_id AS artist_id,
         track.id AS track_id
       FROM library_albums AS album
       JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
       JOIN library_tracks AS track ON track.id = album_track.track_id
       WHERE EXISTS (
         SELECT 1
         FROM library_media_files AS media
         WHERE ${mediaConditions.join(" AND ")}
       )
     ),
     direct_genres AS (
       SELECT DISTINCT album_id, genre FROM (
         ${genreRows("artist", "artist_id")}
         UNION
         ${genreRows("album", "album_id")}
       ) AS direct_rows
     ),
     track_genres AS (
       SELECT DISTINCT album_id, track_id, genre FROM (
         ${genreRows("track", "track_id")}
       ) AS track_rows
     ),
     track_counts AS (
       SELECT album_id, COUNT(*) AS song_count
       FROM eligible_tracks
       GROUP BY album_id
     ),
     album_genres AS (
       SELECT direct.album_id, direct.genre, tracks.song_count
       FROM direct_genres AS direct
       JOIN track_counts AS tracks ON tracks.album_id = direct.album_id
       UNION ALL
       SELECT track.album_id, track.genre, COUNT(*) AS song_count
       FROM track_genres AS track
       WHERE NOT EXISTS (
         SELECT 1 FROM direct_genres AS direct
         WHERE direct.album_id = track.album_id AND direct.genre = track.genre
       )
       GROUP BY track.album_id, track.genre
     )
     SELECT genre AS value, COUNT(*) AS "albumCount", SUM(song_count) AS "songCount"
     FROM album_genres
     GROUP BY genre
     ORDER BY lower(genre)`,
    parameters,
  );
  return rows.map((row) => ({
    albumCount: Number(row.albumCount || 0),
    songCount: Number(row.songCount || 0),
    value: row.value,
  }));
}

// The persisted snapshot covers the unfiltered variants only: stats for both
// availability variants plus the Subsonic genre list.
export async function computeLibraryGenreSnapshot() {
  const entries = [];
  for (const availableOnly of [false, true]) {
    entries.push([
      `${GENRE_STATS_SETTING_PREFIX}${genreCacheKey(null, availableOnly)}`,
      await computeLibraryGenreStats({ availableOnly }),
    ]);
  }
  entries.push([
    `${GENRE_LIST_SETTING_PREFIX}${genreCacheKey(null, false)}`,
    await computeLibraryGenreList(),
  ]);
  return entries;
}

const UPSERT_SETTING_SQL =
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value";

export async function writeLibraryGenreSnapshot(entries) {
  await db.transaction(async () => {
    for (const [key, value] of entries) {
      await db.run(UPSERT_SETTING_SQL, [key, JSON.stringify(value)]);
    }
  });
}

export async function rebuildStoredLibraryGenreStats() {
  await writeLibraryGenreSnapshot(await computeLibraryGenreSnapshot());
}

const parseArray = (value) => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readStored = async (key) =>
  parseArray((await db.get("SELECT value FROM settings WHERE key = ?", [key]))?.value);

// Source-filtered variants are absent from the snapshot: computed on demand.
const isSnapshotVariant = (prefix, sourceFilter, availableOnly) =>
  sourceFilter == null && (prefix === GENRE_STATS_SETTING_PREFIX || availableOnly === false);

async function readCached(cache, prefix, sourceFilter, availableOnly, compute) {
  const cacheKey = genreCacheKey(sourceFilter, availableOnly);
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const snapshotVariant = isSnapshotVariant(prefix, sourceFilter, availableOnly);
  const stored = snapshotVariant ? await readStored(`${prefix}${cacheKey}`) : null;
  if (stored) {
    cache.set(cacheKey, stored);
    return stored;
  }
  const computed = await compute();
  cache.set(cacheKey, computed);
  // No snapshot yet (fresh database or first run after upgrade): let the
  // background refresh persist it for next time.
  if (snapshotVariant) scheduleLibraryGenreRefresh({ delayMs: 0 });
  return computed;
}

export function getLibraryGenreStats({ sourceFilter = null, availableOnly = false } = {}) {
  return readCached(statsCache, GENRE_STATS_SETTING_PREFIX, sourceFilter, availableOnly, () =>
    computeLibraryGenreStats({ sourceFilter, availableOnly }));
}

export function getLibraryGenreList({ sourceFilter = null, availableOnly = false } = {}) {
  return readCached(listCache, GENRE_LIST_SETTING_PREFIX, sourceFilter, availableOnly, () =>
    computeLibraryGenreList({ sourceFilter, availableOnly }));
}

// Drop the in-memory mirror so the next read reloads the persisted snapshot.
export function clearLibraryGenreMemoryCache() {
  statsCache.clear();
  listCache.clear();
}

// Full recompute inline. Used by tests and by the search-index migration;
// scans use the background refresh instead.
export async function rebuildLibraryGenreSnapshot() {
  await rebuildStoredLibraryGenreStats();
  clearLibraryGenreMemoryCache();
}

const applySnapshot = async (entries) => {
  await writeLibraryGenreSnapshot(entries);
  // The snapshot reflects the library after the change that scheduled it, so
  // every memo (including filtered variants) is stale.
  clearLibraryGenreMemoryCache();
  for (const [key, value] of entries) {
    if (key.startsWith(GENRE_STATS_SETTING_PREFIX)) {
      statsCache.set(key.slice(GENRE_STATS_SETTING_PREFIX.length), value);
    } else if (key.startsWith(GENRE_LIST_SETTING_PREFIX)) {
      listCache.set(key.slice(GENRE_LIST_SETTING_PREFIX.length), value);
    }
  }
};

export function runLibraryGenreRefresh() {
  if (activeRefresh) {
    refreshRequested = true;
    return activeRefresh;
  }
  activeRefresh = (async () => {
    try {
      do {
        refreshRequested = false;
        await applySnapshot(await computeLibraryGenreSnapshot());
      } while (refreshRequested);
    } catch (error) {
      console.error("[libraryGenreCache] genre refresh failed:", error);
      // Keep serving the previous snapshot and try again later; a request that
      // arrived during the failed run is folded into the retry.
      refreshRequested = false;
      scheduleLibraryGenreRefresh({ delayMs: REFRESH_RETRY_MS });
    } finally {
      activeRefresh = null;
    }
  })();
  return activeRefresh;
}

// Debounced: back-to-back scans and mutation bursts collapse into one refresh
// after the library goes quiet. No-op under tests, which call
// rebuildLibraryGenreSnapshot() or runLibraryGenreRefresh() explicitly.
export function scheduleLibraryGenreRefresh({ delayMs = REFRESH_DEBOUNCE_MS } = {}) {
  if (process.env.NODE_ENV === "test") return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    runLibraryGenreRefresh();
  }, delayMs);
  refreshTimer.unref?.();
}

export function isLibraryGenreRefreshActive() {
  return Boolean(activeRefresh || refreshTimer);
}
