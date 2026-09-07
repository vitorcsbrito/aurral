import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { db } from "../../backend/config/database.js";
import { ensureTestDatabase, reloadMirrors } from "../helpers/backendTestHarness.js";
import { scanMusicRoot } from "../../backend/services/libraryFileScanner.js";
import { indexLidarrLibrary } from "../../backend/services/libraryLidarrIndexer.js";
import {
  getCanonicalArtistMbids,
  getCanonicalLibrary,
  getCanonicalLibraryForAlbumReferences,
  getCanonicalLibraryForArtistReferences,
  getCanonicalLibraryForArtists,
  getCanonicalLibraryPage,
  getCanonicalTrack,
  getCanonicalTrackCount,
  getCanonicalTrackOwnership,
  getCanonicalTrackPath,
  getCanonicalTrackSample,
  invalidateCanonicalLibraryCache,
} from "../../backend/services/libraryQueryService.js";
import { toPublicLibrary } from "../../backend/routes/library/handlers/canonical.js";
import {
  buildCanonicalLibraryReadModel,
  getCanonicalLibraryReadModelForAlbumReferences,
} from "../../backend/services/canonicalLibraryReadAdapter.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryArtist,
  upsertLibraryAlbum,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";

test.before(async () => {
  await ensureTestDatabase();
  await reloadMirrors();
});

const explainPlan = async (sql, params) =>
  (await db.transaction(async () => {
    // On a fixture-sized table a seq scan always wins on cost.
    await db.exec("SET LOCAL enable_seqscan = off");
    return db.all(`EXPLAIN ${sql}`, params);
  })).map((row) => row["QUERY PLAN"]).join("\n");

const metadata = {
  common: {
    albumartist: "Query Fixture",
    artist: "Query Fixture",
    album: "Canonical Reads",
    title: "One Source, Two Files",
    track: { no: 1 },
    disk: { no: 1 },
    musicbrainz_albumartistid: "11111111-1111-4111-8111-111111111111",
    musicbrainz_releasegroupid: "22222222-2222-4222-8222-222222222222",
    musicbrainz_recordingid: "33333333-3333-4333-8333-333333333333",
  },
  format: { duration: 123.4, codec: "FLAC" },
};

async function createAudioFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "fixture");
  return filePath;
}

