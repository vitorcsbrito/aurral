import { db } from "../config/database.js";

const normalize = (value) => String(value || "").trim().toLocaleLowerCase();

// Shorter needles cannot use the pg_trgm index, so they skip the prefilter.
export function getLibrarySearchMatch(value) {
  const query = normalize(value);
  return query.length >= 3 ? query : null;
}

// search_text is a generated column; only the three source columns are written.
const UPSERT_DOCUMENT_SQL = `INSERT INTO library_search_documents
    (entity_kind, entity_id, title, artist_name, album_name)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
    title = excluded.title,
    artist_name = excluded.artist_name,
    album_name = excluded.album_name
  WHERE library_search_documents.title IS DISTINCT FROM excluded.title
     OR library_search_documents.artist_name IS DISTINCT FROM excluded.artist_name
     OR library_search_documents.album_name IS DISTINCT FROM excluded.album_name`;

async function upsertSearchDocument(values) {
  return (await db.run(UPSERT_DOCUMENT_SQL, values)).changes > 0;
}

// Syncs the artist document only; returns whether it changed. Album and track
// documents carry the artist name too, so a change cascades (see
// syncLibrarySearchArtist, or the deferred batches in libraryMediaStore).
export async function syncLibrarySearchArtistDocument(artistId) {
  const artist = await db.get(
    "SELECT id, name FROM library_artists WHERE id = ?",
    [Number(artistId)],
  );
  if (!artist) return false;
  return upsertSearchDocument(["artist", artist.id, artist.name, "", ""]);
}

export async function libraryArtistAlbumIds(artistId) {
  const rows = await db.all(
    "SELECT id FROM library_albums WHERE artist_id = ?",
    [Number(artistId)],
  );
  return rows.map((row) => row.id);
}

export async function libraryAlbumTrackIds(albumId) {
  const rows = await db.all(
    "SELECT track_id FROM library_album_tracks WHERE album_id = ?",
    [Number(albumId)],
  );
  return rows.map((row) => row.track_id);
}

export async function syncLibrarySearchArtist(artistId) {
  if (!(await syncLibrarySearchArtistDocument(artistId))) return false;
  for (const albumId of await libraryArtistAlbumIds(artistId)) {
    await syncLibrarySearchAlbum(albumId);
    for (const trackId of await libraryAlbumTrackIds(albumId)) {
      await syncLibrarySearchTrack(trackId);
    }
  }
  return true;
}

export async function syncLibrarySearchAlbum(albumId) {
  const album = await db.get(
    `SELECT album.id, album.title, album.album_artist, artist.name AS artist_name
     FROM library_albums AS album
     JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE album.id = ?`,
    [Number(albumId)],
  );
  if (!album) return false;
  return upsertSearchDocument([
    "album",
    album.id,
    album.title,
    `${album.artist_name || ""} ${album.album_artist || ""}`.trim(),
    "",
  ]);
}

export async function syncLibrarySearchTrack(trackId) {
  const track = await db.get(
    `SELECT
       track.id,
       track.title,
       trim(coalesce(track.artist_name, '') || ' ' || coalesce(string_agg(DISTINCT artist.name, ','), '')) AS artist_name,
       trim(coalesce(string_agg(DISTINCT album.title, ','), '') || ' ' || coalesce(string_agg(DISTINCT album.album_artist, ','), '')) AS album_name
     FROM library_tracks AS track
     LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
     LEFT JOIN library_albums AS album ON album.id = album_track.album_id
     LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
     WHERE track.id = ?
     GROUP BY track.id`,
    [Number(trackId)],
  );
  if (!track) return false;
  return upsertSearchDocument([
    "track",
    track.id,
    track.title,
    track.artist_name || "",
    track.album_name || "",
  ]);
}

export async function removeLibrarySearchDocument(entityKind, entityId) {
  const result = await db.run(
    "DELETE FROM library_search_documents WHERE entity_kind = ? AND entity_id = ?",
    [String(entityKind || ""), Number(entityId)],
  );
  return result.changes > 0;
}

