import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState] = await setupIsolatedBackend("derived-data");
const { db } = await import("../../backend/config/database.js");
const queryService = await importFromRepo("backend/services/libraryQueryService.js");
const genreCache = await importFromRepo("backend/services/libraryGenreCache.js");
const { computeLibraryGenreList, computeLibraryGenreStats } = genreCache;

const NOW = 1_700_000_000_000;

const genreRows = async (kind) =>
  (
    await db.all(
      "SELECT genre FROM library_genres WHERE entity_kind = ? ORDER BY genre",
      [kind],
    )
  ).map((row) => row.genre);

const recency = async (table, id) =>
  db.get(`SELECT latest_media_at, latest_available_media_at FROM ${table} WHERE id = ?`, [id]);

const insertId = async (sql, parameters) => (await db.get(sql, parameters)).id;

const seedLibrary = async () => {
  const artistId = await insertId(
    `INSERT INTO library_artists (identity_key, name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    ["artist:one", "Artist One", JSON.stringify({ genres: ["Rock", " Jazz "] }), NOW, NOW],
  );
  const albums = [];
  const fixtures = [
    ["Older Album", { genre: "Pop" }, NOW + 1_000],
    ["Newer Album", { genres: ["Blues"] }, NOW + 5_000],
    ["Silent Album", { genres: ["Ambient"] }, null],
  ];
  for (const [index, [title, metadata, mediaAt]] of fixtures.entries()) {
    const albumId = await insertId(
      `INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [`album:${index}`, artistId, title, JSON.stringify(metadata), NOW, NOW],
    );
    const trackId = await insertId(
      `INSERT INTO library_tracks (identity_key, title, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [
        `track:${index}`,
        `${title} Track`,
        JSON.stringify({ tags: { genre: ["Folk"] } }),
        NOW,
        NOW,
      ],
    );
    await db.run(
      `INSERT INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
       VALUES (?, ?, 1, ?, ?)`,
      [albumId, trackId, index + 1, NOW],
    );
    if (mediaAt !== null) {
      await db.run(
        `INSERT INTO library_media_files (track_id, album_id, source, path, available, created_at, updated_at)
         VALUES (?, ?, 'aurral', ?, 1, ?, ?)`,
        [trackId, albumId, `/music/${index}.flac`, mediaAt, mediaAt],
      );
    }
    albums.push({ albumId, trackId, title, mediaAt });
  }
  return { artistId, albums };
};

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test.beforeEach(async () => {
  await resetDatabase();
  await db.run("DELETE FROM library_genres");
  genreCache.clearLibraryGenreMemoryCache();
});

test("the migrated schema carries the derived columns, indexes, and triggers", async () => {
  const columns = async (table) =>
    (
      await db.all(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ?`,
        [table],
      )
    ).map((row) => row.column_name);

  for (const table of ["library_albums", "library_tracks"]) {
    const names = await columns(table);
    assert.ok(names.includes("latest_media_at"));
    assert.ok(names.includes("latest_available_media_at"));
  }
  assert.ok((await columns("library_genres")).includes("genre"));

  const indexes = (
    await db.all(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname LIKE 'idx_library_%latest%'
       ORDER BY indexname`,
    )
  ).map((row) => row.indexname);
  assert.deepEqual(indexes, [
    "idx_library_albums_latest_available_media_at",
    "idx_library_albums_latest_media_at",
    "idx_library_tracks_latest_available_media_at",
    "idx_library_tracks_latest_media_at",
  ]);

  const triggers = (
    await db.all(
      `SELECT trigger.tgname
       FROM pg_trigger AS trigger
       JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE NOT trigger.tgisinternal
         AND namespace.nspname = current_schema()
         AND (trigger.tgname LIKE '%_recency' OR trigger.tgname LIKE 'library_%_genres')
       ORDER BY trigger.tgname`,
    )
  ).map((row) => row.tgname);
  assert.deepEqual(triggers, [
    "library_album_tracks_recency",
    "library_albums_genres",
    "library_artists_genres",
    "library_media_files_recency",
    "library_tracks_genres",
  ]);
});

test("triggers keep genre membership in sync with metadata_json", async () => {
  const { artistId, albums } = await seedLibrary();
  assert.deepEqual(await genreRows("artist"), ["Jazz", "Rock"]);
  assert.deepEqual(await genreRows("album"), ["Ambient", "Blues", "Pop"]);
  assert.deepEqual(await genreRows("track"), ["Folk", "Folk", "Folk"]);

  await db.run("UPDATE library_artists SET metadata_json = ? WHERE id = ?", [
    JSON.stringify({ genres: ["Metal"] }),
    artistId,
  ]);
  assert.deepEqual(await genreRows("artist"), ["Metal"]);

  await db.run("UPDATE library_albums SET metadata_json = ? WHERE id = ?", [
    "not json",
    albums[0].albumId,
  ]);
  assert.deepEqual(await genreRows("album"), ["Ambient", "Blues"]);

  await db.run("DELETE FROM library_tracks WHERE id = ?", [albums[0].trackId]);
  assert.deepEqual(await genreRows("track"), ["Folk", "Folk"]);
});

test("triggers keep latest media timestamps in sync with media files", async () => {
  const { albums } = await seedLibrary();
  const [older, newer, silent] = albums;
  assert.deepEqual(await recency("library_albums", older.albumId), {
    latest_media_at: older.mediaAt,
    latest_available_media_at: older.mediaAt,
  });
  assert.deepEqual(await recency("library_tracks", newer.trackId), {
    latest_media_at: newer.mediaAt,
    latest_available_media_at: newer.mediaAt,
  });
  assert.deepEqual(await recency("library_albums", silent.albumId), {
    latest_media_at: 0,
    latest_available_media_at: 0,
  });

  await db.run("UPDATE library_media_files SET available = 0 WHERE track_id = ?", [
    newer.trackId,
  ]);
  assert.deepEqual(await recency("library_albums", newer.albumId), {
    latest_media_at: newer.mediaAt,
    latest_available_media_at: 0,
  });

  const laterAt = NOW + 9_000;
  await db.run(
    `INSERT INTO library_media_files (track_id, album_id, source, path, available, created_at, updated_at)
     VALUES (?, NULL, 'lidarr', '/lidarr/silent.flac', 1, ?, ?)`,
    [silent.trackId, laterAt, laterAt],
  );
  assert.deepEqual(await recency("library_albums", silent.albumId), {
    latest_media_at: laterAt,
    latest_available_media_at: laterAt,
  });

  await db.run("DELETE FROM library_media_files WHERE track_id = ?", [silent.trackId]);
  assert.deepEqual(await recency("library_albums", silent.albumId), {
    latest_media_at: 0,
    latest_available_media_at: 0,
  });

  await db.run("DELETE FROM library_album_tracks WHERE album_id = ?", [older.albumId]);
  assert.deepEqual(await recency("library_albums", older.albumId), {
    latest_media_at: 0,
    latest_available_media_at: 0,
  });
});

test("newest sort reads the indexed recency columns and matches media order", async () => {
  const { albums } = await seedLibrary();
  const plan = (
    await db.transaction(async () => {
      // On a fixture-sized table a seq scan always wins on cost.
      await db.exec("SET LOCAL enable_seqscan = off");
      return db.all(
        `EXPLAIN SELECT id FROM library_albums AS album
         ORDER BY album.latest_media_at DESC, lower(album.title) ASC LIMIT 10`,
      );
    })
  )
    .map((row) => row["QUERY PLAN"])
    .join("\n");
  assert.match(plan, /idx_library_albums_latest_media_at/);

  await queryService.invalidateCanonicalLibraryCache({ persistedGenres: false });
  // Entities without media sort last (timestamp 0).
  const page = await queryService.getCanonicalLibraryPage({
    kind: "albums",
    sort: "newest",
    pageSize: 10,
  });
  assert.deepEqual(
    page.items.map((album) => album.title),
    [albums[1].title, albums[0].title, albums[2].title],
  );
  const subsonic = await queryService.getCanonicalAlbumPage({ type: "newest", limit: 10 });
  assert.deepEqual(
    subsonic.albums.map((album) => album.title),
    [albums[1].title, albums[0].title, albums[2].title],
  );
  const tracks = await queryService.getCanonicalLibraryPage({
    kind: "tracks",
    sort: "newest",
    pageSize: 10,
  });
  assert.deepEqual(
    tracks.items.map((track) => track.title),
    [`${albums[1].title} Track`, `${albums[0].title} Track`, `${albums[2].title} Track`],
  );
});

test("genre filters and genre stats use the membership table", async () => {
  await seedLibrary();
  await queryService.invalidateCanonicalLibraryCache({ persistedGenres: false });

  const blues = await queryService.getCanonicalAlbumPage({ genre: "blues", limit: 10 });
  assert.deepEqual(blues.albums.map((album) => album.title), ["Newer Album"]);
  const rock = await queryService.getCanonicalLibraryPage({
    kind: "albums",
    genre: "ROCK",
    pageSize: 10,
  });
  assert.deepEqual(
    rock.items.map((album) => album.title).sort(),
    ["Newer Album", "Older Album", "Silent Album"],
  );

  const stats = await computeLibraryGenreStats({ availableOnly: false });
  const byName = Object.fromEntries(stats.map((entry) => [entry.name, entry]));
  assert.equal(byName.Rock.artists, 1);
  assert.equal(byName.Jazz.artists, 1);
  assert.equal(byName.Pop.albums, 1);
  assert.equal(byName.Ambient, undefined, "albums without media are excluded");
  assert.equal(byName.Folk.tracks, 2);

  const list = await computeLibraryGenreList();
  assert.deepEqual(
    list.map((entry) => entry.value),
    ["Blues", "Folk", "Jazz", "Pop", "Rock"],
  );
  const listByName = Object.fromEntries(list.map((entry) => [entry.value, entry]));
  assert.deepEqual(listByName.Rock, { value: "Rock", albumCount: 2, songCount: 2 });
  assert.deepEqual(listByName.Folk, { value: "Folk", albumCount: 2, songCount: 2 });
});