test("getCanonicalTrackPath keeps shared tracks scoped to the requested album", async () => {
  const key = `query-track-path-${process.pid}-${Date.now()}`;
  const artist = await upsertLibraryArtist({
    identityKey: `${key}:artist`,
    name: "Query Fixture",
  });
  const firstAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:album:first`,
    artistId: artist.id,
    title: "First Album",
  });
  const secondAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:album:second`,
    artistId: artist.id,
    title: "Second Album",
  });
  const fallbackAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:album:fallback`,
    artistId: artist.id,
    title: "Fallback Album",
  });
  const track = await upsertLibraryTrack({
    identityKey: key,
    mbid: `${key}-mbid`,
    title: "Direct Path",
    artistName: "Query Fixture",
  });
  await linkLibraryAlbumTrack({ albumId: firstAlbum.id, trackId: track.id });
  await linkLibraryAlbumTrack({ albumId: secondAlbum.id, trackId: track.id });
  await linkLibraryAlbumTrack({ albumId: fallbackAlbum.id, trackId: track.id });
  const firstPath = `/tmp/${key}-first.flac`;
  const secondPath = `/tmp/${key}-second.flac`;
  const fallbackPath = `/tmp/${key}-fallback.flac`;
  await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: firstAlbum.id,
    source: "lidarr",
    path: firstPath,
  });
  await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: secondAlbum.id,
    source: "lidarr",
    path: secondPath,
  });

  try {
    assert.equal(await getCanonicalTrackPath(firstAlbum.id, track.id), firstPath);
    assert.equal(await getCanonicalTrackPath(secondAlbum.identity_key, track.mbid), secondPath);
    assert.equal(await getCanonicalTrackPath(fallbackAlbum.id, track.id), null);
    await upsertLibraryMediaFile({ trackId: track.id, source: "aurral", path: fallbackPath });
    assert.equal(await getCanonicalTrackPath(fallbackAlbum.id, track.id), fallbackPath);
    assert.equal(await getCanonicalTrackPath(firstAlbum.id, track.id), firstPath);
  } finally {
    await db.run("DELETE FROM library_media_files WHERE track_id = ?", [track.id]);
    await db.run("DELETE FROM library_album_tracks WHERE track_id = ?", [track.id]);
    await db.run("DELETE FROM library_tracks WHERE id = ?", [track.id]);
    await db.run("DELETE FROM library_albums WHERE artist_id = ?", [artist.id]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [artist.id]);
  }
});

test("focused track, ownership, count, and sample queries stay bounded", async () => {
  const key = `query-focused-${process.pid}-${Date.now()}`;
  const artist = await upsertLibraryArtist({
    identityKey: `${key}:artist`,
    name: "Focused Artist",
  });
  const album = await upsertLibraryAlbum({
    identityKey: `${key}:album`,
    artistId: artist.id,
    title: "Focused Album",
  });
  const ownedTrack = await upsertLibraryTrack({
    identityKey: `${key}:owned`,
    mbid: `${key}-owned-mbid`,
    title: "Focused Track",
    artistName: artist.name,
  });
  const unavailableTrack = await upsertLibraryTrack({
    identityKey: `${key}:unavailable`,
    mbid: `${key}-unavailable-mbid`,
    title: "Unavailable Track",
    artistName: artist.name,
  });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: ownedTrack.id, trackNumber: 1 });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: unavailableTrack.id, trackNumber: 2 });
  const ownedPath = `/tmp/${key}/owned.flac`;
  const unavailablePath = `/tmp/${key}/unavailable.flac`;
  await upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: album.id,
    source: "aurral",
    path: ownedPath,
    available: true,
  });
  await upsertLibraryMediaFile({
    trackId: unavailableTrack.id,
    albumId: album.id,
    source: "aurral",
    path: unavailablePath,
    available: false,
  });

  try {
    const focused = await getCanonicalTrack({
      trackId: ownedTrack.id,
      source: "aurral",
      availableOnly: true,
      albumId: album.id,
    });
    assert.deepEqual(focused.tracks.map((track) => track.id), [ownedTrack.id]);
    assert.deepEqual(focused.albums.map((entry) => entry.id), [album.id]);
    assert.deepEqual(focused.tracks[0].files.map((file) => file.path), [ownedPath]);

    const stale = await getCanonicalTrack({
      trackId: unavailableTrack.id,
      source: "aurral",
      availableOnly: false,
    });
    assert.deepEqual(stale.tracks.map((track) => track.id), [unavailableTrack.id]);
    assert.equal(stale.tracks[0].files[0].available, false);

    assert.equal(
      await getCanonicalTrackOwnership({ trackMbid: ownedTrack.mbid }),
      true,
    );
    assert.equal(
      await getCanonicalTrackOwnership({ artistName: artist.name, trackName: ownedTrack.title }),
      true,
    );
    assert.equal(
      await getCanonicalTrackOwnership({ trackMbid: unavailableTrack.mbid }),
      false,
    );

    const countBefore = await getCanonicalTrackCount({ source: "aurral" });
    const availableCountBefore = await getCanonicalTrackCount({ source: "aurral", availableOnly: true });
    assert.equal(countBefore >= 2, true);
    assert.equal(availableCountBefore >= 1, true);
    const sample = await getCanonicalTrackSample({ source: "aurral", availableOnly: true, limit: 1 });
    assert.ok(sample.tracks.length <= 1);
  } finally {
    await db.run("DELETE FROM library_media_files WHERE path IN (?, ?)", [ownedPath, unavailablePath]);
    await db.run("DELETE FROM library_album_tracks WHERE album_id = ?", [album.id]);
    await db.run("DELETE FROM library_tracks WHERE id IN (?, ?)", [ownedTrack.id, unavailableTrack.id]);
    await db.run("DELETE FROM library_albums WHERE id = ?", [album.id]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [artist.id]);
    await invalidateCanonicalLibraryCache();
  }
});

test("getCanonicalLibrary merges sources and preserves normalized hierarchy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-query-"));
  const source = `query-aurral-${process.pid}`;
  let filePath;
  try {
    filePath = await createAudioFile(root, "Query Fixture/Canonical Reads/01 One Source, Two Files.flac");
    await scanMusicRoot({ rootPath: root, source, metadataReader: async () => metadata });

    await indexLidarrLibrary({
      client: {
        isConfigured: () => true,
        request: async () => [{ id: 7, artistName: "Query Fixture", foreignArtistId: metadata.common.musicbrainz_albumartistid }],
        getAllAlbums: async () => [{
          id: 8,
          artistId: 7,
          title: "Canonical Reads",
          foreignAlbumId: metadata.common.musicbrainz_releasegroupid,
          path: path.join(root, "Query Fixture", "Canonical Reads"),
        }],
        getTracksByAlbumId: async () => [{
          id: 9,
          albumId: 8,
          title: "One Source, Two Files",
          trackNumber: 1,
          foreignRecordingId: metadata.common.musicbrainz_recordingid,
          trackFileId: 10,
        }],
        getTrackFilesByAlbumId: async () => [{ id: 10, path: filePath, trackIds: [9] }],
        getRootFolders: async () => [{ path: root }],
      },
    });

    const all = await getCanonicalLibrary();
    assert.strictEqual(await getCanonicalLibrary(), all);
    assert.equal(all.artists.length, 1);
    assert.equal(all.albums.length, 1);
    assert.equal(all.tracks.length, 1);
    assert.deepEqual(all.tracks[0].sources, ["lidarr", source]);
    assert.equal(all.tracks[0].files.length, 2);
    assert.equal(all.albums[0].trackIds[0], all.tracks[0].id);
    assert.equal(all.artists[0].albumIds[0], all.albums[0].id);
    assert.equal(all.tracks[0].available, true);

    const lidarr = await getCanonicalLibrary({ source: "lidarr" });
    assert.equal(lidarr.tracks.length, 1);
    assert.deepEqual(lidarr.tracks[0].sources, ["lidarr"]);

    await db.run("UPDATE library_media_files SET available = 0 WHERE source = ? AND path = ?", ["lidarr",
      filePath]);
    const available = await getCanonicalLibrary({ availableOnly: true });
    assert.equal(available.tracks.length, 1);
    assert.deepEqual(available.tracks[0].sources, [source]);
    assert.equal(available.tracks[0].files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await db.run("DELETE FROM library_media_files WHERE source IN (?, ?) AND path = ?", [source,
      "lidarr",
      filePath]);
  }
});

test("getCanonicalLibrary deduplicates a file shared by multiple album relationships", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-library-query-duplicate-"));
  let filePath;
  let duplicateAlbumId;
  try {
    filePath = await createAudioFile(root, "Artist/Album/01 Track.flac");
    await scanMusicRoot({ rootPath: root, source: "aurral", metadataReader: async () => metadata });
    const first = await getCanonicalLibrary({ source: "aurral" });
    const track = first.tracks.find((entry) => entry.files.some((file) => file.path === filePath));
    const album = first.albums.find((entry) => entry.trackIds.includes(track.id));
    const duplicateAlbum = await upsertLibraryAlbum({
      identityKey: `duplicate-album:${process.pid}`,
      artistId: album.artistId,
      title: "Duplicate Relationship",
    });
    duplicateAlbumId = duplicateAlbum.id;
    await linkLibraryAlbumTrack({ albumId: duplicateAlbum.id, trackId: track.id, trackNumber: 1 });

    const result = await getCanonicalLibrary({ source: "aurral" });
    const resultTrack = result.tracks.find((entry) => entry.files.some((file) => file.path === filePath));
    assert.equal(resultTrack.files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (duplicateAlbumId) {
      await db.run("DELETE FROM library_album_tracks WHERE album_id = ?", [duplicateAlbumId]);
      await db.run("DELETE FROM library_albums WHERE id = ?", [duplicateAlbumId]);
    }
    await db.run("DELETE FROM library_media_files WHERE source = ? AND path = ?", ["aurral", filePath]);
  }
});

test("getCanonicalLibrary rejects unknown source filters", async () => {
  await assert.rejects(() => getCanonicalLibrary({ source: "plex" }), /Unsupported library source/);
});

test("scoped canonical reads keep ownership lookups off unrelated library records", async () => {
  const key = `query-scoped-${process.pid}-${Date.now()}`;
  const artist = await upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid: `${key}-artist`,
    name: "Scoped Artist",
  });
  const unrelatedArtist = await upsertLibraryArtist({
    identityKey: `${key}:unrelated-artist`,
    mbid: `${key}-unrelated-artist`,
    name: "Unrelated Artist",
  });
  const releaseGroupMbid = `${key}-release-group`;
  const album = await upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: `${key}-album`,
    releaseGroupMbid,
    artistId: artist.id,
    title: "Scoped Album",
  });
  const unrelatedAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:unrelated-album`,
    mbid: `${key}-unrelated-album`,
    artistId: unrelatedArtist.id,
    title: "Unrelated Album",
  });
  const ownedTrack = await upsertLibraryTrack({
    identityKey: `${key}:owned-track`,
    mbid: `${key}-owned-track`,
    title: "Owned Track",
    artistName: artist.name,
  });
  const missingTrack = await upsertLibraryTrack({
    identityKey: `${key}:missing-track`,
    mbid: `${key}-missing-track`,
    title: "Missing Track",
    artistName: artist.name,
  });
  const unrelatedTrack = await upsertLibraryTrack({
    identityKey: `${key}:unrelated-track`,
    mbid: `${key}-unrelated-track`,
    title: "Unrelated Track",
    artistName: unrelatedArtist.name,
  });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: ownedTrack.id, trackNumber: 1 });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: missingTrack.id, trackNumber: 2 });
  await linkLibraryAlbumTrack({ albumId: unrelatedAlbum.id, trackId: unrelatedTrack.id, trackNumber: 1 });
  const ownedPath = `/tmp/${key}/owned.flac`;
  await upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: album.id,
    source: "aurral",
    path: ownedPath,
  });
  const unrelatedPath = `/tmp/${key}/unrelated.flac`;
  await upsertLibraryMediaFile({
    trackId: unrelatedTrack.id,
    albumId: unrelatedAlbum.id,
    source: "aurral",
    path: unrelatedPath,
  });

  try {
    assert.deepEqual(
      [...(await getCanonicalArtistMbids({ source: "all", mbids: [artist.mbid] }))],
      [artist.mbid],
    );

    const artistLibrary = await getCanonicalLibraryForArtists({
      source: "all",
      availableOnly: false,
      mbids: [artist.mbid],
    });
    assert.deepEqual(artistLibrary.artists.map((entry) => entry.mbid), [artist.mbid]);
    assert.deepEqual(artistLibrary.albums.map((entry) => entry.mbid), [album.mbid]);

    const albumLibrary = await getCanonicalLibraryForAlbumReferences({
      source: "all",
      availableOnly: false,
      references: [releaseGroupMbid],
    });
    assert.deepEqual(albumLibrary.albums.map((entry) => entry.mbid), [album.mbid]);
    assert.deepEqual(
      albumLibrary.tracks.map((entry) => entry.mbid),
      [ownedTrack.mbid, missingTrack.mbid],
    );
  } finally {
    await db.run("DELETE FROM library_media_files WHERE path IN (?, ?)", [ownedPath, unrelatedPath]);
    await db.run("DELETE FROM library_album_tracks WHERE album_id IN (?, ?)", [album.id,
      unrelatedAlbum.id]);
    await db.run("DELETE FROM library_tracks WHERE id IN (?, ?, ?)", [ownedTrack.id,
      missingTrack.id,
      unrelatedTrack.id]);
    await db.run("DELETE FROM library_albums WHERE id IN (?, ?)", [album.id, unrelatedAlbum.id]);
    await db.run("DELETE FROM library_artists WHERE id IN (?, ?)", [artist.id,
      unrelatedArtist.id]);
    await invalidateCanonicalLibraryCache();
  }
});

