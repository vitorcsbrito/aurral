import { db, dbHelpers } from "../config/database.js";
import {
  clearLibraryGenreMemoryCache,
  getLibraryGenreList,
  getLibraryGenreStats,
  rebuildLibraryGenreSnapshot,
  scheduleLibraryGenreRefresh,
} from "./libraryGenreCache.js";
import { getLibrarySearchMatch } from "./librarySearchIndex.js";

const SOURCES = new Set(["aurral", "lidarr"]);
const libraryCache = new Map();
let artistKeysCache = null;
const PAGE_KINDS = new Set(["artists", "albums", "tracks", "genres"]);
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const MAX_ARTIST_PROJECTION_PAGE_SIZE = 10000;

const parseJson = (value) => {
  if (!value) return null;
  try {
    return dbHelpers.parseJSON(value);
  } catch {
    return null;
  }
};

const parseSources = (value) => String(value || "")
  .split(",")
  .map((source) => source.trim())
  .filter(Boolean)
  .sort();

function normalizeSource(source) {
  const value = String(source || "").trim().toLowerCase();
  if (!value || value === "all") return null;
  if (!SOURCES.has(value)) throw new Error(`Unsupported library source: ${value}`);
  return value;
}

function createEntity(map, id, value) {
  if (!map.has(id)) map.set(id, value);
  return map.get(id);
}

const CANONICAL_SELECT = `SELECT
  artist.id AS artist_id,
  artist.identity_key AS artist_identity_key,
  artist.mbid AS artist_mbid,
  artist.name AS artist_name,
  artist.sort_name AS artist_sort_name,
  artist.metadata_json AS artist_metadata_json,
  album.id AS album_id,
  album.identity_key AS album_identity_key,
  album.mbid AS album_mbid,
  album.release_group_mbid AS album_release_group_mbid,
  album.title AS album_title,
  album.album_artist AS album_artist,
  album.release_date AS album_release_date,
  album.metadata_json AS album_metadata_json,
  track.id AS track_id,
  track.identity_key AS track_identity_key,
  track.mbid AS track_mbid,
  track.title AS track_title,
  track.artist_name AS track_artist_name,
  track.metadata_json AS track_metadata_json,
  album_track.disc_number,
  album_track.track_number,
  media.id AS media_id,
  media.album_id AS media_album_id,
  media.source AS media_source,
  media.path AS media_path,
  media.format AS media_format,
  media.size AS media_size,
  media.mtime_ms AS media_mtime_ms,
  media.duration_ms AS media_duration_ms,
  media.quality_json AS media_quality_json,
  media.available AS media_available`;

const albumMediaCondition = (mediaAlias, albumTrackAlias) =>
  `(${mediaAlias}.album_id = ${albumTrackAlias}.album_id OR ${mediaAlias}.album_id IS NULL)`;

const CANONICAL_FROM = `FROM library_artists AS artist
  JOIN library_albums AS album ON album.artist_id = artist.id
  JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
  JOIN library_tracks AS track ON track.id = album_track.track_id
  LEFT JOIN library_media_files AS media
    ON media.track_id = track.id
    AND ${albumMediaCondition("media", "album_track")}`;

function buildLibraryFromRows(rows) {
  const artists = new Map();
  const albums = new Map();
  const tracks = new Map();

  for (const row of rows) {
    const artist = createEntity(artists, row.artist_id, {
      id: row.artist_id,
      identityKey: row.artist_identity_key,
      mbid: row.artist_mbid,
      name: row.artist_name,
      sortName: row.artist_sort_name,
      metadata: parseJson(row.artist_metadata_json),
      albumIds: [],
      sources: [],
      available: false,
    });
    const album = createEntity(albums, row.album_id, {
      id: row.album_id,
      identityKey: row.album_identity_key,
      mbid: row.album_mbid,
      releaseGroupMbid: row.album_release_group_mbid,
      artistId: row.artist_id,
      title: row.album_title,
      albumArtist: row.album_artist,
      releaseDate: row.album_release_date,
      metadata: parseJson(row.album_metadata_json),
      trackIds: [],
      sources: [],
      available: false,
    });
    const track = createEntity(tracks, row.track_id, {
      id: row.track_id,
      identityKey: row.track_identity_key,
      mbid: row.track_mbid,
      title: row.track_title,
      artistName: row.track_artist_name,
      metadata: parseJson(row.track_metadata_json),
      albums: [],
      files: [],
      sources: [],
      available: false,
    });

    if (!artist.albumIds.includes(album.id)) artist.albumIds.push(album.id);
    if (!album.trackIds.includes(track.id)) album.trackIds.push(track.id);
    if (!track.albums.some((entry) => entry.albumId === album.id)) {
      track.albums.push({
        albumId: album.id,
        discNumber: row.disc_number,
        trackNumber: row.track_number,
      });
    }

    if (row.media_id != null) {
      if (row.media_source && !artist.sources.includes(row.media_source)) {
        artist.sources.push(row.media_source);
      }
      if (row.media_source && !album.sources.includes(row.media_source)) {
        album.sources.push(row.media_source);
      }
      if (row.media_source && !track.sources.includes(row.media_source)) {
        track.sources.push(row.media_source);
      }

      const file = {
        id: row.media_id,
        albumId: row.media_album_id,
        source: row.media_source,
        path: row.media_path,
        format: row.media_format,
        size: row.media_size,
        mtimeMs: row.media_mtime_ms,
        durationMs: row.media_duration_ms,
        quality: parseJson(row.media_quality_json),
        available: Boolean(row.media_available),
      };
      if (!track.files.some((entry) => entry.id === file.id)) track.files.push(file);
      if (file.available) {
        artist.available = true;
        album.available = true;
        track.available = true;
      }
    }
  }

  for (const entity of [...artists.values(), ...albums.values(), ...tracks.values()]) {
    entity.sources.sort();
  }
  for (const track of tracks.values()) {
    track.files.sort((left, right) => left.path.localeCompare(right.path));
  }

  return {
    artists: [...artists.values()],
    albums: [...albums.values()],
    tracks: [...tracks.values()],
  };
}

const normalizeLookupValues = (values) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];

const canonicalOrder = `ORDER BY lower(artist.sort_name), lower(artist.name),
  lower(album.title), album_track.disc_number, album_track.track_number,
  lower(track.title), lower(media.path)`;

async function getScopedCanonicalLibrary({
  source = null,
  availableOnly = false,
  conditions = [],
  parameters = [],
}) {
  const sourceFilter = normalizeSource(source);
  const where = [...conditions];
  const values = [...parameters];
  if (sourceFilter) {
    where.push("media.source = ?");
    values.push(sourceFilter);
  }
  if (availableOnly === true) where.push("media.available = 1");
  const rows = await db.all(
    `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     WHERE ${where.join(" AND ")}
     ${canonicalOrder}`,
    values,
  );
  return buildLibraryFromRows(rows);
}

export async function getCanonicalArtistMbids({ source = null, availableOnly = false, mbids = [] } = {}) {
  const references = normalizeLookupValues(mbids);
  if (!references.length) return new Set();
  const sourceFilter = normalizeSource(source);
  const parameters = [...references];
  const conditions = [`artist.mbid IN (${references.map(() => "?").join(",")})`];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const rows = await db.all(
    `SELECT DISTINCT artist.mbid AS mbid
     ${CANONICAL_FROM}
     WHERE ${conditions.join(" AND ")}`,
    parameters,
  );
  return new Set(rows.map((row) => row.mbid).filter(Boolean));
}

const canonicalArtistProjection = (row) => {
  const metadata = parseJson(row.metadata_json) || {};
  const providerId = metadata.id == null ? null : String(metadata.id);
  const monitorOption = metadata.monitor || metadata.addOptions?.monitor || "none";
  const sources = new Set(
    String(row.sources || "")
      .split(",")
      .map((source) => source.trim())
      .filter(Boolean),
  );
  if (metadata.librarySource === "lidarr") sources.add("lidarr");
  return {
    id: String(row.id),
    canonicalId: String(row.id),
    providerId,
    lidarrManaged: metadata.librarySource === "lidarr",
    mbid: row.mbid || null,
    foreignArtistId: metadata.foreignArtistId || row.mbid || row.identity_key,
    artistName: row.name,
    name: row.name,
    sortName: row.sort_name || row.name,
    path: metadata.path || null,
    addedAt: metadata.added || (row.created_at ? new Date(row.created_at).toISOString() : null),
    monitored: metadata.monitored === true,
    monitorOption,
    monitorNewItems: metadata.monitorNewItems || "none",
    addOptions: metadata.addOptions || { monitor: monitorOption },
    quality: metadata.qualityProfile?.name || "standard",
    albumFolders: true,
    statistics: {
      albumCount: Number(row.album_count || 0),
      trackCount: Number(row.track_count || 0),
      sizeOnDisk: Number(row.size_on_disk || 0),
    },
    sources: [...sources].sort(),
    available: Boolean(row.available),
    stale: Boolean(row.stale),
  };
};

