import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../../backend/config/database.js";
import { migrateDatabase } from "../../backend/db/pg/schema.js";
import { loadSettingsCache } from "../../backend/db/helpers/settings.js";
import {
  beginLibraryScan,
  buildFallbackIdentityKey,
  buildIdentityKey,
  finishLibraryScan,
  getAvailableLibraryMediaPaths,
  getLibraryMediaFile,
  getLibrarySnapshot,
  linkLibraryAlbumTrack,
  markLibraryMediaFilesUnavailable,
  removeLibraryTrackIfNoAvailableMedia,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
  withLibraryScan,
} from "../../backend/services/libraryMediaStore.js";
import { closeInterruptedLibraryScans } from "../../backend/services/libraryIndexService.js";

const clearLibrary = async () => {
  for (const table of [
    "library_media_files",
    "library_album_tracks",
    "library_tracks",
    "library_albums",
    "library_artists",
    "library_scan_runs",
    "library_search_documents",
  ]) {
    await db.run(`DELETE FROM ${table}`);
  }
};

test.before(async () => {
  await migrateDatabase(db, { logger: {} });
  await loadSettingsCache();
  await clearLibrary();
});

test("upserts an artist, album, track and media file", async () => {
  const scanId = await beginLibraryScan({ source: "aurral", rootPath: "/music" });

  const artist = await upsertLibraryArtist({
    identityKey: buildIdentityKey("mbid", "11111111-1111-4111-8111-111111111111"),
    mbid: "11111111-1111-4111-8111-111111111111",
    name: "Test Artist",
    sortName: "Artist, Test",
    metadata: { genres: ["shoegaze"] },
    syncSearch: false,
  });
  assert.ok(artist.id);
  assert.equal(artist.identity_key, "mbid:11111111-1111-4111-8111-111111111111");

  const album = await upsertLibraryAlbum({
    identityKey: buildIdentityKey("release-group", "22222222-2222-4222-8222-222222222222"),
    mbid: "22222222-2222-4222-8222-222222222222",
    releaseGroupMbid: "22222222-2222-4222-8222-222222222222",
    artistId: artist.id,
    title: "Test Album",
    albumArtist: "Test Artist",
    releaseDate: "2020-05-01",
    metadata: { genre: "shoegaze" },
    syncSearch: false,
  });
  assert.ok(album.id);
  assert.equal(album.artist_id, artist.id);

  const track = await upsertLibraryTrack({
    identityKey: buildIdentityKey("recording", "33333333-3333-4333-8333-333333333333"),
    mbid: "33333333-3333-4333-8333-333333333333",
    title: "Test Track",
    artistName: "Test Artist",
    metadata: { tags: { genre: "shoegaze" } },
    syncSearch: false,
  });
  assert.ok(track.id);

  await linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: track.id,
    discNumber: 1,
    trackNumber: 3,
    syncSearch: false,
  });

  const media = await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: "/music/test-artist/test-album/03 test track.flac",
    format: "flac",
    size: 4096,
    mtimeMs: 1700000000000,
    durationMs: 210000,
    quality: { format: "flac", bitrate: 900000 },
    scanId,
  });
  assert.ok(media.id);

  const storedArtist = await db.get("SELECT * FROM library_artists WHERE id = ?", [artist.id]);
  assert.equal(storedArtist.name, "Test Artist");
  assert.equal(storedArtist.sort_name, "Artist, Test");

  const storedAlbum = await db.get("SELECT * FROM library_albums WHERE id = ?", [album.id]);
  assert.equal(storedAlbum.title, "Test Album");
  assert.equal(storedAlbum.release_date, "2020-05-01");

  const storedLink = await db.get(
    "SELECT * FROM library_album_tracks WHERE album_id = ? AND track_id = ?",
    [album.id, track.id],
  );
  assert.equal(storedLink.track_number, 3);

  const storedMedia = await db.get("SELECT * FROM library_media_files WHERE id = ?", [media.id]);
  assert.equal(storedMedia.available, 1);
  assert.equal(storedMedia.size, 4096);
  assert.equal(storedMedia.last_seen_scan_id, scanId);

  // Recency and genres come from schema triggers, not the store.
  const recency = await db.get("SELECT latest_available_media_at FROM library_albums WHERE id = ?", [
    album.id,
  ]);
  assert.ok(recency.latest_available_media_at > 0);
  const genres = await db.all(
    "SELECT genre FROM library_genres WHERE entity_kind = 'album' AND entity_id = ?",
    [album.id],
  );
  assert.deepEqual(genres.map((row) => row.genre), ["shoegaze"]);

  const paths = await getAvailableLibraryMediaPaths("aurral");
  assert.equal(paths.has("/music/test-artist/test-album/03 test track.flac"), true);
  const found = await getLibraryMediaFile({
    source: "aurral",
    path: "/music/test-artist/test-album/03 test track.flac",
  });
  assert.equal(found.id, media.id);

  await finishLibraryScan(scanId, { filesSeen: 1, filesIndexed: 1 });
  const run = await db.get("SELECT * FROM library_scan_runs WHERE id = ?", [scanId]);
  assert.equal(run.status, "complete");
  assert.equal(run.files_indexed, 1);

  const snapshot = await getLibrarySnapshot();
  assert.equal(snapshot.artists.length, 1);
  assert.equal(snapshot.files.length, 1);
});