test("artist and album reference reads resolve through indexed entity lookups", async (t) => {
  const key = `query-plan-${process.pid}-${Date.now()}`;
  const artist = await upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid: `${key}:artist-mbid`,
    name: "Query Plan Artist",
    metadata: {
      id: `${key}:provider-id`,
      foreignArtistId: `${key}:foreign-artist-id`,
    },
  });
  const album = await upsertLibraryAlbum({
    identityKey: `${key}:album`,
    mbid: `${key}:album-mbid`,
    releaseGroupMbid: `${key}:release-group`,
    artistId: artist.id,
    title: "Query Plan Album",
  });
  const track = await upsertLibraryTrack({ identityKey: `${key}:track`, title: "Plan Track" });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "lidarr",
    path: `/tmp/${key}.flac`,
  });
  const prepared = [];
  const spies = ["all", "get"].map((method) => {
    const original = db[method].bind(db);
    return t.mock.method(db, method, (sql, params) => {
      prepared.push(String(sql));
      return original(sql, params);
    });
  });
  const restoreSpies = () => spies.forEach((spy) => spy.mock.restore());

  try {
    assert.deepEqual(
      (await getCanonicalLibraryForArtistReferences({
        references: [
          artist.mbid,
          `${key}:provider-id`,
          `${key}:foreign-artist-id`,
          "QUERY PLAN ARTIST",
        ],
      })).artists.map(({ id }) => id),
      [artist.id],
    );
    assert.deepEqual(
      (await getCanonicalLibraryForAlbumReferences({ references: [album.release_group_mbid] })).albums.map(({ id }) => id),
      [album.id],
    );
    restoreSpies();

    const lookups = prepared.filter((sql) =>
      /^SELECT id FROM library_(artists|albums)/.test(sql.trim()),
    );
    assert.equal(lookups.length, 2);
    for (const sql of lookups) {
      const parameterCount = (sql.match(/\?/g) || []).length;
      const plan = await explainPlan(sql, Array.from({ length: parameterCount }, () => `${key}:missing`));
      assert.doesNotMatch(plan, /Seq Scan on library_(artists|albums)/);
      assert.match(plan, /Index (Only )?Scan|Bitmap Index Scan/);
    }
    const hydration = prepared.filter((sql) =>
      sql.includes("track.id AS track_id") && sql.includes("FROM library_tracks AS track"),
    );
    assert.ok(hydration.length > 0);
    assert.equal(hydration.every((sql) => /WHERE (artist|album)\.id IN/.test(sql)), true);
    for (const sql of hydration) {
      const parameterCount = (sql.match(/\?/g) || []).length;
      const plan = await explainPlan(sql, Array.from({ length: parameterCount }, () => artist.id));
      assert.doesNotMatch(plan, /Seq Scan on \w+ (album|album_track)\b/);
    }
  } finally {
    restoreSpies();
    await db.run("DELETE FROM library_media_files WHERE track_id = ?", [track.id]);
    await db.run("DELETE FROM library_album_tracks WHERE track_id = ?", [track.id]);
    await db.run("DELETE FROM library_tracks WHERE id = ?", [track.id]);
    await db.run("DELETE FROM library_albums WHERE id = ?", [album.id]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [artist.id]);
  }
});

