import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState] = await setupIsolatedBackend("genre-cache");
const { db } = await import("../../backend/config/database.js");
const genreCache = await importFromRepo("backend/services/libraryGenreCache.js");
const { GENRE_STATS_SETTING_PREFIX } = genreCache;

const NOW = 1_700_000_000_000;

// Genre stats only count entities that have media.
const seedSource = async (source, genre) => {
  const artistId = (
    await db.get(
      `INSERT INTO library_artists (identity_key, name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [`artist:${source}`, `${source} Artist`, JSON.stringify({ genres: [genre] }), NOW, NOW],
    )
  ).id;
  const albumId = (
    await db.get(
      `INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [`album:${source}`, artistId, `${source} Album`, JSON.stringify({ genres: [genre] }), NOW, NOW],
    )
  ).id;
  const trackId = (
    await db.get(
      `INSERT INTO library_tracks (identity_key, title, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [`track:${source}`, `${source} Track`, JSON.stringify({ tags: { genre: [genre] } }), NOW, NOW],
    )
  ).id;
  await db.run(
    `INSERT INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at)
     VALUES (?, ?, 1, 1, ?)`,
    [albumId, trackId, NOW],
  );
  await db.run(
    `INSERT INTO library_media_files (track_id, album_id, source, path, available, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [trackId, albumId, source, `/music/${source}.flac`, NOW, NOW],
  );
};

test.before(async () => {
  await resetDatabase();
  await db.run("DELETE FROM library_genres");
  await db.run("DELETE FROM settings WHERE key LIKE 'libraryGenre%'");
  genreCache.clearLibraryGenreMemoryCache();
  await seedSource("lidarr", "Rock");
  await seedSource("aurral", "Jazz");
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

const genreNames = (stats) => stats.map((entry) => entry.genre ?? entry.name).sort();

test("source-filtered genre stats are computed once and dropped with the next snapshot", async () => {
  await genreCache.rebuildLibraryGenreSnapshot();
  const all = await genreCache.getLibraryGenreStats();
  assert.deepEqual(genreNames(all), ["Jazz", "Rock"]);

  const filtered = await genreCache.getLibraryGenreStats({ sourceFilter: "lidarr" });
  assert.deepEqual(genreNames(filtered), ["Rock"]);
  // Memoized: the same array comes back, and nothing was persisted for it.
  assert.equal(await genreCache.getLibraryGenreStats({ sourceFilter: "lidarr" }), filtered);
  const storedKeys = (
    await db.all("SELECT key FROM settings WHERE key LIKE ?", [
      `${GENRE_STATS_SETTING_PREFIX}%`,
    ])
  ).map((row) => row.key);
  assert.equal(storedKeys.some((key) => key.includes("lidarr")), false);

  // The next snapshot drops the memo so it is recomputed.
  await db.run(
    "UPDATE library_artists SET metadata_json = ? WHERE identity_key = 'artist:lidarr'",
    [JSON.stringify({ genres: ["Metal"] })],
  );
  assert.equal(await genreCache.getLibraryGenreStats({ sourceFilter: "lidarr" }), filtered);
  await genreCache.rebuildLibraryGenreSnapshot();
  // Album and track keep "Rock"; only the artist row moved to "Metal".
  assert.deepEqual(
    genreNames(await genreCache.getLibraryGenreStats({ sourceFilter: "lidarr" })),
    ["Metal", "Rock"],
  );
  assert.deepEqual(genreNames(await genreCache.getLibraryGenreStats()), [
    "Jazz",
    "Metal",
    "Rock",
  ]);
});