const canonicalArtistKeyRow = (row) => {
  const providerId = row.provider_id == null ? null : String(row.provider_id);
  const foreignArtistId = row.foreign_artist_id || row.mbid || row.identity_key;
  return {
    id: String(row.id),
    canonicalId: String(row.id),
    providerId,
    mbid: row.mbid || null,
    foreignArtistId,
    name: row.name,
    artistName: row.name,
    sortName: row.sort_name || row.name,
    addedAt: row.added_at || (row.created_at ? new Date(row.created_at).toISOString() : null),
  };
};

// Identity-only view of every library artist: no joins, no per-row JSON parsing,
// cached until the library changes. Callers that only need mbid/name keys
// (discovery, news, inbox, shows, playlists) must use this instead of the
// stats projection, which aggregates albums/tracks/media for every artist.
// The returned array and its entries are shared; treat them as read-only.
export async function getCanonicalArtistKeys() {
  if (artistKeysCache) return artistKeysCache;
  const rows = await db.all(
    `SELECT
       id,
       identity_key,
       mbid,
       name,
       sort_name,
       created_at,
       aurral_json(metadata_json) ->> 'foreignArtistId' AS foreign_artist_id,
       aurral_json(metadata_json) ->> 'id' AS provider_id,
       aurral_json(metadata_json) ->> 'added' AS added_at
     FROM library_artists
     ORDER BY lower(sort_name), lower(name), id`,
  );
  artistKeysCache = rows.map(canonicalArtistKeyRow);
  return artistKeysCache;
}

export async function getCanonicalArtistKeyProjection() {
  return (await getCanonicalArtistKeys()).map((artist) => ({
    id: artist.id,
    mbid: artist.mbid,
    foreignArtistId: artist.foreignArtistId,
    name: artist.name,
    artistName: artist.artistName,
  }));
}

const ARTIST_PAGE_COLUMNS = [
  "artist.id",
  "artist.identity_key",
  "artist.mbid",
  "artist.name",
  "artist.sort_name",
  "artist.metadata_json",
  "artist.created_at",
];

function buildCanonicalArtistProjectionQuery({
  page = 1,
  pageSize = 100,
  offset = null,
  reference = null,
} = {}) {
  const normalizedPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const normalizedPageSize = Math.min(
    MAX_ARTIST_PROJECTION_PAGE_SIZE,
    Math.max(1, Number.parseInt(pageSize, 10) || 100),
  );
  const normalizedOffset = offset == null
    ? (normalizedPage - 1) * normalizedPageSize
    : Math.max(0, Number.parseInt(offset, 10) || 0);
  const references = normalizeLookupValues(reference == null ? [] : [reference]);
  const parameters = [];
  const where = [];
  if (references.length) {
    where.push(`(
      CAST(artist.id AS TEXT) IN (${references.map(() => "?").join(",")}) OR
      artist.mbid IN (${references.map(() => "?").join(",")}) OR
      artist.identity_key IN (${references.map(() => "?").join(",")}) OR
      (aurral_json(artist.metadata_json) ->> 'id') IN (${references.map(() => "?").join(",")}) OR
      (aurral_json(artist.metadata_json) ->> 'foreignArtistId') IN (${references.map(() => "?").join(",")}) OR
      lower(artist.name) IN (${references.map(() => "lower(?)").join(",")})
    )`);
    parameters.push(
      ...references,
      ...references,
      ...references,
      ...references,
      ...references,
      ...references,
    );
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = references.length ? "" : "LIMIT ? OFFSET ?";
  if (!references.length) {
    parameters.push(normalizedPageSize, normalizedOffset);
  }
  return {
    parameters,
    sql: `
    WITH artist_page AS MATERIALIZED (
      SELECT
        artist.id,
        artist.identity_key,
        artist.mbid,
        artist.name,
        artist.sort_name,
        artist.metadata_json,
        artist.created_at
      FROM library_artists AS artist
      ${whereSql}
      ORDER BY lower(artist.sort_name), lower(artist.name), artist.id
      ${limit}
    )
    SELECT
      artist.id,
      artist.identity_key,
      artist.mbid,
      artist.name,
      artist.sort_name,
      artist.metadata_json,
      artist.created_at,
      COUNT(DISTINCT album.id) AS album_count,
      COUNT(DISTINCT album_track.track_id) AS track_count,
      COALESCE(SUM(CASE WHEN media.available = 1 THEN media.size ELSE 0 END), 0) AS size_on_disk,
      string_agg(DISTINCT media.source, ',') AS sources,
      MAX(CASE WHEN media.available = 1 THEN 1 ELSE 0 END) AS available,
      CASE WHEN EXISTS (
        SELECT 1
        FROM library_scan_runs AS scan
        WHERE scan.source = 'lidarr'
          AND scan.status = 'failed'
          AND scan.id > COALESCE((
            SELECT complete.id
            FROM library_scan_runs AS complete
            WHERE complete.source = 'lidarr' AND complete.status = 'complete'
            ORDER BY complete.id DESC
            LIMIT 1
          ), 0)
      ) THEN 1 ELSE 0 END AS stale
    FROM artist_page AS artist
    LEFT JOIN library_albums AS album ON album.artist_id = artist.id
    LEFT JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
    LEFT JOIN library_media_files AS media ON media.track_id = album_track.track_id
      AND (media.album_id = album_track.album_id OR media.album_id IS NULL)
    GROUP BY ${ARTIST_PAGE_COLUMNS.join(", ")}
    ORDER BY lower(artist.sort_name), lower(artist.name), artist.id
  `,
  };
}

export async function getCanonicalArtistProjection(options = {}) {
  const query = buildCanonicalArtistProjectionQuery(options);
  const rows = await db.all(query.sql, query.parameters);
  return rows.map(canonicalArtistProjection);
}

export async function getCanonicalArtistProjectionQueryPlan(options = {}) {
  const query = buildCanonicalArtistProjectionQuery(options);
  return db.all(`EXPLAIN ${query.sql}`, query.parameters);
}

export async function* iterateCanonicalArtistProjection({ pageSize = 100 } = {}) {
  for (let page = 1; ; page += 1) {
    const artists = await getCanonicalArtistProjection({ page, pageSize });
    yield* artists;
    if (artists.length < Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 100))) break;
  }
}

const canonicalDateAlbumProjection = (row) => {
  const metadata = parseJson(row.metadata_json) || {};
  const artistMetadata = parseJson(row.artist_metadata_json) || {};
  const trackCount = Number(row.track_count || 0);
  const availableTrackCount = Number(row.available_track_count || 0);
  return {
    id: String(row.id),
    canonicalId: String(row.id),
    providerId: metadata.id == null ? null : String(metadata.id),
    artistId: String(row.artist_id),
    providerArtistId: artistMetadata.id == null ? null : String(artistMetadata.id),
    artistName: row.artist_name,
    artistMbid: row.artist_mbid || null,
    foreignArtistId:
      artistMetadata.foreignArtistId || row.artist_mbid || row.artist_identity_key,
    mbid: row.mbid || row.release_group_mbid || null,
    releaseGroupMbid: row.release_group_mbid || null,
    foreignAlbumId: row.mbid || row.release_group_mbid || row.identity_key,
    albumName: row.title,
    title: row.title,
    releaseDate: row.release_date,
    monitored: metadata.monitored === true,
    albumType: metadata.albumType || metadata.releaseType || null,
    trackCount,
    availableTrackCount,
    statistics: {
      trackCount,
      trackFileCount: availableTrackCount,
      sizeOnDisk: Number(row.size_on_disk || 0),
      percentOfTracks: trackCount > 0
        ? Math.round((availableTrackCount / trackCount) * 100)
        : 0,
    },
  };
};

const DATE_ALBUM_COLUMNS = [
  "album.id",
  "album.identity_key",
  "album.mbid",
  "album.release_group_mbid",
  "album.artist_id",
  "album.title",
  "album.release_date",
  "album.metadata_json",
  "album.artist_identity_key",
  "album.artist_mbid",
  "album.artist_name",
  "album.artist_metadata_json",
];

export async function getCanonicalAlbumsByReleaseDate({
  from,
  to = null,
  limit = 100,
  missingOnly = false,
  artistIds = [],
} = {}) {
  const fromDate = String(from || "").trim();
  const toDate = String(to || "").trim();
  if (!fromDate) return [];
  const conditions = ["album.release_date >= ?"];
  const parameters = [fromDate];
  if (toDate) {
    conditions.push("album.release_date <= ?");
    parameters.push(toDate);
  }
  const canonicalArtistIds = [...new Set(
    (Array.isArray(artistIds) ? artistIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )];
  if (Array.isArray(artistIds) && artistIds.length > 0) {
    if (!canonicalArtistIds.length) return [];
    conditions.push("album.artist_id = ANY (?::BIGINT[])");
    parameters.push(canonicalArtistIds);
  }
  if (missingOnly === true) {
    conditions.push(`NOT EXISTS (
      SELECT 1
      FROM library_album_tracks AS owned_relation
      JOIN library_media_files AS owned_media
        ON owned_media.track_id = owned_relation.track_id
        AND (owned_media.album_id = owned_relation.album_id OR owned_media.album_id IS NULL)
      WHERE owned_relation.album_id = album.id
        AND owned_media.available = 1
    )`);
  }
  parameters.push(Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 100)));
  const rows = await db.all(`
    WITH date_albums AS MATERIALIZED (
      SELECT
        album.id,
        album.identity_key,
        album.mbid,
        album.release_group_mbid,
        album.artist_id,
        album.title,
        album.release_date,
        album.metadata_json,
        artist.identity_key AS artist_identity_key,
        artist.mbid AS artist_mbid,
        artist.name AS artist_name,
        artist.metadata_json AS artist_metadata_json
      FROM library_albums AS album
      JOIN library_artists AS artist ON artist.id = album.artist_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY album.release_date DESC, album.id DESC
      LIMIT ?
    )
    SELECT
      ${DATE_ALBUM_COLUMNS.join(",\n      ")},
      COUNT(DISTINCT album_track.track_id) AS track_count,
      COUNT(DISTINCT CASE WHEN media.available = 1 THEN album_track.track_id END) AS available_track_count,
      COALESCE(SUM(CASE WHEN media.available = 1 THEN media.size ELSE 0 END), 0) AS size_on_disk
    FROM date_albums AS album
    LEFT JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
    LEFT JOIN library_media_files AS media
      ON media.track_id = album_track.track_id
      AND (media.album_id = album_track.album_id OR media.album_id IS NULL)
    GROUP BY ${DATE_ALBUM_COLUMNS.join(", ")}
    ORDER BY album.release_date DESC, album.id DESC
  `, parameters);
  return rows.map(canonicalDateAlbumProjection);
}