test("album-reference reads preserve identity keys and album-specific ownership", async () => {
  const key = `query-album-ownership-${process.pid}-${Date.now()}`;
  const artist = await upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Shared Artist" });
  const ownedAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:owned-album`,
    artistId: artist.id,
    title: "Owned Album",
  });
  const missingAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:missing-album`,
    artistId: artist.id,
    title: "Missing Album",
  });
  const track = await upsertLibraryTrack({
    identityKey: `${key}:track`,
    mbid: `${key}-track`,
    title: "Shared Track",
    artistName: artist.name,
  });
  const missingAlbumTrack = await upsertLibraryTrack({
    identityKey: `${key}:missing-album-track`,
    mbid: `${key}-missing-album-track`,
    title: "Owned Only By Missing Album",
    artistName: artist.name,
  });
  await linkLibraryAlbumTrack({ albumId: ownedAlbum.id, trackId: track.id, trackNumber: 1 });
  await linkLibraryAlbumTrack({ albumId: missingAlbum.id, trackId: track.id, trackNumber: 1 });
  await linkLibraryAlbumTrack({
    albumId: missingAlbum.id,
    trackId: missingAlbumTrack.id,
    trackNumber: 2,
  });
  const ownedPath = `/tmp/${key}/owned.flac`;
  const missingAlbumPath = `/tmp/${key}/missing-album.flac`;
  await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: ownedAlbum.id,
    source: "aurral",
    path: ownedPath,
  });
  await upsertLibraryMediaFile({
    trackId: missingAlbumTrack.id,
    albumId: missingAlbum.id,
    source: "aurral",
    path: missingAlbumPath,
  });

  try {
    const readModel = await getCanonicalLibraryReadModelForAlbumReferences({
      source: "aurral",
      availableOnly: false,
      references: [ownedAlbum.identity_key, missingAlbum.identity_key],
    });
    const owned = readModel.albums.find((album) => album.canonicalId === ownedAlbum.id);
    const missing = readModel.albums.find((album) => album.canonicalId === missingAlbum.id);
    assert.equal(owned?.identityKey, ownedAlbum.identity_key);
    assert.equal(missing?.identityKey, missingAlbum.identity_key);
    assert.equal(owned?.statistics.trackFileCount, 1);
    assert.equal(missing?.statistics.trackFileCount, 1);
    assert.deepEqual(
      readModel.tracks
        .filter((entry) => entry.albumId === missingAlbum.id)
        .map((entry) => entry.title),
      ["Owned Only By Missing Album"],
    );
    await db.run("UPDATE library_media_files SET available = 0 WHERE path = ?", [missingAlbumPath]);
    const available = await getCanonicalLibraryReadModelForAlbumReferences({
      source: "aurral",
      availableOnly: true,
      references: [missingAlbum.identity_key],
    });
    assert.deepEqual(available.albums, []);
    assert.deepEqual(available.tracks, []);
  } finally {
    await db.run("DELETE FROM library_media_files WHERE path IN (?, ?)", [ownedPath,
      missingAlbumPath]);
    await db.run("DELETE FROM library_album_tracks WHERE album_id IN (?, ?)", [ownedAlbum.id,
      missingAlbum.id]);
    await db.run("DELETE FROM library_tracks WHERE id IN (?, ?)", [track.id,
      missingAlbumTrack.id]);
    await db.run("DELETE FROM library_albums WHERE id IN (?, ?)", [ownedAlbum.id,
      missingAlbum.id]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [artist.id]);
    await invalidateCanonicalLibraryCache();
  }
});

