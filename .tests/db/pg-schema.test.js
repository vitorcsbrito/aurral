import test from "node:test";
import assert from "node:assert/strict";
import { db, closeDatabase, toPositionalPlaceholders } from "../../backend/config/database.js";
import { migrateDatabase } from "../../backend/db/pg/schema.js";

test.after(async () => {
  await closeDatabase();
});

test("placeholder rewriting skips quoted strings and comments", () => {
  assert.equal(
    toPositionalPlaceholders("SELECT ? FROM t WHERE a = 'x?y' AND b = ? -- c = ?\n AND d = ?"),
    "SELECT $1 FROM t WHERE a = 'x?y' AND b = $2 -- c = ?\n AND d = $3",
  );
  assert.equal(toPositionalPlaceholders("SELECT $1 FROM t"), "SELECT $1 FROM t");
  assert.equal(toPositionalPlaceholders("SELECT 'it''s ?' , ?"), "SELECT 'it''s ?' , $1");
});

test("migrations apply once and the schema round-trips library rows", async () => {
  await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const first = await migrateDatabase(db, { logger: {} });
  assert.ok(first.includes("0001_initial_tables"));
  const second = await migrateDatabase(db, { logger: {} });
  assert.deepEqual(second, []);

  const now = Date.now();
  const artist = await db.get(
    `INSERT INTO library_artists (identity_key, name, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    ["mbid:a1", "Boards of Canada", JSON.stringify({ id: 77, genres: ["IDM", " Ambient "] }), now, now],
  );
  assert.equal(typeof artist.id, "number");

  const genres = await db.all(
    "SELECT genre FROM library_genres WHERE entity_kind = 'artist' AND entity_id = ? ORDER BY genre",
    [artist.id],
  );
  assert.deepEqual(genres.map((row) => row.genre), ["Ambient", "IDM"]);

  const byProviderId = await db.get(
    "SELECT id FROM library_artists WHERE aurral_json(metadata_json) ->> 'id' = ?",
    ["77"],
  );
  assert.equal(byProviderId.id, artist.id);

  const album = await db.get(
    `INSERT INTO library_albums (identity_key, artist_id, title, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    ["mbid:al1", artist.id, "Geogaddi", JSON.stringify({ genre: "Electronic" }), now, now],
  );
  const track = await db.get(
    `INSERT INTO library_tracks (identity_key, title, created_at, updated_at)
     VALUES (?, ?, ?, ?) RETURNING id`,
    ["mbid:t1", "Music Is Math", now, now],
  );
  await db.run(
    "INSERT INTO library_album_tracks (album_id, track_id, disc_number, track_number, created_at) VALUES (?, ?, 1, 1, ?)",
    [album.id, track.id, now],
  );
  await db.run(
    `INSERT INTO library_media_files (track_id, album_id, source, path, size, available, created_at, updated_at)
     VALUES (?, ?, 'lidarr', '/music/geogaddi/01.flac', 1, 1, ?, ?)`,
    [track.id, album.id, now + 5, now + 5],
  );
  const recency = await db.get(
    "SELECT latest_media_at, latest_available_media_at FROM library_albums WHERE id = ?",
    [album.id],
  );
  assert.equal(recency.latest_media_at, now + 5);
  assert.equal(recency.latest_available_media_at, now + 5);

  await db.run("UPDATE library_media_files SET available = 0 WHERE track_id = ?", [track.id]);
  const afterUnavailable = await db.get(
    "SELECT latest_media_at, latest_available_media_at FROM library_tracks WHERE id = ?",
    [track.id],
  );
  assert.equal(afterUnavailable.latest_media_at, now + 5);
  assert.equal(afterUnavailable.latest_available_media_at, 0);

  await db.run(
    "INSERT INTO library_search_documents (entity_kind, entity_id, title, artist_name) VALUES ('album', ?, ?, ?)",
    [album.id, "Geogaddi", "Boards of Canada"],
  );
  const hit = await db.get(
    "SELECT entity_id FROM library_search_documents WHERE search_text LIKE '%' || lower(?) || '%'",
    ["gadd"],
  );
  assert.equal(hit.entity_id, album.id);

  const invalidJson = await db.get("SELECT aurral_json(?) AS value", ["{not json"]);
  assert.equal(invalidJson.value, null);
});

test("transactions roll back and nest as savepoints", async () => {
  await db.run("DELETE FROM settings");
  await assert.rejects(
    db.transaction(async () => {
      await db.run("INSERT INTO settings (key, value) VALUES ('a', '1')");
      await assert.rejects(
        db.transaction(async () => {
          await db.run("INSERT INTO settings (key, value) VALUES ('b', '2')");
          throw new Error("inner");
        }),
        /inner/,
      );
      assert.equal((await db.get("SELECT COUNT(*) AS count FROM settings")).count, 1);
      throw new Error("outer");
    }),
    /outer/,
  );
  assert.equal((await db.get("SELECT COUNT(*) AS count FROM settings")).count, 0);
});