export async function getCanonicalTrackPath(albumReference, trackReference) {
  const albumValue = String(albumReference ?? "").trim();
  const trackValue = String(trackReference ?? "").trim();
  if (!albumValue || !trackValue) return null;

  const album = /^[1-9]\d*$/.test(albumValue)
    ? await db.get("SELECT id FROM library_albums WHERE id = ?", [albumValue])
    : await db.get(
      `SELECT id FROM library_albums
       WHERE identity_key = ? OR mbid = ? OR release_group_mbid = ?
       LIMIT 1`,
      [albumValue, albumValue, albumValue],
    );
  const track = /^[1-9]\d*$/.test(trackValue)
    ? await db.get("SELECT id FROM library_tracks WHERE id = ?", [trackValue])
    : await db.get(
      `SELECT id FROM library_tracks
       WHERE identity_key = ? OR mbid = ?
       LIMIT 1`,
      [trackValue, trackValue],
    );
  if (!album || !track) return null;

  const row = await db.get(
    `SELECT media.path
     FROM library_media_files AS media
     JOIN library_album_tracks AS album_track
       ON album_track.album_id = ? AND album_track.track_id = media.track_id
     WHERE media.track_id = ?
       AND media.available = 1
       AND (media.album_id = ? OR media.album_id IS NULL)
     ORDER BY (media.album_id = ?) DESC,
              (media.source = 'lidarr') DESC,
              lower(media.path)
     LIMIT 1`,
    [album.id, track.id, album.id, album.id],
  );
  return row?.path || null;
}

export async function getCanonicalTrack({
  trackId,
  source = null,
  availableOnly = false,
  albumId = null,
} = {}) {
  const reference = String(trackId ?? "").trim();
  if (!reference) return { artists: [], albums: [], tracks: [] };

  const numericId = /^\d+$/.test(reference) ? Number(reference) : null;
  const conditions = [];
  const parameters = [];
  if (Number.isSafeInteger(numericId) && numericId > 0) {
    conditions.push("track.id = ?");
    parameters.push(numericId);
  } else {
    conditions.push("(track.identity_key = ? OR track.mbid = ?)");
    parameters.push(reference, reference);
  }
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }

  return getScopedCanonicalLibrary({
    source,
    availableOnly,
    conditions,
    parameters,
  });
}

export async function getCanonicalTrackOwnership({
  trackMbid = null,
  artistName = null,
  trackName = null,
  source = null,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions = ["media.available = 1"];
  const parameters = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }

  const mbid = String(trackMbid || "").trim();
  if (mbid) {
    conditions.push("track.mbid = ?");
    parameters.push(mbid);
  } else {
    const artist = String(artistName || "").trim();
    const title = String(trackName || "").trim();
    if (!artist || !title) return false;
    conditions.push("lower(coalesce(track.artist_name, '')) = lower(?)");
    conditions.push("lower(track.title) = lower(?)");
    parameters.push(artist, title);
  }

  const row = await db.get(
    `SELECT EXISTS (
       SELECT 1
       ${CANONICAL_FROM}
       WHERE ${conditions.join(" AND ")}
     ) AS owned`,
    parameters,
  );
  return Boolean(row?.owned);
}

export async function getCanonicalTrackCount({ source = null, availableOnly = false } = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions = [];
  const parameters = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = await db.get(
    `SELECT COUNT(DISTINCT track.id) AS total
     ${CANONICAL_FROM}
     ${where}`,
    parameters,
  );
  return Number(row?.total || 0);
}

