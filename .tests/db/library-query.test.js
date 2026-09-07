import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../../backend/config/database.js";
import { migrateDatabase } from "../../backend/db/pg/schema.js";
import {
  getCanonicalAlbumPage,
  getCanonicalAlbumsByReleaseDate,
  getCanonicalArtistKeys,
  getCanonicalArtistMbids,
  getCanonicalArtistPage,
  getCanonicalArtistProjection,
  getCanonicalArtistProjectionQueryPlan,
  getCanonicalFavoriteTargetKeys,
  getCanonicalGenres,
  getCanonicalLibrary,
  getCanonicalLibraryForAlbumReferences,
  getCanonicalLibraryForArtistReferences,
  getCanonicalLibraryPage,
  getCanonicalSearchPage,
  getCanonicalTrackCount,
  getCanonicalTrackOwnership,
  getCanonicalTrackPage,
  getCanonicalTrackPath,
  getCanonicalTrackSample,
  invalidateCanonicalLibraryCache,
} from "../../backend/services/libraryQueryService.js";
import {
  findLibrarySearchDocumentGaps,
  rebuildLibrarySearchIndex,
  syncLibrarySearchTrack,
} from "../../backend/services/librarySearchIndex.js";

// Keeps the debounced genre refresh from arming a timer during the run.
process.env.NODE_ENV = "test";

const ARTIST_NAME = "Aphex Twin";
const ALBUM_TITLE = "Selected Ambient Works";
const TRACK_TITLES = ["Xtal", "Tha"];

let artistId;
let albumId;
const trackIds = [];

const insert = async (sql, params) => (await db.get(sql, params)).id;