test("re-upserting unchanged rows returns the stored row", async () => {
  const artist = await upsertLibraryArtist({
    identityKey: buildFallbackIdentityKey("artist", "Stable Artist"),
    name: "Stable Artist",
    syncSearch: false,
  });
  const again = await upsertLibraryArtist({
    identityKey: buildFallbackIdentityKey("artist", "Stable Artist"),
    name: "Stable Artist",
    syncSearch: false,
  });
  assert.equal(again.id, artist.id);
  assert.equal(again.updated_at, artist.updated_at);
  await db.run("DELETE FROM library_artists WHERE id = ?", [artist.id]);
});

test("removes a track with no available media and cleans up orphans", async () => {
  await clearLibrary();
  const scanId = await beginLibraryScan({ source: "aurral", rootPath: "/music" });
  const artist = await upsertLibraryArtist({
    identityKey: buildFallbackIdentityKey("artist", "Orphan Artist"),
    name: "Orphan Artist",
    syncSearch: false,
  });
  const album = await upsertLibraryAlbum({
    identityKey: buildFallbackIdentityKey("album", "Orphan Artist", "Orphan Album"),
    artistId: artist.id,
    title: "Orphan Album",
    syncSearch: false,
  });
  const track = await upsertLibraryTrack({
    identityKey: buildFallbackIdentityKey("track", "Orphan Album", "Orphan Track"),
    title: "Orphan Track",
    syncSearch: false,
  });
  await linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: track.id,
    trackNumber: 1,
    syncSearch: false,
  });
  const filePath = "/music/orphan-artist/orphan-album/01 orphan track.mp3";
  await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
    format: "mp3",
    size: 128,
    scanId,
  });

  // An available file keeps the track.
  assert.equal(await removeLibraryTrackIfNoAvailableMedia(track.id), false);

  assert.equal(await markLibraryMediaFilesUnavailable("aurral", [filePath]), 1);
  const unavailable = await db.get("SELECT available FROM library_media_files WHERE path = ?", [
    filePath,
  ]);
  assert.equal(unavailable.available, 0);

  assert.equal(await removeLibraryTrackIfNoAvailableMedia(track.id), true);
  assert.equal(await db.get("SELECT id FROM library_tracks WHERE id = ?", [track.id]), undefined);
  assert.equal(await db.get("SELECT id FROM library_albums WHERE id = ?", [album.id]), undefined);
  assert.equal(await db.get("SELECT id FROM library_artists WHERE id = ?", [artist.id]), undefined);
  assert.equal(await db.get("SELECT id FROM library_media_files WHERE path = ?", [filePath]), undefined);
  await finishLibraryScan(scanId, { status: "complete" });
});

