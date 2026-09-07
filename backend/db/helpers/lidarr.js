import { db } from "../../config/database.js";

export default function register(dbOps) {
  dbOps.getLidarrArtistIdMap = async function (musicbrainzId) {
    if (!musicbrainzId) return null;
    const row = await db.get(
      "SELECT lidarr_foreign_artist_id FROM lidarr_artist_id_map WHERE musicbrainz_id = ?",
      [musicbrainzId],
    );
    return row?.lidarr_foreign_artist_id || null;
  };

  dbOps.getLidarrArtistMbid = async function (lidarrForeignArtistId) {
    if (!lidarrForeignArtistId) return null;
    const row = await db.get(
      "SELECT musicbrainz_id FROM lidarr_artist_id_map WHERE lidarr_foreign_artist_id = ?",
      [lidarrForeignArtistId],
    );
    return row?.musicbrainz_id || null;
  };

  dbOps.setLidarrArtistIdMap = async function (musicbrainzId, lidarrForeignArtistId) {
    if (!musicbrainzId || !lidarrForeignArtistId) return null;
    const existing = await db.get(
      "SELECT musicbrainz_id FROM lidarr_artist_id_map WHERE lidarr_foreign_artist_id = ?",
      [lidarrForeignArtistId],
    );
    const existingMbid = existing?.musicbrainz_id;
    if (existingMbid && existingMbid !== musicbrainzId) {
      const error = new Error(
        `Lidarr artist ID "${lidarrForeignArtistId}" is already mapped to another MusicBrainz artist`,
      );
      error.code = "LIDARR_ARTIST_ID_CONFLICT";
      throw error;
    }
    const updatedAt = Date.now();
    try {
      await db.run(
        `INSERT INTO lidarr_artist_id_map (musicbrainz_id, lidarr_foreign_artist_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (musicbrainz_id) DO UPDATE SET
           lidarr_foreign_artist_id = EXCLUDED.lidarr_foreign_artist_id,
           updated_at = EXCLUDED.updated_at`,
        [musicbrainzId, lidarrForeignArtistId, updatedAt],
      );
    } catch (error) {
      if (
        error?.code === "23505" ||
        String(error?.message || "").includes("lidarr_foreign_artist_id")
      ) {
        error.code = "LIDARR_ARTIST_ID_CONFLICT";
      }
      throw error;
    }
    return { musicbrainzId, lidarrForeignArtistId, updatedAt };
  };

  dbOps.deleteLidarrArtistIdMap = async function (musicbrainzId) {
    if (!musicbrainzId) return null;
    return db.run("DELETE FROM lidarr_artist_id_map WHERE musicbrainz_id = ?", [musicbrainzId]);
  };
}