test("album reads prefer an album-specific file over an earlier unscoped file", async () => {
  const readModel = await buildCanonicalLibraryReadModel({
    artists: [{ id: 1, name: "Artist", albumIds: [2], sources: ["aurral"] }],
    albums: [{ id: 2, artistId: 1, title: "Album", trackIds: [3], sources: ["aurral"] }],
    tracks: [{
      id: 3,
      title: "Track",
      albums: [{ albumId: 2, trackNumber: 1 }],
      files: [
        { albumId: null, path: "/music/00-unscoped.flac", available: true },
        { albumId: 2, path: "/music/01-album.flac", available: true },
      ],
      sources: ["aurral"],
    }],
  });

  assert.equal(readModel.tracks[0].path, "/music/01-album.flac");
});

test("canonical newest ordering follows library arrival time", async () => {
  const key = `query-newest-${process.pid}-${Date.now()}`;
  const artist = await upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Newest Fixture" });
  const oldAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:old-album`,
    artistId: artist.id,
    title: "Old Album",
    releaseDate: "2020-01-01",
  });
  const newAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:new-album`,
    artistId: artist.id,
    title: "Recently Added",
    releaseDate: "1990-01-01",
  });
  const oldTrack = await upsertLibraryTrack({
    identityKey: `${key}:old-track`,
    title: "Old Track",
    artistName: "Newest Fixture",
  });
  const newTrack = await upsertLibraryTrack({
    identityKey: `${key}:new-track`,
    title: "New Track",
    artistName: "Newest Fixture",
  });
  await linkLibraryAlbumTrack({ albumId: oldAlbum.id, trackId: oldTrack.id, trackNumber: 1 });
  await linkLibraryAlbumTrack({ albumId: newAlbum.id, trackId: newTrack.id, trackNumber: 1 });
  await upsertLibraryMediaFile({
    trackId: oldTrack.id,
    albumId: oldAlbum.id,
    source: "aurral",
    path: `/tmp/${key}/old.flac`,
  });
  await upsertLibraryMediaFile({
    trackId: newTrack.id,
    albumId: newAlbum.id,
    source: "aurral",
    path: `/tmp/${key}/new.flac`,
  });
  const now = Date.now();
  await db.run("UPDATE library_media_files SET created_at = ? WHERE path = ?", [now - 60_000,
    `/tmp/${key}/old.flac`]);
  await db.run("UPDATE library_media_files SET created_at = ? WHERE path = ?", [now,
    `/tmp/${key}/new.flac`]);

  try {
    const page = await getCanonicalLibraryPage({
      source: "aurral",
      kind: "albums",
      page: 1,
      pageSize: 2,
      sort: "newest",
    });
    assert.deepEqual(page.items.map((item) => item.title), ["Recently Added", "Old Album"]);
  } finally {
    await db.run("DELETE FROM library_media_files WHERE path LIKE ?", [`/tmp/${key}/%`]);
    await db.run("DELETE FROM library_album_tracks WHERE album_id IN (?, ?)", [oldAlbum.id,
      newAlbum.id]);
    await db.run("DELETE FROM library_tracks WHERE id IN (?, ?)", [oldTrack.id, newTrack.id]);
    await db.run("DELETE FROM library_albums WHERE id IN (?, ?)", [oldAlbum.id, newAlbum.id]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [artist.id]);
  }
});