// fs.stat mtimeMs is fractional; mtime_ms is BIGINT.
test("stores fractional stat and duration values in bigint columns", async () => {
  await clearLibrary();
  const scanId = await beginLibraryScan({ source: "aurral", rootPath: "/music" });
  const artist = await upsertLibraryArtist({
    identityKey: buildFallbackIdentityKey("artist", "Fractional Artist"),
    name: "Fractional Artist",
    syncSearch: false,
  });
  const album = await upsertLibraryAlbum({
    identityKey: buildFallbackIdentityKey("album", "Fractional Artist", "Fractional Album"),
    artistId: artist.id,
    title: "Fractional Album",
    syncSearch: false,
  });
  const track = await upsertLibraryTrack({
    identityKey: buildFallbackIdentityKey("track", "Fractional Album", "Fractional Track"),
    title: "Fractional Track",
    syncSearch: false,
  });

  const filePath = "/music/fractional/01.flac";
  const media = await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
    format: "flac",
    size: 4096,
    mtimeMs: 1788711092078.4963,
    durationMs: 210333.7,
    scanId,
  });
  assert.equal(media.mtime_ms, 1788711092078);
  assert.equal(media.duration_ms, 210334);

  // The rounded value must compare equal, so a rescan is a no-op.
  const again = await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
    format: "flac",
    size: 4096,
    mtimeMs: 1788711092078.4963,
    durationMs: 210333.7,
    scanId,
  });
  assert.equal(again.id, media.id);
  assert.equal(again.updated_at, media.updated_at);
  await finishLibraryScan(scanId, { status: "complete" });
});

// The Lidarr indexer batches its writes this way, so the store's own
// transactions have to nest as savepoints.
test("a scan writes through a batch transaction and records completion", async () => {
  await clearLibrary();
  const result = await withLibraryScan("lidarr", "/lidarr", async (scanId) => {
    await db.transaction(async () => {
      const artist = await upsertLibraryArtist({
        identityKey: buildFallbackIdentityKey("artist", "Nested Artist"),
        name: "Nested Artist",
        syncSearch: false,
      });
      const album = await upsertLibraryAlbum({
        identityKey: buildFallbackIdentityKey("album", "Nested Artist", "Nested Album"),
        artistId: artist.id,
        title: "Nested Album",
        syncSearch: false,
      });
      const track = await upsertLibraryTrack({
        identityKey: buildFallbackIdentityKey("track", "Nested Album", "Nested Track"),
        title: "Nested Track",
        syncSearch: false,
      });
      await linkLibraryAlbumTrack({
        albumId: album.id,
        trackId: track.id,
        trackNumber: 1,
        syncSearch: false,
      });
      await upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: "lidarr",
        path: "/lidarr/nested/01.flac",
        format: "flac",
        size: 10,
        scanId,
      });
    });
    return { filesSeen: 1, filesIndexed: 1, filesFailed: 0 };
  });
  assert.equal(result.status, "complete");
  assert.equal(result.changed, true);
  const media = await db.get("SELECT available FROM library_media_files WHERE path = ?", [
    "/lidarr/nested/01.flac",
  ]);
  assert.equal(media.available, 1);
  const run = await db.get("SELECT status FROM library_scan_runs WHERE id = ?", [result.scanId]);
  assert.equal(run.status, "complete");
});

test("a scan that throws records a failed run", async () => {
  await clearLibrary();
  await assert.rejects(
    withLibraryScan("lidarr", "/lidarr", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const run = await db.get(
    "SELECT status, error FROM library_scan_runs ORDER BY id DESC LIMIT 1",
  );
  assert.equal(run.status, "failed");
  assert.equal(run.error, "boom");
});

test("closeInterruptedLibraryScans fails runs left running", async () => {
  await clearLibrary();
  const scanId = await beginLibraryScan({ source: "lidarr", rootPath: "/lidarr" });
  const open = await db.get("SELECT status FROM library_scan_runs WHERE id = ?", [scanId]);
  assert.equal(open.status, "running");

  assert.equal(await closeInterruptedLibraryScans(), 1);
  const closed = await db.get("SELECT status, error, completed_at FROM library_scan_runs WHERE id = ?", [
    scanId,
  ]);
  assert.equal(closed.status, "failed");
  assert.equal(closed.error, "interrupted");
  assert.ok(closed.completed_at > 0);
  assert.equal(await closeInterruptedLibraryScans(), 0);
});
