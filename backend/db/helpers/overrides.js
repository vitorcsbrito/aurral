import { db } from "../../config/database.js";

export default function register(dbOps) {
  dbOps.getArtistOverride = async function (mbid) {
    if (!mbid) return null;
    const row = await db.get("SELECT * FROM artist_overrides WHERE mbid = ?", [mbid]);
    if (!row) return null;
    return {
      mbid: row.mbid,
      musicbrainzId: row.musicbrainz_id || null,
      deezerArtistId: row.deezer_artist_id || null,
      updatedAt: row.updated_at || null,
    };
  };

  dbOps.setArtistOverride = async function (mbid, { musicbrainzId = null, deezerArtistId = null } = {}) {
    if (!mbid) return null;
    const now = Date.now();
    await db.run(
      `INSERT INTO artist_overrides (mbid, musicbrainz_id, deezer_artist_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (mbid) DO UPDATE SET
         musicbrainz_id = EXCLUDED.musicbrainz_id,
         deezer_artist_id = EXCLUDED.deezer_artist_id,
         updated_at = EXCLUDED.updated_at`,
      [mbid, musicbrainzId || null, deezerArtistId || null, now],
    );
    return {
      mbid,
      musicbrainzId: musicbrainzId || null,
      deezerArtistId: deezerArtistId || null,
      updatedAt: now,
    };
  };

  dbOps.deleteArtistOverride = async function (mbid) {
    if (!mbid) return null;
    return db.run("DELETE FROM artist_overrides WHERE mbid = ?", [mbid]);
  };
}