test.before(async () => {
  await migrateDatabase(db, { logger: {} });
  for (const table of [
    "library_search_documents",
    "library_media_files",
    "library_album_tracks",
    "library_tracks",
    "library_albums",
    "library_artists",
    "library_genres",
  ]) {
    await db.run(`DELETE FROM ${table}`);
  }
  await db.run("DELETE FROM settings WHERE key LIKE 'libraryGenre%'");

  const now = Date.now();
  artistId = await insert(
    `INSERT INTO library_artists
       (identity_key, mbid, name, sort_name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      "artist:aphex twin",
      "mb-artist-1",
      ARTIST_NAME,
      ARTIST_NAME,
      JSON.stringify({
        id: 41,
        foreignArtistId: "mb-artist-1",
        genres: ["Electronic"],
        librarySource: "lidarr",
        monitored: true,
      }),
      now,
      now,
    ],
  );
  albumId = await insert(
    `INSERT INTO library_albums
       (identity_key, mbid, release_group_mbid, artist_id, title, album_artist,
        release_date, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      "album:selected ambient works",
      "mb-album-1",
      "rg-album-1",
      artistId,
      ALBUM_TITLE,
      ARTIST_NAME,
      "1992-02-09",
      JSON.stringify({ id: 77, monitored: true, albumType: "Album" }),
      now,
      now,
    ],
  );
  for (const [index, title] of TRACK_TITLES.entries()) {
    const trackId = await insert(
      `INSERT INTO library_tracks
         (identity_key, mbid, title, artist_name, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        `track:${title.toLowerCase()}`,
        `mb-track-${index + 1}`,
        title,
        ARTIST_NAME,
        JSON.stringify({ genres: ["Ambient"] }),
        now,
        now,
      ],
    );
    trackIds.push(trackId);
    await db.run(
      `INSERT INTO library_album_tracks
         (album_id, track_id, disc_number, track_number, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [albumId, trackId, 1, index + 1, now],
    );
    await db.run(
      `INSERT INTO library_media_files
         (track_id, album_id, source, path, format, size, mtime_ms, duration_ms,
          quality_json, available, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trackId,
        albumId,
        "lidarr",
        `/music/aphex/${title}.flac`,
        "flac",
        1024 * (index + 1),
        now,
        300000,
        JSON.stringify({ tier: "lossless" }),
        1,
        now + index,
        now,
      ],
    );
  }

  const documents = [
    ["artist", artistId, ARTIST_NAME, "", ""],
    ["album", albumId, ALBUM_TITLE, ARTIST_NAME, ""],
    ...trackIds.map((trackId, index) => [
      "track",
      trackId,
      TRACK_TITLES[index],
      ARTIST_NAME,
      ALBUM_TITLE,
    ]),
  ];
  for (const document of documents) {
    await db.run(
      `INSERT INTO library_search_documents
         (entity_kind, entity_id, title, artist_name, album_name)
       VALUES (?, ?, ?, ?, ?)`,
      document,
    );
  }
  invalidateCanonicalLibraryCache({ persistedGenres: false });
});

test("artist listing pages return identity and stats", async () => {
  const plain = await getCanonicalArtistPage({ source: "all", availableOnly: false });
  assert.deepEqual(plain.artists.map((artist) => artist.name), [ARTIST_NAME]);
  assert.equal(plain.artists[0].albumCount, 1);

  const withStats = await getCanonicalArtistPage({
    source: "all",
    availableOnly: true,
    includeStats: true,
  });
  assert.equal(withStats.artists[0].trackCount, 2);
  assert.deepEqual(withStats.artists[0].sources, ["lidarr"]);
  assert.equal(withStats.artists[0].sizeOnDisk, 1024 + 2048);

  const keys = await getCanonicalArtistKeys();
  assert.equal(keys[0].mbid, "mb-artist-1");
  assert.equal(keys[0].foreignArtistId, "mb-artist-1");

  const projection = await getCanonicalArtistProjection({ page: 1, pageSize: 10 });
  assert.equal(projection[0].providerId, "41");
  assert.equal(projection[0].statistics.trackCount, 2);
  assert.equal(projection[0].available, true);
});

test("album pages and album detail resolve tracks", async () => {
  const albumPage = await getCanonicalAlbumPage({ source: "all", availableOnly: false });
  assert.deepEqual(albumPage.albums.map((album) => album.title), [ALBUM_TITLE]);

  const byReference = await getCanonicalLibraryForAlbumReferences({
    source: "all",
    availableOnly: false,
    references: ["rg-album-1"],
  });
  assert.equal(byReference.albums.length, 1);
  assert.equal(byReference.albums[0].releaseGroupMbid, "rg-album-1");
  assert.deepEqual(byReference.tracks.map((track) => track.title).sort(), ["Tha", "Xtal"]);
  assert.equal(byReference.tracks[0].files.length, 1);

  const trackPage = await getCanonicalLibraryPage({
    source: "all",
    kind: "tracks",
    albumId,
    pageSize: 10,
  });
  assert.equal(trackPage.total, 2);
  assert.deepEqual(trackPage.items.map((track) => track.title), TRACK_TITLES);
  assert.equal(trackPage.albums[0].trackCount, 2);
  assert.equal(trackPage.albums[0].availableTrackCount, 2);
  assert.equal(trackPage.artists[0].name, ARTIST_NAME);
});

test("search uses the trigram document index and the plain fallback", async () => {
  const indexed = await getCanonicalSearchPage({
    source: "all",
    availableOnly: false,
    query: "aphex",
  });
  assert.deepEqual(indexed.artists.map((artist) => artist.name), [ARTIST_NAME]);
  assert.deepEqual(indexed.albums.albums.map((album) => album.title), [ALBUM_TITLE]);
  assert.equal(indexed.tracks.tracks.length, 2);

  // Under three characters there is no trigram prefilter; the columns are scanned.
  const fallback = await getCanonicalSearchPage({
    source: "all",
    availableOnly: false,
    query: "ap",
  });
  assert.deepEqual(fallback.artists.map((artist) => artist.name), [ARTIST_NAME]);

  const miss = await getCanonicalSearchPage({
    source: "all",
    availableOnly: false,
    query: "nothing here",
  });
  assert.deepEqual(miss.artists, []);
  assert.deepEqual(miss.albums.albums, []);
  assert.deepEqual(miss.tracks.tracks, []);
});

test("genres come from the trigger-maintained table", async () => {
  const genres = await getCanonicalGenres({ source: "all", availableOnly: false });
  const names = genres.map((genre) => genre.value).sort();
  assert.deepEqual(names, ["Ambient", "Electronic"]);

  const page = await getCanonicalLibraryPage({ source: "all", kind: "genres", pageSize: 10 });
  const electronic = page.items.find((entry) => entry.name === "Electronic");
  assert.equal(electronic.artists, 1);
  assert.equal(electronic.albums, 0);
});

test("track path and ownership resolve through media rows", async () => {
  const path = await getCanonicalTrackPath(albumId, trackIds[0]);
  assert.equal(path, "/music/aphex/Xtal.flac");

  assert.equal(
    await getCanonicalTrackOwnership({ trackMbid: "mb-track-2", source: "lidarr" }),
    true,
  );
  assert.equal(
    await getCanonicalTrackOwnership({ artistName: ARTIST_NAME, trackName: "Xtal" }),
    true,
  );
  assert.equal(
    await getCanonicalTrackOwnership({ artistName: ARTIST_NAME, trackName: "Missing" }),
    false,
  );
});

test("every library page sort and filter combination runs", async () => {
  for (const kind of ["artists", "albums", "tracks"]) {
    for (const sort of ["name", "artist", "newest"]) {
      for (const direction of ["asc", "desc"]) {
        const page = await getCanonicalLibraryPage({
          source: "all",
          kind,
          sort,
          direction,
          pageSize: 10,
        });
        assert.ok(page.total > 0, `${kind}/${sort}/${direction} returned nothing`);
        assert.ok(page.items.length > 0);
      }
    }
    const filtered = await getCanonicalLibraryPage({
      source: "lidarr",
      availableOnly: true,
      kind,
      sort: "newest",
      genre: "Electronic",
      query: "aphex",
      pageSize: 10,
    });
    assert.ok(filtered.total > 0, `${kind} filtered page returned nothing`);
  }
});

test("album page order types run against Postgres", async () => {
  for (const type of [
    "alphabeticalByName",
    "alphabeticalByArtist",
    "newest",
    "recent",
    "byGenre",
    "random",
  ]) {
    const page = await getCanonicalAlbumPage({ source: "all", type, limit: 10 });
    assert.equal(page.albums.length, 1, `type ${type} returned ${page.albums.length} albums`);
  }
  const byYear = await getCanonicalAlbumPage({
    source: "all",
    type: "byYear",
    fromYear: 1990,
    toYear: 1995,
    limit: 10,
  });
  assert.equal(byYear.albums.length, 1);
  const outOfRange = await getCanonicalAlbumPage({
    source: "all",
    type: "byYear",
    fromYear: 2020,
    toYear: 2021,
    limit: 10,
  });
  assert.equal(outOfRange.albums.length, 0);
  const genreFiltered = await getCanonicalAlbumPage({
    source: "lidarr",
    availableOnly: true,
    genre: "electronic",
    limit: 10,
  });
  assert.equal(genreFiltered.albums.length, 1);
});

test("track pages support artist, genre and random selection", async () => {
  const byArtist = await getCanonicalTrackPage({ source: "all", artist: ARTIST_NAME, limit: 10 });
  assert.equal(byArtist.tracks.length, 2);

  const byGenre = await getCanonicalTrackPage({ source: "all", genre: "ambient", limit: 10 });
  assert.equal(byGenre.tracks.length, 2);

  const random = await getCanonicalTrackPage({
    source: "all",
    availableOnly: true,
    random: true,
    limit: 2,
  });
  assert.equal(random.tracks.length, 2);

  assert.equal(await getCanonicalTrackCount({ availableOnly: true }), 2);
  const sample = await getCanonicalTrackSample({ availableOnly: true, limit: 10 });
  assert.equal(sample.tracks.length, 2);
});

test("release-date albums honour artist and missing filters", async () => {
  const inWindow = await getCanonicalAlbumsByReleaseDate({
    from: "1992-01-01",
    to: "1992-12-31",
  });
  assert.equal(inWindow.length, 1);
  assert.equal(inWindow[0].trackCount, 2);
  assert.equal(inWindow[0].availableTrackCount, 2);
  assert.equal(inWindow[0].providerId, "77");

  const scopedToArtist = await getCanonicalAlbumsByReleaseDate({
    from: "1992-01-01",
    artistIds: [artistId],
  });
  assert.equal(scopedToArtist.length, 1);
  assert.deepEqual(
    await getCanonicalAlbumsByReleaseDate({ from: "1992-01-01", artistIds: [artistId + 9999] }),
    [],
  );
  assert.deepEqual(
    await getCanonicalAlbumsByReleaseDate({ from: "1992-01-01", missingOnly: true }),
    [],
  );
});

test("references resolve by id, mbid, provider id and name", async () => {
  for (const reference of [
    String(artistId),
    "mb-artist-1",
    "artist:aphex twin",
    "41",
    "APHEX TWIN",
  ]) {
    const projection = await getCanonicalArtistProjection({ reference });
    assert.equal(projection.length, 1, `reference ${reference} did not resolve`);
  }
  assert.deepEqual(await getCanonicalArtistProjection({ reference: "not-a-reference" }), []);

  const byReference = await getCanonicalLibraryForArtistReferences({
    source: "all",
    references: ["mb-artist-1"],
  });
  assert.equal(byReference.artists.length, 1);
  assert.equal(byReference.tracks.length, 2);

  const mbids = await getCanonicalArtistMbids({ source: "all", mbids: ["mb-artist-1", "other"] });
  assert.deepEqual([...mbids], ["mb-artist-1"]);

  const plan = await getCanonicalArtistProjectionQueryPlan({ page: 1, pageSize: 5 });
  assert.ok(plan.length > 0);
});

test("full library and favourite lookups round-trip", async () => {
  invalidateCanonicalLibraryCache({ persistedGenres: false });
  const library = await getCanonicalLibrary({ source: "all" });
  assert.equal(library.artists.length, 1);
  assert.equal(library.albums.length, 1);
  assert.equal(library.tracks.length, 2);

  const favouriteId = `artist:${encodeURIComponent("artist:aphex twin")}`;
  const found = await getCanonicalFavoriteTargetKeys([favouriteId, "album:missing"]);
  assert.ok(found.has(favouriteId));
  assert.equal(found.size, 1);

  const scoped = await getCanonicalLibrary({
    favoriteKeys: [{ kind: "album", key: "album:selected ambient works" }],
  });
  assert.equal(scoped.tracks.length, 2);
});

test("the search index rebuild agrees with the gap detector", async () => {
  assert.equal(await syncLibrarySearchTrack(trackIds[0]), true);
  assert.equal(await rebuildLibrarySearchIndex(), true);
  const gaps = await findLibrarySearchDocumentGaps();
  assert.deepEqual(gaps, { artist: [], album: [], track: [] });

  const stillSearchable = await getCanonicalSearchPage({ source: "all", query: "ambient" });
  assert.equal(stillSearchable.albums.albums.length, 1);
});
