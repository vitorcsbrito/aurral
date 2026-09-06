import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, queryService, libraryStore] = await setupIsolatedBackend(
  "measured-query-slice",
  "backend/services/libraryQueryService.js",
  "backend/services/libraryMediaStore.js",
);
const { db } = await import("../../backend/config/database.js");

const TRIGRAM_INDEX = "idx_library_search_documents_trgm";

let artist;
let album;
let track;

// Captures the read SQL and its bound parameters for plan checks.
const spyOnReads = (t) => {
  const calls = [];
  for (const method of ["all", "get"]) {
    const original = db[method].bind(db);
    t.mock.method(db, method, (sql, params) => {
      calls.push({ sql: String(sql), params: params || [] });
      return original(sql, params);
    });
  }
  return calls;
};

// The prefilter predicate the read path emits, planned on its own.
const explainPrefilter = async (needle) =>
  explain("SELECT id FROM library_search_documents WHERE search_text LIKE ?", [needle]);

const explain = async (sql, params) =>
  (
    await db.transaction(async () => {
      // On a fixture-sized table a seq scan always wins on cost.
      await db.exec("SET LOCAL enable_seqscan = off");
      return db.all(`EXPLAIN ${sql}`, params);
    })
  )
    .map((row) => row["QUERY PLAN"])
    .join("\n");

test.before(async () => {
  await resetDatabase();
  artist = await libraryStore.upsertLibraryArtist({
    identityKey: "measured:artist",
    name: "Measured Artist",
  });
  album = await libraryStore.upsertLibraryAlbum({
    identityKey: "measured:album",
    artistId: artist.id,
    title: "Measured Album",
    albumArtist: artist.name,
  });
  track = await libraryStore.upsertLibraryTrack({
    identityKey: "measured:track",
    title: "Needle Song",
    artistName: artist.name,
  });
  await libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  await libraryStore.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: "/tmp/measured-query-slice.flac",
  });
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("substring search uses the trigram index with stable pagination", async (t) => {
  const calls = spyOnReads(t);

  const result = await queryService.getCanonicalSearchPage({
    source: "all",
    query: "Needle",
    artistLimit: 20,
    albumLimit: 20,
    songLimit: 20,
  });
  assert.deepEqual(result.tracks.tracks.map((entry) => entry.title), ["Needle Song"]);
  const search = calls.find(
    ({ sql }) =>
      sql.includes("FROM library_tracks AS track") &&
      sql.includes("library_search_documents AS search_document"),
  );
  assert.ok(search);
  assert.match(search.sql, /search_document\.search_text LIKE \?/);
  assert.match(search.sql, /ORDER BY track\.id/);
  assert.match(await explainPrefilter("%needle%"), new RegExp(TRIGRAM_INDEX));
  assert.doesNotMatch(await explain(search.sql, search.params), /Seq Scan on library_search_documents/);
});

// xmin is the writing transaction id; untouched rows keep theirs.
const documentVersions = async () =>
  (
    await db.all("SELECT id, xmin::TEXT AS version FROM library_search_documents ORDER BY id")
  ).map((row) => `${row.id}:${row.version}`);

test("unchanged canonical upserts do not rewrite search documents", async () => {
  const before = await documentVersions();
  await libraryStore.upsertLibraryArtist({
    identityKey: "measured:artist",
    name: "Measured Artist",
  });
  await libraryStore.upsertLibraryAlbum({
    identityKey: "measured:album",
    artistId: artist.id,
    title: "Measured Album",
    albumArtist: artist.name,
  });
  await libraryStore.upsertLibraryTrack({
    identityKey: "measured:track",
    title: "Needle Song",
    artistName: artist.name,
  });
  assert.ok(before.length > 0);
  assert.deepEqual(await documentVersions(), before);
});

test("canonical page search uses the trigram index and genre reads use the stored snapshot", async (t) => {
  await queryService.rebuildCanonicalGenreStats();
  await queryService.invalidateCanonicalLibraryCache({ persistedGenres: false });
  const storedBefore = await db.all(
    "SELECT key, value FROM settings WHERE key LIKE 'libraryGenreStats:%' ORDER BY key",
  );
  const calls = spyOnReads(t);

  const page = await queryService.getCanonicalLibraryPage({
    kind: "tracks",
    page: 1,
    pageSize: 20,
    source: "lidarr",
    query: "Needle",
  });
  assert.deepEqual(page.tracks.map((entry) => entry.title), ["Needle Song"]);
  const pageSearch = calls.find(
    ({ sql }) =>
      sql.includes("COUNT(DISTINCT track.id)") &&
      sql.includes("search_document.search_text LIKE ?"),
  );
  assert.ok(pageSearch);
  const plan = await explain(pageSearch.sql, pageSearch.params);
  assert.match(await explainPrefilter("%needle%"), new RegExp(TRIGRAM_INDEX));
  assert.doesNotMatch(plan, /Seq Scan on library_search_documents/);
  assert.match(plan, /idx_library_media_files_track_/);
  assert.deepEqual(
    await db.all(
      "SELECT key, value FROM settings WHERE key LIKE 'libraryGenreStats:%' ORDER BY key",
    ),
    storedBefore,
  );
});

test("search documents update transactionally and random reads sample by id", async (t) => {
  await libraryStore.upsertLibraryTrack({
    identityKey: "measured:track",
    title: "Renamed Needle Song",
    artistName: artist.name,
  });
  assert.equal(
    (await queryService.getCanonicalSearchPage({ query: "Renamed Needle", songLimit: 20 }))
      .tracks.tracks[0].title,
    "Renamed Needle Song",
  );

  const calls = spyOnReads(t);
  t.mock.method(Math, "random", () => 0.999);
  const result = await queryService.getCanonicalTrackPage({
    source: "all",
    availableOnly: true,
    random: true,
    limit: 1,
  });
  assert.equal(result.tracks.length, 1);
  const random = calls.find(
    ({ sql }) => sql.includes("FROM library_tracks AS track") && sql.includes("track.id >= ?"),
  );
  assert.ok(random);
  assert.match(random.sql, /ORDER BY track\.id/);
  assert.doesNotMatch(random.sql, /random\(\)/i);
  assert.match(await explain(random.sql, random.params), /library_tracks_pkey/);
});

