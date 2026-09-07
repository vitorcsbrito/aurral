import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../../backend/config/database.js";
import {
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.js";

const [isolatedState] = await setupIsolatedBackend("malformed-metadata-index");
const { getCanonicalLibraryForArtistReferences } = await importFromRepo(
  "backend/services/libraryQueryService.js",
);
const {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} = await importFromRepo("backend/services/libraryMediaStore.js");

const PROVIDER_INDEX = "idx_library_artists_provider_id";
const FOREIGN_INDEX = "idx_library_artists_foreign_artist_id";

test.before(async () => {
  await resetDatabase();
  await db.run(
    `INSERT INTO library_artists (identity_key, name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ["malformed:artist", "Malformed Artist", "{", 1, 1],
  );
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("malformed artist metadata does not break indexed reference lookup", async () => {
  const artist = await upsertLibraryArtist({
    identityKey: "valid:artist",
    mbid: "valid-artist-mbid",
    name: "Valid Artist",
    metadata: { id: "valid-provider-id", foreignArtistId: "valid-foreign-artist-id" },
  });
  const album = await upsertLibraryAlbum({
    identityKey: "valid:album",
    artistId: artist.id,
    title: "Valid Album",
  });
  const track = await upsertLibraryTrack({
    identityKey: "valid:track",
    title: "Valid Track",
  });
  await linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id });
  await upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: "/tmp/valid-track.flac",
  });

  const providerResult = await getCanonicalLibraryForArtistReferences({
    references: ["valid-provider-id"],
  });
  const foreignResult = await getCanonicalLibraryForArtistReferences({
    references: ["valid-foreign-artist-id"],
  });

  assert.deepEqual(providerResult.artists.map(({ name }) => name), ["Valid Artist"]);
  assert.deepEqual(foreignResult.artists.map(({ name }) => name), ["Valid Artist"]);
});

test("the reference expressions are indexed and the planner can use them", async () => {
  const definitions = new Map(
    (
      await db.all("SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY(?)", [
        [PROVIDER_INDEX, FOREIGN_INDEX],
      ])
    ).map((row) => [row.indexname, row.indexdef]),
  );

  assert.match(definitions.get(PROVIDER_INDEX), /aurral_json\(metadata_json\)/);
  assert.match(definitions.get(PROVIDER_INDEX), /'id'/);
  assert.match(definitions.get(FOREIGN_INDEX), /aurral_json\(metadata_json\)/);
  assert.match(definitions.get(FOREIGN_INDEX), /'foreignArtistId'/);

  // On a fixture-sized table a seq scan always wins on cost.
  const plans = await db.transaction(async () => {
    await db.exec("SET LOCAL enable_seqscan = off");
    return {
      provider: await db.all(
        `EXPLAIN SELECT id FROM library_artists
         WHERE aurral_json(metadata_json) ->> 'id' = ANY(?)`,
        [["valid-provider-id"]],
      ),
      foreign: await db.all(
        `EXPLAIN SELECT id FROM library_artists
         WHERE aurral_json(metadata_json) ->> 'foreignArtistId' = ANY(?)`,
        [["valid-foreign-artist-id"]],
      ),
    };
  });

  const usesIndex = (rows, name) =>
    rows.some((row) => String(row["QUERY PLAN"] || "").includes(name));
  assert.equal(usesIndex(plans.provider, PROVIDER_INDEX), true);
  assert.equal(usesIndex(plans.foreign, FOREIGN_INDEX), true);
});