export async function getCanonicalTrackSample({
  source = null,
  availableOnly = false,
  limit = 100,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const conditions = [];
  const parameters = [];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const boundedLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
  const rows = await db.all(
    `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     ${where}
     ${canonicalOrder}
     LIMIT ?`,
    [...parameters, boundedLimit],
  );
  return buildLibraryFromRows(rows);
}

const CANONICAL_FAVORITE_TABLES = {
  artist: "library_artists",
  album: "library_albums",
  song: "library_tracks",
};

function parseCanonicalFavoriteId(value) {
  const input = String(value || "").trim();
  const separator = input.indexOf(":");
  if (separator <= 0) return null;
  const kind = input.slice(0, separator);
  if (!CANONICAL_FAVORITE_TABLES[kind]) return null;
  const rawKey = input.slice(separator + 1);
  if (!rawKey) return null;
  try {
    const key = decodeURIComponent(rawKey).trim();
    return key ? { kind, key, rawKey } : null;
  } catch {
    return null;
  }
}

export async function getCanonicalFavoriteTargetKeys(values = []) {
  const targets = (Array.isArray(values) ? values : [])
    .map(parseCanonicalFavoriteId)
    .filter(Boolean);
  const found = new Set();
  for (const [kind, table] of Object.entries(CANONICAL_FAVORITE_TABLES)) {
    const keys = [...new Set(
      targets.filter((target) => target.kind === kind).map((target) => target.key),
    )];
    if (!keys.length) continue;
    const rows = await db.all(
      `SELECT identity_key FROM ${table}
       WHERE identity_key IN (${keys.map(() => "?").join(",")})`,
      keys,
    );
    for (const row of rows) {
      for (const target of targets) {
        if (target.kind !== kind || target.key !== row.identity_key) continue;
        found.add(`${kind}:${target.rawKey}`);
        found.add(`${kind}:${encodeURIComponent(target.key)}`);
      }
    }
  }
  return found;
}

export async function getCanonicalLibraryForArtists({
  source = null,
  availableOnly = false,
  mbids = [],
} = {}) {
  const references = normalizeLookupValues(mbids);
  if (!references.length) return { artists: [], albums: [], tracks: [] };
  return getScopedCanonicalLibrary({
    source,
    availableOnly,
    conditions: [`artist.mbid IN (${references.map(() => "?").join(",")})`],
    parameters: references,
  });
}

async function getCanonicalLibraryForIds(kind, ids, source, availableOnly) {
  const values = [...new Set((Array.isArray(ids) ? ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!values.length) return { artists: [], albums: [], tracks: [] };
  const alias = kind === "artists" ? "artist" : kind === "albums" ? "album" : "track";
  return getScopedCanonicalLibrary({
    source,
    availableOnly,
    conditions: [`${alias}.id IN (${values.map(() => "?").join(",")})`],
    parameters: values,
  });
}

async function resolveCanonicalReferenceIds(table, references, columns) {
  const numericIds = references
    .filter((reference) => /^\d+$/.test(reference))
    .map(Number);
  const queries = [];
  const parameters = [];
  if (numericIds.length) {
    queries.push(`SELECT id FROM ${table} WHERE id IN (${numericIds.map(() => "?").join(",")})`);
    parameters.push(...numericIds);
  }
  for (const { expression, lowered } of columns) {
    const placeholders = references
      .map(() => (lowered ? "lower(?)" : "?"))
      .join(",");
    queries.push(`SELECT id FROM ${table} WHERE ${expression} IN (${placeholders})`);
    parameters.push(...references);
  }
  const rows = await db.all(queries.join(" UNION "), parameters);
  return rows.map((row) => row.id);
}

const plainColumn = (expression) => ({ expression, lowered: false });

export async function getCanonicalLibraryForArtistReferences({
  source = null,
  availableOnly = false,
  references: requestedReferences = [],
} = {}) {
  const references = normalizeLookupValues(requestedReferences);
  if (!references.length) return { artists: [], albums: [], tracks: [] };
  const ids = await resolveCanonicalReferenceIds(
    "library_artists",
    references,
    [
      plainColumn("identity_key"),
      plainColumn("mbid"),
      plainColumn("aurral_json(metadata_json) ->> 'id'"),
      plainColumn("aurral_json(metadata_json) ->> 'foreignArtistId'"),
      { expression: "lower(name)", lowered: true },
    ],
  );
  return getCanonicalLibraryForIds("artists", ids, source, availableOnly);
}

export async function getCanonicalLibraryForAlbumIds({
  source = null,
  availableOnly = false,
  ids = [],
} = {}) {
  return getCanonicalLibraryForIds("albums", ids, source, availableOnly);
}

export async function getCanonicalLibraryForTrackIds({
  source = null,
  availableOnly = false,
  ids = [],
  albumId = null,
} = {}) {
  const values = [...new Set((Array.isArray(ids) ? ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!values.length) return { artists: [], albums: [], tracks: [] };
  const conditions = [`track.id IN (${values.map(() => "?").join(",")})`];
  const parameters = [...values];
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  return getScopedCanonicalLibrary({ source, availableOnly, conditions, parameters });
}

export async function getCanonicalLibraryForAlbumReferences({
  source = null,
  availableOnly = false,
  references: requestedReferences = [],
} = {}) {
  const references = normalizeLookupValues(requestedReferences);
  if (!references.length) return { artists: [], albums: [], tracks: [] };
  const ids = await resolveCanonicalReferenceIds(
    "library_albums",
    references,
    [plainColumn("identity_key"), plainColumn("mbid"), plainColumn("release_group_mbid")],
  );
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const sourceFilter = normalizeSource(source);
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  parameters.push(...ids);
  const mediaJoin = sourceFilter || availableOnly === true ? "JOIN" : "LEFT JOIN";
  const rows = await db.all(
    `${CANONICAL_SELECT}
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     ${mediaJoin} library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id IN (${ids.map(() => "?").join(",")})
     ${canonicalOrder}`,
    parameters,
  );
  return buildLibraryFromRows(rows);
}

export async function getCanonicalLibrary({ source = null, availableOnly = false, favoriteKeys = null } = {}) {
  const sourceFilter = normalizeSource(source);
  const cacheKey = `${sourceFilter || "all"}:${availableOnly === true ? "available" : "all"}`;
  const favoriteTargets = Array.isArray(favoriteKeys)
    ? favoriteKeys.filter((target) =>
        target && ["artist", "album", "song"].includes(target.kind) && String(target.key || "").trim(),
      )
    : null;
  if (favoriteTargets && favoriteTargets.length === 0) {
    return { artists: [], albums: [], tracks: [] };
  }
  if (!favoriteTargets) {
    const cached = libraryCache.get(cacheKey);
    if (cached) return cached;
  }
  const conditions = [];
  const parameters = [];

  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  if (favoriteTargets) {
    const targetQueries = [];
    const add = (query, kind) => {
      const keys = favoriteTargets
        .filter((target) => target.kind === kind)
        .map((target) => String(target.key).trim());
      if (!keys.length) return;
      targetQueries.push(query.replace("?", keys.map(() => "?").join(",")));
      parameters.push(...keys);
    };
    add("SELECT id FROM library_tracks WHERE identity_key IN (?)", "song");
    add(
      "SELECT album_track.track_id FROM library_album_tracks AS album_track " +
        "JOIN library_albums AS album ON album.id = album_track.album_id " +
        "WHERE album.identity_key IN (?)",
      "album",
    );
    add(
      "SELECT album_track.track_id FROM library_album_tracks AS album_track " +
        "JOIN library_albums AS album ON album.id = album_track.album_id " +
        "JOIN library_artists AS artist ON artist.id = album.artist_id " +
        "WHERE artist.identity_key IN (?)",
      "artist",
    );
    if (!targetQueries.length) return { artists: [], albums: [], tracks: [] };
    conditions.push(`media.track_id IN (${targetQueries.join(" UNION ")})`);
  }

  const rows = await db.all(
    `${CANONICAL_SELECT}
    ${CANONICAL_FROM}
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ${canonicalOrder}`,
    parameters,
  );
  const library = buildLibraryFromRows(rows);
  if (!favoriteTargets) libraryCache.set(cacheKey, library);
  return library;
}

const text = (value) => String(value || "").trim();

const pageNumber = (value) => Math.max(1, Number.parseInt(value, 10) || 1);

const pageSize = (value, max = MAX_PAGE_SIZE) =>
  Math.min(max, Math.max(1, Number.parseInt(value, 10) || DEFAULT_PAGE_SIZE));


// Postgres LIKE treats backslash as the escape character by default.
const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");

const likePattern = (value) => `%${escapeLike(String(value ?? ""))}%`;

// Four-digit leading year, or NULL: Postgres refuses to cast anything else.
const ALBUM_YEAR = `CASE WHEN substr(COALESCE(album.release_date, ''), 1, 4) ~ '^[0-9]{4}$'
  THEN CAST(substr(album.release_date, 1, 4) AS INTEGER) END`;

// Trigram-indexed prefilter over library_search_documents.search_text.
const searchDocumentJoin = (entityKind, idExpression) =>
  `JOIN library_search_documents AS search_document
     ON search_document.entity_kind = '${entityKind}'
     AND search_document.entity_id = ${idExpression}
     AND search_document.search_text LIKE ?`;

const mediaSourceClause = (sourceFilter, alias = "page_media") => {
  const conditions = [];
  const parameters = [];
  if (sourceFilter) {
    conditions.push(`${alias}.source = ?`);
    parameters.push(sourceFilter);
  }
  return { conditions, parameters };
};

const recentMediaFilter = (sourceFilter, availableOnly, alias = "page_media") => {
  const conditions = [];
  if (sourceFilter) conditions.push(`${alias}.source = '${sourceFilter}'`);
  if (availableOnly === true) conditions.push(`${alias}.available = 1`);
  return conditions.length ? ` AND ${conditions.join(" AND ")}` : "";
};

// Newest-first ordering. Without a source filter the trigger-maintained
// `latest_media_at` / `latest_available_media_at` columns (see
// backend/db/pg/schema.js) are indexed together with the title, so the sort
// walks the index; a source filter still needs the per-row MAX().
const recentMediaOrder = (kind, sourceFilter, availableOnly, direction) => {
  const orderDirection = direction === "desc" ? "ASC" : "DESC";
  const titleDirection = direction === "desc" ? "DESC" : "ASC";
  if (!sourceFilter) {
    const alias = kind === "albums" ? "album" : "track";
    const column = availableOnly === true ? "latest_available_media_at" : "latest_media_at";
    return `${alias}.${column} ${orderDirection}, lower(${alias}.title) ${titleDirection}`;
  }
  const mediaFilter = recentMediaFilter(sourceFilter, availableOnly);
  if (kind === "albums") {
    return `COALESCE((
      SELECT MAX(page_media.created_at)
      FROM library_album_tracks AS page_album_track
      JOIN library_media_files AS page_media
        ON page_media.track_id = page_album_track.track_id
      WHERE page_album_track.album_id = album.id
        AND ${albumMediaCondition("page_media", "page_album_track")}${mediaFilter}
    ), 0) ${orderDirection}, lower(album.title) ${titleDirection}`;
  }
  return `COALESCE((
    SELECT MAX(page_media.created_at)
    FROM library_media_files AS page_media
    WHERE page_media.track_id = track.id${mediaFilter}
  ), 0) ${orderDirection}, lower(track.title) ${titleDirection}`;
};

const pageMediaExists = (kind, sourceFilter, availableOnly) => {
  if (!sourceFilter && availableOnly !== true) {
    if (kind === "artists") {
      return {
        sql: `EXISTS (
          SELECT 1
          FROM library_albums AS page_album
          JOIN library_album_tracks AS page_album_track ON page_album_track.album_id = page_album.id
          JOIN library_tracks AS page_track ON page_track.id = page_album_track.track_id
          WHERE page_album.artist_id = artist.id
        )`,
        parameters: [],
      };
    }
    if (kind === "albums") {
      return {
        sql: `EXISTS (
          SELECT 1
          FROM library_album_tracks AS page_album_track
          JOIN library_tracks AS page_track ON page_track.id = page_album_track.track_id
          WHERE page_album_track.album_id = album.id
        )`,
        parameters: [],
      };
    }
    return { sql: "1 = 1", parameters: [] };
  }
  const { conditions, parameters } = mediaSourceClause(sourceFilter);
  if (availableOnly === true) conditions.push("page_media.available = 1");
  const conditionSql = conditions.length ? conditions.join(" AND ") : "1 = 1";
  if (kind === "artists") {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM library_albums AS page_album
        JOIN library_album_tracks AS page_album_track ON page_album_track.album_id = page_album.id
        JOIN library_media_files AS page_media
          ON page_media.track_id = page_album_track.track_id
        WHERE page_album.artist_id = artist.id
          AND ${albumMediaCondition("page_media", "page_album_track")}
          AND ${conditionSql}
      )`,
      parameters,
    };
  }
  if (kind === "albums") {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM library_album_tracks AS page_album_track
        JOIN library_media_files AS page_media
          ON page_media.track_id = page_album_track.track_id
        WHERE page_album_track.album_id = album.id
          AND ${albumMediaCondition("page_media", "page_album_track")}
          AND ${conditionSql}
      )`,
      parameters,
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM library_media_files AS page_media
      WHERE page_media.track_id = track.id AND ${conditionSql}
    )`,
    parameters,
  };
};

// Genre membership comes from the trigger-maintained library_genres table.
// `id IN (<set>)` beats OR'ed EXISTS: drives from the genre index.
const GENRE_ID_SET_SQL = {
  artist: {
    artist: (set) => set,
    album: (set) => `SELECT genre_album.artist_id FROM library_albums AS genre_album WHERE genre_album.id IN (${set})`,
    track: (set) => `SELECT genre_album.artist_id FROM library_albums AS genre_album
      WHERE genre_album.id IN (
        SELECT genre_album_track.album_id FROM library_album_tracks AS genre_album_track
        WHERE genre_album_track.track_id IN (${set})
      )`,
  },
  album: {
    artist: (set) => `SELECT genre_album.id FROM library_albums AS genre_album WHERE genre_album.artist_id IN (${set})`,
    album: (set) => set,
    track: (set) => `SELECT genre_album_track.album_id FROM library_album_tracks AS genre_album_track
      WHERE genre_album_track.track_id IN (${set})`,
  },
  track: {
    artist: (set) => `SELECT genre_album_track.track_id FROM library_album_tracks AS genre_album_track
      WHERE genre_album_track.album_id IN (
        SELECT genre_album.id FROM library_albums AS genre_album WHERE genre_album.artist_id IN (${set})
      )`,
    album: (set) => `SELECT genre_album_track.track_id FROM library_album_tracks AS genre_album_track
      WHERE genre_album_track.album_id IN (${set})`,
    track: (set) => set,
  },
};

const genrePredicate = (target, kinds, genre) => {
  const members = kinds.map((kind) =>
    GENRE_ID_SET_SQL[target][kind](
      `SELECT genre_match.entity_id FROM library_genres AS genre_match
       WHERE genre_match.entity_kind = '${kind}' AND lower(genre_match.genre) = lower(?)`,
    ));
  return {
    sql: `${target}.id IN (${members.join(" UNION ")})`,
    parameters: kinds.map(() => genre),
  };
};

const pageLimit = (value, fallback = 10000) => {
  if (value === null || value === undefined || value === "") return fallback;
  return Math.min(10000, Math.max(0, Number.parseInt(value, 10) || 0));
};

const pageOffset = (value) => Math.max(0, Number.parseInt(value, 10) || 0);

export async function getCanonicalArtistPage({
  source = null,
  availableOnly = false,
  query = "",
  offset = 0,
  limit = null,
  includeStats = false,
  searchMatch = null,
  artistIds = null,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("artists", sourceFilter, availableOnly);
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    conditions.push("lower(artist.name) LIKE ?");
    parameters.push(likePattern(normalizedQuery));
  }
  const boundedLimit = limit === null || limit === undefined || limit === ""
    ? null
    : pageLimit(limit);
  const pageSql = boundedLimit === null ? "" : "LIMIT ? OFFSET ?";
  const searchJoin = searchMatch ? searchDocumentJoin("artist", "artist.id") : "";
  if (searchMatch) {
    parameters.unshift(likePattern(searchMatch));
    conditions.push("lower(search_document.title) LIKE ?");
    parameters.push(likePattern(normalizedQuery));
  }
  const ids = Array.isArray(artistIds)
    ? [...new Set(artistIds
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0))]
    : (await db.all(
      `SELECT artist.id
       FROM library_artists AS artist
       ${searchJoin}
       WHERE ${conditions.join(" AND ")}
       ORDER BY lower(coalesce(artist.sort_name, artist.name)), lower(artist.name), artist.id
       ${pageSql}`,
      [...parameters, ...(boundedLimit === null ? [] : [boundedLimit, pageOffset(offset)])],
    )).map((row) => row.id);
  if (!ids.length) return { artists: [], albums: [], tracks: [] };

  if (!includeStats) {
    const filterAlbums = Boolean(sourceFilter) || availableOnly === true;
    const albumJoin = filterAlbums ? "JOIN" : "LEFT JOIN";
    const albumFilter = filterAlbums
      ? `AND EXISTS (
          SELECT 1
          FROM library_album_tracks AS album_track
          JOIN library_media_files AS media
            ON media.track_id = album_track.track_id
            AND ${albumMediaCondition("media", "album_track")}
          WHERE album_track.album_id = album.id
            ${sourceFilter ? "AND media.source = ?" : ""}
            ${availableOnly === true ? "AND media.available = 1" : ""}
        )`
      : "";
    const rows = await db.all(
      `SELECT
         artist.id AS artist_id,
         artist.identity_key AS artist_identity_key,
         artist.mbid AS artist_mbid,
         artist.name AS artist_name,
         artist.sort_name AS artist_sort_name,
         artist.metadata_json AS artist_metadata_json,
         COUNT(DISTINCT album.id) AS album_count
       FROM library_artists AS artist
       ${albumJoin} library_albums AS album ON album.artist_id = artist.id
       WHERE artist.id IN (${ids.map(() => "?").join(",")})
         ${albumFilter}
       GROUP BY artist.id`,
      [...ids, ...(sourceFilter ? [sourceFilter] : [])],
    );
    const byId = new Map(rows.map((row) => [row.artist_id, {
      id: row.artist_id,
      identityKey: row.artist_identity_key,
      mbid: row.artist_mbid,
      name: row.artist_name,
      sortName: row.artist_sort_name,
      metadata: parseJson(row.artist_metadata_json),
      albumIds: [],
      albumCount: Number(row.album_count || 0),
      sources: [],
      available: availableOnly === true,
    }]));
    return { artists: ids.map((id) => byId.get(id)).filter(Boolean), albums: [], tracks: [] };
  }

  const aggregateParameters = [];
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    aggregateParameters.push(sourceFilter);
  }
  if (availableOnly === true) mediaConditions.push("media.available = 1");
  const mediaJoin = sourceFilter || availableOnly === true ? "JOIN" : "LEFT JOIN";
  aggregateParameters.push(...ids);
  const rows = await db.all(
    `SELECT
       artist.id AS artist_id,
       artist.identity_key AS artist_identity_key,
       artist.mbid AS artist_mbid,
       artist.name AS artist_name,
       artist.sort_name AS artist_sort_name,
       artist.metadata_json AS artist_metadata_json,
       COUNT(DISTINCT album.id) AS album_count,
       COUNT(DISTINCT album_track.track_id) AS track_count,
       COALESCE(SUM(media.size), 0) AS size_on_disk,
       string_agg(DISTINCT media.source, ',') AS sources,
       MAX(media.available) AS available
     FROM library_artists AS artist
     JOIN library_albums AS album ON album.artist_id = artist.id
     JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
     ${mediaJoin} library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE artist.id IN (${ids.map(() => "?").join(",")})
     GROUP BY artist.id
     ORDER BY lower(coalesce(artist.sort_name, artist.name)), lower(artist.name)`,
    aggregateParameters,
  );
  const byId = new Map(rows.map((row) => [row.artist_id, {
    id: row.artist_id,
    identityKey: row.artist_identity_key,
    mbid: row.artist_mbid,
    name: row.artist_name,
    sortName: row.artist_sort_name,
    metadata: parseJson(row.artist_metadata_json),
    albumIds: [],
    albumCount: Number(row.album_count || 0),
    trackCount: Number(row.track_count || 0),
    sizeOnDisk: Number(row.size_on_disk || 0),
    sources: parseSources(row.sources),
    available: Boolean(row.available),
  }]));
  return { artists: ids.map((id) => byId.get(id)).filter(Boolean), albums: [], tracks: [] };
}


export async function getCanonicalAlbumPage({
  source = null,
  availableOnly = false,
  type = "alphabeticalByName",
  genre = "",
  fromYear = null,
  toYear = null,
  query = "",
  artistId = null,
  offset = 0,
  limit = 20,
  searchMatch = null,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("albums", sourceFilter, availableOnly);
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    const fields = ["album.title", "album.album_artist", "artist.name"];
    const pattern = likePattern(normalizedQuery);
    conditions.push(`(${fields.map((field) =>
      `lower(coalesce(${field}, '')) LIKE ?`).join(" OR ")})`);
    parameters.push(...fields.map(() => pattern));
  }
  if (artistId !== null && artistId !== undefined && String(artistId).trim()) {
    conditions.push("album.artist_id = ?");
    parameters.push(Number(artistId));
  }
  const normalizedGenre = text(genre);
  if (normalizedGenre) {
    const predicate = genrePredicate("album", ["artist", "album", "track"], normalizedGenre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const parsedFromYear = Number.parseInt(fromYear, 10);
  const parsedToYear = Number.parseInt(toYear, 10);
  const lowerYear = Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear)
    ? Math.min(parsedFromYear, parsedToYear)
    : parsedFromYear;
  const upperYear = Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear)
    ? Math.max(parsedFromYear, parsedToYear)
    : parsedToYear;
  if (Number.isFinite(lowerYear)) {
    conditions.push(`${ALBUM_YEAR} >= ?`);
    parameters.push(lowerYear);
  }
  if (Number.isFinite(upperYear)) {
    conditions.push(`${ALBUM_YEAR} <= ?`);
    parameters.push(upperYear);
  }

  let orderBy;
  if (type === "random") {
    orderBy = "random()";
  } else if (type === "newest" || type === "recent") {
    orderBy = recentMediaOrder("albums", sourceFilter, availableOnly, "asc");
  } else if (type === "alphabeticalByArtist") {
    orderBy = "lower(coalesce(album.album_artist, artist.name)), lower(album.title)";
  } else if (type === "byYear") {
    orderBy = `${ALBUM_YEAR} ${Number.isFinite(parsedFromYear) && Number.isFinite(parsedToYear) && parsedFromYear > parsedToYear ? "DESC" : "ASC"}, lower(album.title)`;
  } else if (type === "byGenre") {
    orderBy = "lower(coalesce(artist.name, album.album_artist)), lower(album.title)";
  } else {
    orderBy = "lower(album.title), lower(coalesce(album.album_artist, artist.name))";
  }

  const paginatedOrderBy = type === "random" ? orderBy : `${orderBy}, album.id`;
  const boundedLimit = pageLimit(limit, 20);
  if (boundedLimit === 0) return { artists: [], albums: [], tracks: [] };
  const searchJoin = searchMatch ? searchDocumentJoin("album", "album.id") : "";
  if (searchMatch) {
    parameters.unshift(likePattern(searchMatch));
    conditions.push("(lower(search_document.title) LIKE ? OR lower(search_document.artist_name) LIKE ?)");
    parameters.push(likePattern(normalizedQuery), likePattern(normalizedQuery));
  }
  const ids = (await db.all(
    `SELECT album.id
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     ${searchJoin}
     WHERE ${conditions.join(" AND ")}
     GROUP BY album.id, artist.id
     ORDER BY ${paginatedOrderBy}
     LIMIT ? OFFSET ?`,
    [...parameters, boundedLimit, pageOffset(offset)],
  )).map((row) => row.id);
  const library = await getCanonicalLibraryForAlbumIds({ source: sourceFilter, availableOnly, ids });
  const albumsById = new Map(library.albums.map((album) => [album.id, album]));
  library.albums = ids.map((id) => albumsById.get(id)).filter(Boolean);
  return library;
}

async function getRandomTrackIds({ conditions, parameters, limit, offset }) {
  const maximum = Number(
    (await db.get("SELECT max(id) AS maximum FROM library_tracks"))?.maximum || 0,
  );
  if (!maximum) return [];
  const needed = limit + offset;
  const pivot = Math.floor(Math.random() * maximum) + 1;
  const read = async (operator, boundary, count) => (await db.all(
    `SELECT track.id
     FROM library_tracks AS track
     WHERE ${conditions.join(" AND ")} AND track.id ${operator} ?
     ORDER BY track.id
     LIMIT ?`,
    [...parameters, boundary, count],
  )).map((row) => row.id);
  const ids = await read(">=", pivot, needed);
  if (ids.length < needed) ids.push(...await read("<", pivot, needed - ids.length));
  return ids.slice(offset, offset + limit);
}

export async function getCanonicalTrackPage({
  source = null,
  availableOnly = false,
  query = "",
  genre = "",
  artist = "",
  artistId = null,
  albumId = null,
  offset = 0,
  limit = 20,
  random = false,
  searchMatch = null,
} = {}) {
  const sourceFilter = normalizeSource(source);
  const media = pageMediaExists("tracks", sourceFilter, availableOnly);
  const conditions = [media.sql];
  const parameters = [...media.parameters];
  const fields = [
    "track.title",
    "track.artist_name",
    "album.title",
    "album.album_artist",
    "artist.name",
  ];
  const normalizedQuery = text(query).toLocaleLowerCase();
  if (normalizedQuery && !searchMatch) {
    const pattern = likePattern(normalizedQuery);
    conditions.push(`(${fields.map((field) =>
      `lower(coalesce(${field}, '')) LIKE ?`).join(" OR ")})`);
    parameters.push(...fields.map(() => pattern));
  }
  const artistReference = text(artist);
  const normalizedArtist = artistReference.toLocaleLowerCase();
  if (normalizedArtist) {
    conditions.push("(lower(artist.name) = ? OR lower(coalesce(track.artist_name, '')) = ? OR artist.identity_key = ?)");
    parameters.push(normalizedArtist, normalizedArtist, artistReference);
  }
  if (artistId !== null && artistId !== undefined && String(artistId).trim()) {
    conditions.push("artist.id = ?");
    parameters.push(Number(artistId));
  }
  if (albumId !== null && albumId !== undefined && String(albumId).trim()) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  const normalizedGenre = text(genre);
  if (normalizedGenre) {
    const predicate = genrePredicate("track", ["artist", "album", "track"], normalizedGenre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const boundedLimit = pageLimit(limit, 20);
  if (boundedLimit === 0) return { artists: [], albums: [], tracks: [] };
  const useSearchIndex = Boolean(searchMatch)
    && !artistReference
    && !(artistId !== null && artistId !== undefined && String(artistId).trim())
    && !(albumId !== null && albumId !== undefined && String(albumId).trim())
    && !normalizedGenre;
  if (useSearchIndex) {
    const pattern = likePattern(normalizedQuery);
    const searchConditions = [
      ...conditions,
      "(lower(search_document.title) LIKE ? OR lower(search_document.artist_name) LIKE ? OR lower(search_document.album_name) LIKE ?)",
    ];
    const ids = (await db.all(
      `SELECT track.id
       FROM library_tracks AS track
       ${searchDocumentJoin("track", "track.id")}
       WHERE ${searchConditions.join(" AND ")}
       ORDER BY track.id
       LIMIT ? OFFSET ?`,
      [
        likePattern(searchMatch),
        ...parameters,
        pattern,
        pattern,
        pattern,
        boundedLimit,
        pageOffset(offset),
      ],
    )).map((row) => row.id);
    const library = await getCanonicalLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
    const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
    library.tracks = ids.map((id) => tracksById.get(id)).filter(Boolean);
    return library;
  }
  if (random && !normalizedQuery && !artistReference && !normalizedGenre
    && !(artistId !== null && artistId !== undefined && String(artistId).trim())
    && !(albumId !== null && albumId !== undefined && String(albumId).trim())) {
    const ids = await getRandomTrackIds({
      conditions,
      parameters,
      limit: boundedLimit,
      offset: pageOffset(offset),
    });
    const library = await getCanonicalLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
    const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
    library.tracks = ids.map((id) => tracksById.get(id)).filter(Boolean);
    return library;
  }
  // GROUP BY track.id: joined sort columns must be aggregated.
  const orderBy = random
    ? "random()"
    : `min(lower(artist.sort_name)), min(lower(artist.name)), min(lower(album.title)),
       min(album_track.disc_number), min(album_track.track_number), min(lower(track.title))`;
  const ids = (await db.all(
    `SELECT track.id
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY track.id
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
    [...parameters, boundedLimit, pageOffset(offset)],
  )).map((row) => row.id);
  const library = await getCanonicalLibraryForTrackIds({ source: sourceFilter, availableOnly, ids, albumId });
  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  library.tracks = ids.map((id) => tracksById.get(id)).filter(Boolean);
  return library;
}

export async function getCanonicalSearchPage({
  source = null,
  availableOnly = false,
  query = "",
  artistLimit = 20,
  artistOffset = 0,
  albumLimit = 20,
  albumOffset = 0,
  songLimit = 20,
  songOffset = 0,
} = {}) {
  const searchMatch = getLibrarySearchMatch(query);
  const albumLibrary = await getCanonicalAlbumPage({
    source,
    availableOnly,
    query,
    limit: albumLimit,
    offset: albumOffset,
    searchMatch,
  });
  const trackLibrary = await getCanonicalTrackPage({
    source,
    availableOnly,
    query,
    limit: songLimit,
    offset: songOffset,
    searchMatch,
  });
  const artistLibrary = await getCanonicalArtistPage({
    source,
    availableOnly,
    query,
    limit: artistLimit,
    offset: artistOffset,
    searchMatch,
  });
  return {
    artists: artistLibrary.artists,
    albums: albumLibrary,
    tracks: trackLibrary,
  };
}

export async function getCanonicalTopTracks({
  source = null,
  availableOnly = false,
  artist,
  limit = 20,
} = {}) {
  return getCanonicalTrackPage({ source, availableOnly, artist, limit });
}

export async function getCanonicalGenres({ source = null, availableOnly = false } = {}) {
  return getLibraryGenreList({ sourceFilter: normalizeSource(source), availableOnly });
}

function buildPageQuery({
  kind,
  sourceFilter,
  availableOnly,
  query,
  genre,
  sort,
  direction,
  artistId,
  albumId,
}) {
  const where = [];
  const parameters = [];
  const media = pageMediaExists(kind, sourceFilter, availableOnly);
  where.push(media.sql);
  parameters.push(...media.parameters);
  const searchMatch = getLibrarySearchMatch(query);

  let from;
  let idExpression;
  let searchableFields;
  let genreTarget;
  let genreAliases;
  let entityKind;
  let groupBy = null;
  if (kind === "artists") {
    entityKind = "artist";
    from = "FROM library_artists AS artist";
    idExpression = "artist.id";
    searchableFields = ["artist.name"];
    genreTarget = "artist";
    genreAliases = ["artist"];
    if (artistId) {
      where.push("artist.id = ?");
      parameters.push(Number(artistId));
    }
    if (albumId) {
      where.push("EXISTS (SELECT 1 FROM library_albums AS filter_album WHERE filter_album.id = ? AND filter_album.artist_id = artist.id)");
      parameters.push(Number(albumId));
    }
  } else if (kind === "albums") {
    entityKind = "album";
    from = "FROM library_albums AS album JOIN library_artists AS artist ON artist.id = album.artist_id";
    idExpression = "album.id";
    searchableFields = ["album.title", "album.album_artist", "artist.name"];
    genreTarget = "album";
    genreAliases = ["artist", "album"];
    if (artistId) {
      where.push("album.artist_id = ?");
      parameters.push(Number(artistId));
    }
    if (albumId) {
      where.push("album.id = ?");
      parameters.push(Number(albumId));
    }
  } else {
    entityKind = "track";
    const needsRelations = Boolean(artistId || albumId || genre || sort === "artist")
      || Boolean(query && !searchMatch);
    from = needsRelations
      ? `FROM library_tracks AS track
        JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
        JOIN library_albums AS album ON album.id = album_track.album_id
        JOIN library_artists AS artist ON artist.id = album.artist_id`
      : "FROM library_tracks AS track";
    if (needsRelations) groupBy = "track.id";
    idExpression = "track.id";
    searchableFields = [
      "track.title",
      "track.artist_name",
      "album.title",
      "album.album_artist",
      "artist.name",
    ];
    genreTarget = "track";
    genreAliases = ["artist", "album", "track"];
    if (artistId) {
      where.push("artist.id = ?");
      parameters.push(Number(artistId));
    }
    if (albumId) {
      where.push("album.id = ?");
      parameters.push(Number(albumId));
    }
  }

  if (searchMatch) {
    from += `
      ${searchDocumentJoin(entityKind, idExpression)}`;
    parameters.unshift(likePattern(searchMatch));
    const pattern = likePattern(query);
    const indexedFields = kind === "artists"
      ? ["search_document.title"]
      : kind === "albums"
        ? ["search_document.title", "search_document.artist_name"]
        : [
            "search_document.title",
            "search_document.artist_name",
            "search_document.album_name",
          ];
    where.push(`(${indexedFields.map((field) =>
      `lower(${field}) LIKE ?`).join(" OR ")})`);
    parameters.push(...indexedFields.map(() => pattern));
  } else if (query) {
    const pattern = likePattern(query);
    where.push(`(${searchableFields.map((field) =>
      `lower(coalesce(${field}, '')) LIKE ?`).join(" OR ")})`);
    parameters.push(...searchableFields.map(() => pattern));
  }
  if (genre) {
    const predicate = genrePredicate(genreTarget, genreAliases, genre);
    where.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }

  const orderDirection = direction === "desc" ? "DESC" : "ASC";
  let orderBy;
  if (sort === "newest" && (kind === "albums" || kind === "tracks")) {
    orderBy = recentMediaOrder(kind, sourceFilter, availableOnly, direction);
    if (kind === "albums") orderBy += ", album.id";
    else orderBy += ", track.id";
  } else if (sort === "artist" && kind !== "artists") {
    // Grouped track pages need the joined artist name aggregated.
    const artistName = groupBy ? "min(lower(artist.name))" : "lower(artist.name)";
    orderBy = `${artistName} ${orderDirection}, lower(${kind === "albums" ? "album.title" : "track.title"}) ${orderDirection}`;
    if (kind === "albums") orderBy += ", album.id";
    else orderBy += ", track.id";
  } else if (kind === "artists") {
    orderBy = `lower(coalesce(artist.sort_name, artist.name)) ${orderDirection}, lower(artist.name) ${orderDirection}, artist.id ${orderDirection}`;
  } else {
    orderBy = `lower(${kind === "albums" ? "album.title" : "track.title"}) ${orderDirection}`;
    if (kind === "albums") orderBy += `, album.id ${orderDirection}`;
    else orderBy += `, track.id ${orderDirection}`;
  }

  return {
    from,
    idExpression,
    where: where.join(" AND "),
    parameters,
    orderBy,
    groupBy,
  };
}

function getCanonicalGenreStats({ sourceFilter, availableOnly }) {
  return getLibraryGenreStats({ sourceFilter, availableOnly });
}

async function getPageLibrary(kind, ids, sourceFilter, availableOnly, albumId = null) {
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const alias = kind === "artists" ? "artist" : kind === "albums" ? "album" : "track";
  const conditions = [`${alias}.id IN (${ids.map(() => "?").join(",")})`];
  const parameters = [...ids];
  if (sourceFilter) {
    conditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  if (availableOnly === true) conditions.push("media.available = 1");
  if (kind === "tracks" && albumId) {
    conditions.push("album.id = ?");
    parameters.push(Number(albumId));
  }
  const rows = await db.all(
    `${CANONICAL_SELECT}
     ${CANONICAL_FROM}
     WHERE ${conditions.join(" AND ")}
     ${canonicalOrder}`,
    parameters,
  );
  return buildLibraryFromRows(rows);
}

function buildAlbumTrackPageQuery(
  albumId,
  sourceFilter,
  { query = "", genre = "", sort = "album", direction = "asc", artistId = null } = {},
) {
  const conditions = ["album.id = ?"];
  const parameters = [];
  const mediaConditions = [
    "media.track_id = track.id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId));
  if (artistId) {
    conditions.push("artist.id = ?");
    parameters.push(Number(artistId));
  }
  if (query) {
    const pattern = likePattern(query);
    conditions.push(`(${[
      "track.title",
      "track.artist_name",
      "album.title",
      "album.album_artist",
      "artist.name",
    ].map((field) => `lower(coalesce(${field}, '')) LIKE ?`).join(" OR ")})`);
    parameters.push(...["track.title", "track.artist_name", "album.title", "album.album_artist", "artist.name"]
      .map(() => pattern));
  }
  if (genre) {
    const predicate = genrePredicate("track", ["artist", "album", "track"], genre);
    conditions.push(predicate.sql);
    parameters.push(...predicate.parameters);
  }
  const orderDirection = direction === "desc" ? "DESC" : "ASC";
  const orderBy = sort === "album"
    ? "min(album_track.disc_number) ASC, min(album_track.track_number) ASC"
    : sort === "newest"
      ? recentMediaOrder("tracks", sourceFilter, false, direction)
    : sort === "artist"
      ? `min(lower(artist.name)) ${orderDirection}, lower(track.title) ${orderDirection}`
      : `lower(track.title) ${orderDirection}`;
  return {
    from: `FROM library_tracks AS track
      JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
      JOIN library_albums AS album ON album.id = album_track.album_id
      JOIN library_artists AS artist ON artist.id = album.artist_id
      LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}`,
    where: conditions.join(" AND "),
    parameters,
    orderBy,
  };
}

async function getAlbumTrackSummary(albumId, sourceFilter) {
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId));
  const row = await db.get(
    `SELECT
       artist.id AS artist_id,
       artist.identity_key AS artist_identity_key,
       artist.mbid AS artist_mbid,
       artist.name AS artist_name,
       artist.sort_name AS artist_sort_name,
       artist.metadata_json AS artist_metadata_json,
       album.id AS album_id,
       album.identity_key AS album_identity_key,
       album.mbid AS album_mbid,
       album.release_group_mbid AS album_release_group_mbid,
       album.title AS album_title,
       album.album_artist AS album_artist,
       album.release_date AS album_release_date,
       album.metadata_json AS album_metadata_json,
       string_agg(DISTINCT media.source, ',') AS sources,
       MAX(media.available) AS available
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     JOIN library_album_tracks AS album_track ON album_track.album_id = album.id
     LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id = ?
     GROUP BY album.id, artist.id`,
    parameters,
  );
  if (!row) return { artist: null, album: null };
  const sources = parseSources(row.sources);
  return {
    artist: {
      id: row.artist_id,
      identityKey: row.artist_identity_key,
      mbid: row.artist_mbid,
      name: row.artist_name,
      sortName: row.artist_sort_name,
      metadata: parseJson(row.artist_metadata_json),
      albumIds: [row.album_id],
      sources,
      available: Boolean(row.available),
    },
    album: {
      id: row.album_id,
      identityKey: row.album_identity_key,
      mbid: row.album_mbid,
      releaseGroupMbid: row.album_release_group_mbid,
      artistId: row.artist_id,
      title: row.album_title,
      albumArtist: row.album_artist,
      releaseDate: row.album_release_date,
      metadata: parseJson(row.album_metadata_json),
      trackIds: [],
      sources,
      available: Boolean(row.available),
    },
  };
}

async function getAlbumTrackPageLibrary(albumId, sourceFilter, ids) {
  if (!ids.length) return { artists: [], albums: [], tracks: [] };
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  const parameters = [];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(Number(albumId), ...ids);
  const rows = await db.all(
    `${CANONICAL_SELECT}
     FROM library_tracks AS track
     JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     JOIN library_albums AS album ON album.id = album_track.album_id
     JOIN library_artists AS artist ON artist.id = album.artist_id
     LEFT JOIN library_media_files AS media ON ${mediaConditions.join(" AND ")}
     WHERE album.id = ? AND track.id IN (${ids.map(() => "?").join(",")})
     ORDER BY album_track.disc_number, album_track.track_number,
       lower(track.title), lower(media.path)`,
    parameters,
  );
  return buildLibraryFromRows(rows);
}

async function getAlbumTrackPage(albumId, sourceFilter, page, currentPageSize, options = {}) {
  const queryDefinition = buildAlbumTrackPageQuery(albumId, sourceFilter, options);
  const total = Number((await db.get(
    `SELECT COUNT(DISTINCT track.id) AS total
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}`,
    queryDefinition.parameters,
  ))?.total || 0);
  const pageIds = (await db.all(
    `SELECT track.id AS page_id
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}
     GROUP BY track.id
     ORDER BY ${queryDefinition.orderBy}, min(album_track.disc_number), min(album_track.track_number),
       min(lower(media.path))
     LIMIT ? OFFSET ?`,
    [
      ...queryDefinition.parameters,
      currentPageSize,
      (page - 1) * currentPageSize,
    ],
  )).map((row) => row.page_id);
  const library = await getAlbumTrackPageLibrary(albumId, sourceFilter, pageIds);
  const tracksById = new Map(library.tracks.map((track) => [track.id, track]));
  const pageItems = pageIds.map((id) => tracksById.get(id)).filter(Boolean);
  const summary = await getAlbumTrackSummary(albumId, sourceFilter);
  const stats = (await getAlbumStats([Number(albumId)], sourceFilter)).get(String(albumId));
  const album = summary.album;
  const albums = album
    ? [{
        ...album,
        trackIds: pageItems.map((track) => track.id),
        trackCount: total,
        availableTrackCount: stats?.availableTrackCount ?? 0,
      }]
    : [];
  return {
    kind: "tracks",
    page,
    pageSize: currentPageSize,
    total,
    hasMore: page * currentPageSize < total,
    items: pageItems,
    artists: summary.artist ? [summary.artist] : [],
    albums,
    tracks: pageItems,
    genres: await getCanonicalGenreStats({ sourceFilter, availableOnly: false }),
  };
}

async function getAlbumStats(albumIds, sourceFilter) {
  if (!albumIds.length) return new Map();
  const conditions = [`album_track.album_id IN (${albumIds.map(() => "?").join(",")})`];
  const parameters = [];
  const mediaConditions = [
    "media.track_id = album_track.track_id",
    albumMediaCondition("media", "album_track"),
  ];
  if (sourceFilter) {
    mediaConditions.push("media.source = ?");
    parameters.push(sourceFilter);
  }
  parameters.push(...albumIds);
  const rows = await db.all(
    `SELECT
       album_track.album_id AS album_id,
       COUNT(DISTINCT album_track.track_id) AS track_count,
       COUNT(DISTINCT CASE WHEN media.available = 1 THEN album_track.track_id END) AS available_track_count
     FROM library_album_tracks AS album_track
     LEFT JOIN library_media_files AS media
       ON ${mediaConditions.join(" AND ")}
     WHERE ${conditions.join(" AND ")}
     GROUP BY album_track.album_id`,
    parameters,
  );
  return new Map(rows.map((row) => [String(row.album_id), {
    trackCount: Number(row.track_count),
    availableTrackCount: Number(row.available_track_count),
  }]));
}

export async function getCanonicalLibraryPage({
  source = null,
  availableOnly = false,
  kind = "albums",
  page = 1,
  pageSize: requestedPageSize = DEFAULT_PAGE_SIZE,
  offset = null,
  query = "",
  genre = "",
  sort = null,
  direction = "asc",
  artistId = null,
  albumId = null,
} = {}) {
  const normalizedKind = text(kind).toLocaleLowerCase();
  if (!PAGE_KINDS.has(normalizedKind)) {
    throw new Error(`Unsupported library page kind: ${normalizedKind}`);
  }
  const sourceFilter = normalizeSource(source);
  const normalizedQuery = text(query).toLocaleLowerCase();
  const normalizedGenre = text(genre);
  const normalizedDirection = text(direction).toLocaleLowerCase();
  const normalizedSort =
    text(sort).toLocaleLowerCase() ||
    (normalizedKind === "tracks" && albumId ? "album" : "name");
  const currentPage = pageNumber(page);
  const currentPageSize = pageSize(
    requestedPageSize,
    normalizedKind === "artists" ? MAX_ARTIST_PROJECTION_PAGE_SIZE : MAX_PAGE_SIZE,
  );
  const currentOffset = offset == null
    ? (currentPage - 1) * currentPageSize
    : Math.max(0, Number.parseInt(offset, 10) || 0);

  if (normalizedKind === "genres") {
    const genres = await getCanonicalGenreStats({ sourceFilter, availableOnly });
    let collection = genres;
    if (normalizedQuery) {
      collection = collection.filter((entry) =>
        entry.name.toLocaleLowerCase().includes(normalizedQuery),
      );
    }
    if (normalizedDirection === "desc") collection = [...collection].reverse();
    const total = collection.length;
    const items = collection.slice(
      (currentPage - 1) * currentPageSize,
      currentPage * currentPageSize,
    );
    return {
      kind: normalizedKind,
      page: currentPage,
      pageSize: currentPageSize,
      total,
      hasMore: currentPage * currentPageSize < total,
      items,
      artists: [],
      albums: [],
      tracks: [],
      genres,
    };
  }

  if (normalizedKind === "tracks" && albumId && availableOnly !== true) {
    return getAlbumTrackPage(albumId, sourceFilter, currentPage, currentPageSize, {
      query: normalizedQuery,
      genre: normalizedGenre,
      sort: normalizedSort,
      direction: normalizedDirection,
      artistId,
    });
  }

  const queryDefinition = buildPageQuery({
    kind: normalizedKind,
    sourceFilter,
    availableOnly,
    query: normalizedQuery,
    genre: normalizedGenre,
    sort: normalizedSort,
    direction: normalizedDirection,
    artistId,
    albumId,
  });
  const total = Number((await db.get(
    `SELECT COUNT(DISTINCT ${queryDefinition.idExpression}) AS total
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}`,
    queryDefinition.parameters,
  ))?.total || 0);
  const ids = (await db.all(
    `SELECT ${queryDefinition.idExpression} AS page_id
     ${queryDefinition.from}
     WHERE ${queryDefinition.where}
     ${queryDefinition.groupBy ? `GROUP BY ${queryDefinition.groupBy}` : ""}
     ORDER BY ${queryDefinition.orderBy}
     LIMIT ? OFFSET ?`,
    [
      ...queryDefinition.parameters,
      currentPageSize,
      currentOffset,
    ],
  )).map((row) => row.page_id);
  if (normalizedKind === "artists") {
    const library = await getCanonicalArtistPage({
      source: sourceFilter,
      availableOnly,
      artistIds: ids,
      includeStats: true,
    });
    const artistsById = new Map(library.artists.map((artist) => [String(artist.id), artist]));
    const items = ids.map((id) => artistsById.get(String(id))).filter(Boolean);
    return {
      kind: normalizedKind,
      page: currentPage,
      pageSize: currentPageSize,
      total,
      hasMore: currentPage * currentPageSize < total,
      items,
      artists: items,
      albums: [],
      tracks: [],
      genres: await getCanonicalGenreStats({ sourceFilter, availableOnly }),
    };
  }
  const library = await getPageLibrary(normalizedKind, ids, sourceFilter, availableOnly, albumId);
  const artistsById = new Map(library.artists.map((artist) => [String(artist.id), artist]));
  const albumsById = new Map(library.albums.map((album) => [String(album.id), album]));
  const albumStats = await getAlbumStats(
    library.albums.map((album) => album.id),
    sourceFilter,
  );
  const collection = ids
    .map((id) => library[normalizedKind].find((entity) => String(entity.id) === String(id)))
    .filter(Boolean);
  const withAlbumStats = (album) => {
    const stats = albumStats.get(String(album.id));
    return {
      ...album,
      trackCount: stats?.trackCount ?? album.trackIds.length,
      availableTrackCount: stats?.availableTrackCount ?? 0,
    };
  };
  const items = collection.map((entity) => normalizedKind === "albums" ? withAlbumStats(entity) : entity);

  const relatedAlbums = normalizedKind === "tracks"
    ? [...new Set(items.flatMap((track) =>
        track.albums.map((entry) => String(entry.albumId))))]
        .map((id) => albumsById.get(id))
        .filter(Boolean)
        .map(withAlbumStats)
    : normalizedKind === "albums" ? items : [];
  const relatedArtists = normalizedKind === "artists"
    ? items
    : relatedAlbums
      .map((album) => artistsById.get(String(album.artistId)))
      .filter(Boolean)
      .filter((artist, index, values) =>
        values.findIndex((candidate) => candidate.id === artist.id) === index,
      );

  return {
    kind: normalizedKind,
    page: currentPage,
    pageSize: currentPageSize,
    total,
    hasMore: currentPage * currentPageSize < total,
    items,
    artists: relatedArtists,
    albums: relatedAlbums,
    tracks: normalizedKind === "tracks" ? items : [],
    genres: await getCanonicalGenreStats({ sourceFilter, availableOnly }),
  };
}

// Recomputes the persisted genre snapshot on the calling task.
export async function rebuildCanonicalGenreStats() {
  await rebuildLibraryGenreSnapshot();
}

// `persistedGenres: true` means the library content changed: keep serving the
// stored genre snapshot and let the debounced background refresh replace it.
// `persistedGenres: false` only drops the in-memory mirror of that snapshot.
export function invalidateCanonicalLibraryCache({ persistedGenres = true } = {}) {
  libraryCache.clear();
  artistKeysCache = null;
  if (persistedGenres) scheduleLibraryGenreRefresh();
  else clearLibraryGenreMemoryCache();
}

export { normalizeSource };