test("artist pages project a large discography without canonical row hydration", async (t) => {
  const key = `measured-artist-page-${process.pid}-${Date.now()}`;
  const pageArtist = await libraryStore.upsertLibraryArtist({
    identityKey: `${key}:artist`,
    name: "A Huge Discography",
  });
  const albumCount = 120;
  for (let index = 0; index < albumCount; index += 1) {
    const pageAlbum = await libraryStore.upsertLibraryAlbum({
      identityKey: `${key}:album:${index}`,
      artistId: pageArtist.id,
      title: `Huge Album ${index}`,
    });
    const pageTrack = await libraryStore.upsertLibraryTrack({
      identityKey: `${key}:track:${index}`,
      title: `Huge Track ${index}`,
      artistName: pageArtist.name,
    });
    await libraryStore.linkLibraryAlbumTrack({
      albumId: pageAlbum.id,
      trackId: pageTrack.id,
      trackNumber: 1,
    });
    await libraryStore.upsertLibraryMediaFile({
      trackId: pageTrack.id,
      albumId: pageAlbum.id,
      source: "aurral",
      path: `/tmp/${key}/${index}.flac`,
    });
  }

  const calls = spyOnReads(t);
  try {
    const page = await queryService.getCanonicalLibraryPage({
      source: "aurral",
      kind: "artists",
      page: 1,
      pageSize: 1,
    });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].albumCount, albumCount);
    assert.deepEqual(page.items[0].albumIds, []);
    assert.equal(
      calls.filter(
        ({ sql }) => sql.includes("track.id AS track_id") && sql.includes("media.id AS media_id"),
      ).length,
      0,
    );
  } finally {
    t.mock.restoreAll();
    await db.run("DELETE FROM library_media_files WHERE path LIKE ?", [`/tmp/${key}/%`]);
    await db.run(
      "DELETE FROM library_album_tracks WHERE album_id IN (SELECT id FROM library_albums WHERE identity_key LIKE ?)",
      [`${key}:album:%`],
    );
    await db.run("DELETE FROM library_tracks WHERE identity_key LIKE ?", [`${key}:track:%`]);
    await db.run("DELETE FROM library_albums WHERE identity_key LIKE ?", [`${key}:album:%`]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [pageArtist.id]);
  }
});

test("album track pages count and hydrate only the requested track slice", async (t) => {
  const key = `measured-album-page-${process.pid}-${Date.now()}`;
  const pageArtist = await libraryStore.upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid: `${key}:artist-mbid`,
    name: "A Huge Album",
  });
  const pageAlbum = await libraryStore.upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: `${key}:album-mbid`,
    releaseGroupMbid: `${key}:release-group`,
    artistId: pageArtist.id,
    title: "A Huge Album",
  });
  const trackCount = 140;
  for (let index = 0; index < trackCount; index += 1) {
    const pageTrack = await libraryStore.upsertLibraryTrack({
      identityKey: `${key}:track:${index}`,
      title: `Album Track ${String(index).padStart(3, "0")}`,
      artistName: pageArtist.name,
    });
    await libraryStore.linkLibraryAlbumTrack({
      albumId: pageAlbum.id,
      trackId: pageTrack.id,
      trackNumber: index + 1,
    });
    if (index % 2 === 0) {
      await libraryStore.upsertLibraryMediaFile({
        trackId: pageTrack.id,
        albumId: pageAlbum.id,
        source: "aurral",
        path: `/tmp/${key}/${index}.flac`,
      });
    }
  }

  const calls = spyOnReads(t);
  try {
    const page = await queryService.getCanonicalLibraryPage({
      source: "aurral",
      kind: "tracks",
      albumId: pageAlbum.id,
      page: 2,
      pageSize: 3,
      sort: "name",
      direction: "desc",
    });
    const hydration = calls.filter(
      ({ sql }) => sql.includes("track.id AS track_id") && sql.includes("media.id AS media_id"),
    );
    assert.equal(hydration.length, 1);
    assert.match(hydration[0].sql, /track\.id IN \(\?,\?,\?\)/);
    assert.equal(page.total, trackCount);
    assert.equal(page.items.length, 3);
    assert.equal(page.albums[0].trackCount, trackCount);
    assert.equal(page.albums[0].availableTrackCount, trackCount / 2);
    assert.equal(page.albums[0].trackIds.length, 3);
    assert.equal(page.albums[0].identityKey, `${key}:album`);
    assert.equal(page.artists[0].identityKey, `${key}:artist`);
    assert.ok(page.items.some((entry) => entry.files.length === 0));
    assert.ok(
      page.items.every((entry) =>
        entry.albums.every((relation) => relation.albumId === pageAlbum.id)),
    );
  } finally {
    t.mock.restoreAll();
    await db.run("DELETE FROM library_media_files WHERE path LIKE ?", [`/tmp/${key}/%`]);
    await db.run("DELETE FROM library_album_tracks WHERE album_id = ?", [pageAlbum.id]);
    await db.run("DELETE FROM library_tracks WHERE identity_key LIKE ?", [`${key}:track:%`]);
    await db.run("DELETE FROM library_albums WHERE id = ?", [pageAlbum.id]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [pageArtist.id]);
  }
});
