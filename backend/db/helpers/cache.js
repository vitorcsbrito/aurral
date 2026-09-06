import { db } from "../../config/database.js";

const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const parseImages = (value) => {
  if (!value) return null;
  try {
    const images = JSON.parse(value);
    return Array.isArray(images) ? images : null;
  } catch {
    return null;
  }
};

const serializeImages = (images) => (Array.isArray(images) ? JSON.stringify(images) : null);

export default function register(dbOps) {
  dbOps.getImage = async function (mbid) {
    const row = await db.get("SELECT * FROM images_cache WHERE mbid = ?", [mbid]);
    if (!row) return null;
    if (row.image_url === "NOT_FOUND" && Date.now() - row.cache_age > NOT_FOUND_TTL_MS) {
      await db.run("DELETE FROM images_cache WHERE mbid = ?", [mbid]);
      return null;
    }
    return {
      mbid: row.mbid,
      imageUrl: row.image_url,
      images: parseImages(row.images_json),
      cacheAge: row.cache_age,
    };
  };

  dbOps.getImages = async function (mbids) {
    if (!mbids || !mbids.length) return {};
    const placeholders = mbids.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT mbid, image_url, images_json, cache_age FROM images_cache WHERE mbid IN (${placeholders})`,
      mbids,
    );
    const now = Date.now();
    const result = {};
    for (const row of rows) {
      if (row.image_url === "NOT_FOUND" && now - row.cache_age > NOT_FOUND_TTL_MS) {
        await db.run("DELETE FROM images_cache WHERE mbid = ?", [row.mbid]);
        continue;
      }
      result[row.mbid] = {
        imageUrl: row.image_url,
        images: parseImages(row.images_json),
        cacheAge: row.cache_age,
      };
    }
    return result;
  };

  dbOps.setImage = async function (mbid, imageUrl, images) {
    const imagesJson =
      imageUrl === "NOT_FOUND"
        ? null
        : images === undefined
          ? (await db.get("SELECT images_json FROM images_cache WHERE mbid = ?", [mbid]))
              ?.images_json || null
          : serializeImages(images);
    await db.run(
      `INSERT INTO images_cache (mbid, image_url, images_json, cache_age, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (mbid) DO UPDATE SET
         image_url = EXCLUDED.image_url,
         images_json = EXCLUDED.images_json,
         cache_age = EXCLUDED.cache_age,
         created_at = EXCLUDED.created_at`,
      [mbid, imageUrl, imagesJson, Date.now(), new Date().toISOString()],
    );
  };

  dbOps.countImages = async function () {
    const row = await db.get("SELECT COUNT(*) as count FROM images_cache");
    return Number(row?.count || 0);
  };

  dbOps.deleteImage = async function (mbid) {
    return db.run("DELETE FROM images_cache WHERE mbid = ?", [mbid]);
  };

  dbOps.clearImages = async function () {
    return db.run("DELETE FROM images_cache");
  };

  dbOps.cleanOldImageCache = async function (maxAgeDays = 30) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return db.run("DELETE FROM images_cache WHERE cache_age < ?", [cutoff]);
  };

  dbOps.getDeezerMbidCache = async function (cacheKey) {
    const row = await db.get("SELECT mbid FROM deezer_mbid_cache WHERE cache_key = ?", [cacheKey]);
    return row?.mbid ?? null;
  };

  dbOps.setDeezerMbidCache = async function (cacheKey, mbid) {
    await db.run(
      `INSERT INTO deezer_mbid_cache (cache_key, mbid) VALUES (?, ?)
       ON CONFLICT (cache_key) DO UPDATE SET mbid = EXCLUDED.mbid`,
      [cacheKey, mbid],
    );
  };

  dbOps.getMusicbrainzArtistMbidCache = async function (artistNameKey) {
    if (!artistNameKey) return null;
    const row = await db.get(
      "SELECT mbid, updated_at FROM musicbrainz_artist_mbid_cache WHERE artist_name_key = ?",
      [artistNameKey],
    );
    if (!row) return null;
    return {
      mbid: row.mbid || null,
      updatedAt: Number(row.updated_at || 0),
    };
  };

  dbOps.setMusicbrainzArtistMbidCache = async function (artistNameKey, mbid) {
    if (!artistNameKey) return null;
    const updatedAt = Date.now();
    await db.run(
      `INSERT INTO musicbrainz_artist_mbid_cache (artist_name_key, mbid, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (artist_name_key) DO UPDATE SET
         mbid = EXCLUDED.mbid,
         updated_at = EXCLUDED.updated_at`,
      [artistNameKey, mbid || null, updatedAt],
    );
    return {
      artistNameKey,
      mbid: mbid || null,
      updatedAt,
    };
  };

  dbOps.cleanOldMusicbrainzArtistMbidCache = async function (maxAgeDays = 90) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    return db.run("DELETE FROM musicbrainz_artist_mbid_cache WHERE updated_at < ?", [cutoff]);
  };
}
