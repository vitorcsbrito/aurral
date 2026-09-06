import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, { db }, subsonic, libraryStore] =
  await setupIsolatedBackend(
    "subsonic-library",
    "backend/config/database.js",
    "backend/services/subsonicLibraryService.js",
    "backend/services/libraryMediaStore.js",
  );

const { getAlbumList, getTopSongs, starMany } = subsonic;

const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = libraryStore;

async function addAlbum({ artist, title, releaseDate, trackTitle }) {
  const album = await upsertLibraryAlbum({
    identityKey: `test-album:${title}`,
    artistId: artist.id,
    title,
    albumArtist: artist.name,
    releaseDate,
  });
  const track = await upsertLibraryTrack({
    identityKey: `test-track:${trackTitle}`,
    title: trackTitle,
    artistName: artist.name,
  });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  await upsertLibraryMediaFile({
    trackId: track.id,
    source: "lidarr",
    path: `/test/${title}/${trackTitle}.flac`,
    format: "flac",
    available: true,
  });
}

test("starMany validates duplicate and equivalent encoded canonical targets", async () => {
  const user = await db.get(
    "INSERT INTO users (username, password_hash, role, permissions) VALUES (?, '', 'user', '{}') RETURNING id",
    ["subsonic-star-many"],
  );
  const key = "test-track:Old Song";
  const encoded = `song:${encodeURIComponent(key)}`;
  const alternate = encoded.replaceAll("%3A", "%3a");
  assert.equal(await starMany(user, [encoded, encoded]), true);
  assert.equal(await starMany(user, [encoded, alternate]), true);
  assert.equal(await starMany(user, [encoded, "song:missing"]), false);
});

test.before(async () => {
  await resetDatabase();
  const artistA = await upsertLibraryArtist({
    identityKey: "test-artist:artist-a",
    name: "Artist A",
  });
  const artistB = await upsertLibraryArtist({
    identityKey: "test-artist:artist-b",
    name: "Artist B",
  });
  await addAlbum({
    artist: artistA,
    title: "Old Album",
    releaseDate: "2010-01-01",
    trackTitle: "Old Song",
  });
  await addAlbum({
    artist: artistA,
    title: "New Album",
    releaseDate: "2024-01-01",
    trackTitle: "New Song",
  });
  await addAlbum({
    artist: artistB,
    title: "Artist A Collection",
    releaseDate: "2022-01-01",
    trackTitle: "Other Artist Song",
  });
  await db.run(
    `UPDATE library_media_files
     SET created_at = CASE
       WHEN path LIKE '%Old Album%' THEN 300
       WHEN path LIKE '%New Album%' THEN 200
       ELSE 100
     END`,
  );
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("orders newest albums by media arrival before applying pagination", async () => {
  assert.deepEqual(
    (await getAlbumList({ type: "newest", size: 1 })).map((album) => album.title),
    ["Old Album"],
  );
  assert.deepEqual(
    (await getAlbumList({ type: "newest", size: 1, offset: 1 })).map((album) => album.title),
    ["New Album"],
  );
  assert.deepEqual(
    (await getAlbumList({ type: "byYear", fromYear: 2024, toYear: 2010 })).map((album) => album.title),
    ["New Album", "Artist A Collection", "Old Album"],
  );
});

test("returns top songs only for the requested artist", async () => {
  const songs = await getTopSongs("Artist A", { count: 10 });
  assert.deepEqual(songs.map((song) => song.title), ["New Song", "Old Song"]);
  assert.equal(songs.every((song) => song.artist === "Artist A"), true);
  assert.deepEqual(
    (await getTopSongs("  test-artist:artist-a  ", { count: 10 })).map((song) => song.title),
    ["New Song", "Old Song"],
  );
});
