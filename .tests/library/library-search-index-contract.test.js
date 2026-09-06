import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupIsolatedState,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState, libraryStore, searchIndex] = await setupIsolatedBackend(
  "library-search-index-contract",
  "backend/services/libraryMediaStore.js",
  "backend/services/librarySearchIndex.js",
);
const { db } = await import("../../backend/config/database.js");

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("album and track search syncs report changed and unchanged documents", async () => {
  const artist = await libraryStore.upsertLibraryArtist({
    identityKey: "search-contract:artist",
    name: "Search Contract Artist",
    syncSearch: false,
  });
  const album = await libraryStore.upsertLibraryAlbum({
    identityKey: "search-contract:album",
    artistId: artist.id,
    title: "Search Contract Album",
    albumArtist: artist.name,
    syncSearch: false,
  });
  const track = await libraryStore.upsertLibraryTrack({
    identityKey: "search-contract:track",
    title: "Search Contract Track",
    artistName: artist.name,
    syncSearch: false,
  });
  await libraryStore.linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: track.id,
    syncSearch: false,
  });

  assert.equal(await searchIndex.syncLibrarySearchAlbum(album.id), true);
  assert.equal(await searchIndex.syncLibrarySearchAlbum(album.id), false);
  assert.equal(await searchIndex.syncLibrarySearchTrack(track.id), true);
  assert.equal(await searchIndex.syncLibrarySearchTrack(track.id), false);

  assert.equal(
    Number(
      (
        await db.get(
          "SELECT COUNT(*) AS count FROM library_search_documents WHERE entity_id IN (?, ?)",
          [album.id, track.id],
        )
      ).count,
    ),
    2,
  );
});