// Must mirror the sync functions above, or a healthy index reports gaps.
const EXPECTED_DOCUMENT_SQL = {
  artist: `SELECT entity.id,
      coalesce(entity.name, '') AS title,
      '' AS artist_name,
      '' AS album_name
    FROM library_artists AS entity`,
  album: `SELECT entity.id,
      coalesce(entity.title, '') AS title,
      trim(coalesce(artist.name, '') || ' ' || coalesce(entity.album_artist, '')) AS artist_name,
      '' AS album_name
    FROM library_albums AS entity
    JOIN library_artists AS artist ON artist.id = entity.artist_id`,
  track: `SELECT entity.id,
      coalesce(entity.title, '') AS title,
      trim(coalesce(entity.artist_name, '') || ' ' || coalesce(string_agg(DISTINCT artist.name, ','), '')) AS artist_name,
      trim(coalesce(string_agg(DISTINCT album.title, ','), '') || ' ' || coalesce(string_agg(DISTINCT album.album_artist, ','), '')) AS album_name
    FROM library_tracks AS entity
    LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = entity.id
    LEFT JOIN library_albums AS album ON album.id = album_track.album_id
    LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
    GROUP BY entity.id`,
};

// Repairs an index left inconsistent by a scan that died mid-sync.
export async function findLibrarySearchDocumentGaps() {
  const gaps = { artist: [], album: [], track: [] };
  const tables = { artist: "library_artists", album: "library_albums", track: "library_tracks" };
  // Seconds on a large library, so it stays outside any transaction.
  for (const [kind, table] of Object.entries(tables)) {
    await db.run(
      `DELETE FROM library_search_documents
       WHERE entity_kind = ?
         AND NOT EXISTS (
           SELECT 1 FROM ${table} AS entity
           WHERE entity.id = library_search_documents.entity_id
         )`,
      [kind],
    );
    const rows = await db.all(
      `SELECT expected.id
       FROM (${EXPECTED_DOCUMENT_SQL[kind]}) AS expected
       LEFT JOIN library_search_documents AS document
         ON document.entity_kind = ? AND document.entity_id = expected.id
       WHERE document.id IS NULL
          OR document.title IS DISTINCT FROM expected.title
          OR document.artist_name IS DISTINCT FROM expected.artist_name
          OR document.album_name IS DISTINCT FROM expected.album_name`,
      [kind],
    );
    gaps[kind] = rows.map((row) => row.id);
  }
  return gaps;
}

const POPULATE_DOCUMENTS_SQL = `
  INSERT INTO library_search_documents (entity_kind, entity_id, title, artist_name, album_name)
  SELECT 'artist', artist.id, artist.name, '', ''
  FROM library_artists AS artist;

  INSERT INTO library_search_documents (entity_kind, entity_id, title, artist_name, album_name)
  SELECT
    'album',
    album.id,
    album.title,
    trim(coalesce(artist.name, '') || ' ' || coalesce(album.album_artist, '')),
    ''
  FROM library_albums AS album
  JOIN library_artists AS artist ON artist.id = album.artist_id;

  INSERT INTO library_search_documents (entity_kind, entity_id, title, artist_name, album_name)
  SELECT
    'track',
    track.id,
    track.title,
    trim(coalesce(track.artist_name, '') || ' ' || coalesce(string_agg(DISTINCT artist.name, ','), '')),
    trim(coalesce(string_agg(DISTINCT album.title, ','), '') || ' ' || coalesce(string_agg(DISTINCT album.album_artist, ','), ''))
  FROM library_tracks AS track
  LEFT JOIN library_album_tracks AS album_track ON album_track.track_id = track.id
  LEFT JOIN library_albums AS album ON album.id = album_track.album_id
  LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
  GROUP BY track.id;
`;

export async function populateLibrarySearchDocuments() {
  await db.exec(POPULATE_DOCUMENTS_SQL);
}

export async function rebuildLibrarySearchIndex() {
  await db.transaction(async () => {
    await db.run("DELETE FROM library_search_documents");
    await populateLibrarySearchDocuments();
  });
  return true;
}