test("canonical album track pages keep the selected album relationship", async () => {
  const key = `query-album-scope-${process.pid}-${Date.now()}`;
  const artist = await upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Eve 6" });
  const firstAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:first-album`,
    artistId: artist.id,
    title: "Eve 6",
    releaseDate: "1998",
  });
  const selectedAlbum = await upsertLibraryAlbum({
    identityKey: `${key}:selected-album`,
    artistId: artist.id,
    title: "Inside Out",
    releaseDate: "1998",
  });
  const track = await upsertLibraryTrack({
    identityKey: `${key}:track`,
    title: "Showerhead",
    artistName: "Eve 6",
  });
  await linkLibraryAlbumTrack({ albumId: firstAlbum.id, trackId: track.id, trackNumber: 1 });
  await linkLibraryAlbumTrack({ albumId: selectedAlbum.id, trackId: track.id, trackNumber: 1 });
  await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: selectedAlbum.id,
    source: "aurral",
    path: `/tmp/${key}/track.flac`,
  });

  try {
    const page = await getCanonicalLibraryPage({
      source: "aurral",
      kind: "tracks",
      albumId: selectedAlbum.id,
      page: 1,
      pageSize: 10,
    });
    assert.deepEqual(page.items[0].albums.map((entry) => entry.albumId), [selectedAlbum.id]);
    assert.deepEqual(page.albums.map((album) => album.title), ["Inside Out"]);
  } finally {
    await db.run("DELETE FROM library_media_files WHERE path = ?", [`/tmp/${key}/track.flac`]);
    await db.run("DELETE FROM library_album_tracks WHERE album_id IN (?, ?)", [firstAlbum.id,
      selectedAlbum.id]);
    await db.run("DELETE FROM library_tracks WHERE id = ?", [track.id]);
    await db.run("DELETE FROM library_albums WHERE id IN (?, ?)", [firstAlbum.id,
      selectedAlbum.id]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [artist.id]);
  }
});

test("canonical album track pages include indexed tracks without media", async () => {
  const key = `query-album-missing-${process.pid}-${Date.now()}`;
  const artist = await upsertLibraryArtist({ identityKey: `${key}:artist`, name: "Partial Fixture" });
  const album = await upsertLibraryAlbum({
    identityKey: `${key}:album`,
    artistId: artist.id,
    title: "Partial Album",
  });
  const ownedTrack = await upsertLibraryTrack({
    identityKey: `${key}:owned-track`,
    mbid: `${key}-owned`,
    title: "Owned Track",
    artistName: "Partial Fixture",
  });
  const missingTrack = await upsertLibraryTrack({
    identityKey: `${key}:missing-track`,
    mbid: `${key}-missing`,
    title: "Missing Track",
    artistName: "Partial Fixture",
    metadata: { genres: ["Electronic"] },
  });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: ownedTrack.id, trackNumber: 1 });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: missingTrack.id, trackNumber: 2 });
  const ownedPath = `/tmp/${key}/owned.flac`;
  await upsertLibraryMediaFile({
    trackId: ownedTrack.id,
    albumId: album.id,
    source: "aurral",
    path: ownedPath,
  });

  try {
    const page = await getCanonicalLibraryPage({
      source: "aurral",
      kind: "tracks",
      albumId: album.id,
      page: 1,
      pageSize: 10,
    });
    assert.deepEqual(page.items.map((track) => track.title), ["Owned Track", "Missing Track"]);
    assert.equal(page.items[0].files.length, 1);
    assert.deepEqual(page.items[1].files, []);
    assert.equal(page.albums[0].trackCount, 2);
    assert.equal(page.albums[0].availableTrackCount, 1);

    const filtered = await getCanonicalLibraryPage({
      kind: "tracks",
      albumId: album.id,
      page: 1,
      pageSize: 10,
      query: "missing",
      genre: "electronic",
      sort: "name",
      direction: "desc",
    });
    assert.deepEqual(filtered.items.map((track) => track.title), ["Missing Track"]);

    const artistScoped = await getCanonicalLibraryPage({
      kind: "tracks",
      albumId: album.id,
      artistId: artist.id,
      page: 1,
      pageSize: 10,
      sort: "name",
      direction: "desc",
    });
    assert.deepEqual(artistScoped.items.map((track) => track.title), ["Owned Track", "Missing Track"]);
  } finally {
    await db.run("DELETE FROM library_media_files WHERE path = ?", [ownedPath]);
    await db.run("DELETE FROM library_album_tracks WHERE album_id = ?", [album.id]);
    await db.run("DELETE FROM library_tracks WHERE id IN (?, ?)", [ownedTrack.id, missingTrack.id]);
    await db.run("DELETE FROM library_albums WHERE id = ?", [album.id]);
    await db.run("DELETE FROM library_artists WHERE id = ?", [artist.id]);
  }
});

test("canonical library responses do not expose filesystem paths", async () => {
  const response = await toPublicLibrary({
    artists: [{ metadata: { path: "/music/private", tags: { genre: "rock" } } }],
    albums: [{ metadata: { rootFolderPath: "/music/private" } }],
    tracks: [{
      id: 1,
      metadata: { nested: { filePath: "/music/private.flac" } },
      files: [{ id: 2, path: "/music/private.flac", source: "aurral" }],
    }],
  });

  assert.deepEqual(response.artists[0].metadata, { tags: { genre: "rock" } });
  assert.deepEqual(response.albums[0].metadata, {});
  assert.deepEqual(response.tracks[0].metadata, { nested: {} });
  assert.deepEqual(response.tracks[0].files, [{ id: 2, source: "aurral" }]);
});

test("canonical album responses return public metadata artwork links", async () => {
  const remoteUrl = "https://cdn.example.test/cover.jpg?size=500";
  const response = await toPublicLibrary({
    artists: [],
    albums: [{
      id: 1,
      metadata: {
        images: [
          { url: "/MediaCover/Albums/1/cover.jpg" },
          { remoteUrl },
        ],
      },
    }],
    tracks: [],
  });

  assert.equal(response.albums[0].coverUrl, remoteUrl);
});
