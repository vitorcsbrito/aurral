import { db, dbHelpers } from "../../config/database.js";

const GET_DISCOVERY_CACHE_SQL = "SELECT value, last_updated FROM discovery_cache WHERE key = ?";
const UPSERT_DISCOVERY_CACHE_SQL =
  "INSERT INTO discovery_cache (key, value, last_updated) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, last_updated = EXCLUDED.last_updated";
const DELETE_DISCOVERY_CACHE_BY_PREFIX_SQL = "DELETE FROM discovery_cache WHERE key LIKE ?";

const DISCOVERY_METADATA_FIELDS = [
  "recommendationQuality",
  "isEnriching",
  "discoveryRunId",
  "enrichmentStartedAt",
  "enrichmentCompletedAt",
  "enrichmentProgressMessage",
];

const discoveryUserCache = new Map();
const DISCOVERY_USER_CACHE_TTL_MS = 10_000;

function pruneDiscoveryUserCache() {
  const now = Date.now();
  for (const [key, entry] of discoveryUserCache) {
    if (now - entry.at >= DISCOVERY_USER_CACHE_TTL_MS) {
      discoveryUserCache.delete(key);
    }
  }
}

export default function register(dbOps) {
  dbOps.getDiscoveryCache = async function (cacheNamespace = null) {
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";

    if (cacheNamespace) {
      pruneDiscoveryUserCache();
      const cached = discoveryUserCache.get(cacheNamespace);
      if (cached) return cached.value;
    }

    const [
      metadataRow,
      recommendationsRow,
      globalTopRow,
      basedOnRow,
      topTagsRow,
      topGenresRow,
      fallbackGenresRow,
      fallbackGenrePoolsRow,
      discoverPlaylistsRow,
      providerRow,
    ] = await Promise.all([
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}metadata`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}recommendations`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}globalTop`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}basedOn`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}topTags`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}topGenres`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}fallbackGenres`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}fallbackGenrePools`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}discoverPlaylists`]),
      db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}provider`]),
    ]);

    const metadata = dbHelpers.parseJSON(metadataRow?.value) || {};
    const recommendations = dbHelpers.parseJSON(recommendationsRow?.value);
    const globalTop = dbHelpers.parseJSON(globalTopRow?.value);
    const basedOn = dbHelpers.parseJSON(basedOnRow?.value);
    const topTags = dbHelpers.parseJSON(topTagsRow?.value);
    const topGenres = dbHelpers.parseJSON(topGenresRow?.value);
    const fallbackGenres = dbHelpers.parseJSON(fallbackGenresRow?.value);
    const fallbackGenrePools = dbHelpers.parseJSON(fallbackGenrePoolsRow?.value);
    const discoverPlaylists = dbHelpers.parseJSON(discoverPlaylistsRow?.value);
    const provider = providerRow?.value || null;
    const lastUpdated = cacheNamespace
      ? (await db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}lastUpdated`]))?.value ||
        recommendationsRow?.last_updated ||
        null
      : recommendationsRow?.last_updated ||
        globalTopRow?.last_updated ||
        null;

    const result = {
      recommendations: recommendations || [],
      globalTop: globalTop || [],
      basedOn: basedOn || [],
      topTags: topTags || [],
      topGenres: topGenres || [],
      fallbackGenres: fallbackGenres || [],
      fallbackGenrePools:
        fallbackGenrePools && typeof fallbackGenrePools === "object"
          ? fallbackGenrePools
          : {},
      discoverPlaylists: discoverPlaylists || [],
      provider,
      lastUpdated,
      metadata,
      recommendationQuality: metadata.recommendationQuality || null,
      isEnriching: metadata.isEnriching === true,
      discoveryRunId: metadata.discoveryRunId || null,
      enrichmentStartedAt: metadata.enrichmentStartedAt || null,
      enrichmentCompletedAt: metadata.enrichmentCompletedAt || null,
      enrichmentProgressMessage: metadata.enrichmentProgressMessage || null,
    };

    if (cacheNamespace) {
      discoveryUserCache.set(cacheNamespace, { at: Date.now(), value: result });
    }

    return result;
  };

  dbOps.updateDiscoveryCache = async function (discovery, cacheNamespace = null) {
    const now = new Date().toISOString();
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";
    if (cacheNamespace) discoveryUserCache.delete(cacheNamespace);
    await db.transaction(async () => {
      if (discovery.recommendations) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}recommendations`,
          dbHelpers.stringifyJSON(discovery.recommendations),
          now,
        ]);
      }
      if (discovery.globalTop) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}globalTop`,
          dbHelpers.stringifyJSON(discovery.globalTop),
          now,
        ]);
      }
      if (discovery.basedOn) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}basedOn`,
          dbHelpers.stringifyJSON(discovery.basedOn),
          now,
        ]);
      }
      if (discovery.topTags) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}topTags`,
          dbHelpers.stringifyJSON(discovery.topTags),
          now,
        ]);
      }
      if (discovery.topGenres) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}topGenres`,
          dbHelpers.stringifyJSON(discovery.topGenres),
          now,
        ]);
      }
      if (discovery.fallbackGenres) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}fallbackGenres`,
          dbHelpers.stringifyJSON(discovery.fallbackGenres),
          now,
        ]);
      }
      if (discovery.fallbackGenrePools) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}fallbackGenrePools`,
          dbHelpers.stringifyJSON(discovery.fallbackGenrePools),
          now,
        ]);
      }
      if (discovery.discoverPlaylists) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}discoverPlaylists`,
          dbHelpers.stringifyJSON(discovery.discoverPlaylists),
          now,
        ]);
      }
      if (discovery.provider) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [`${prefix}provider`, discovery.provider, now]);
      }
      const hasMetadataUpdate =
        (discovery.metadata && typeof discovery.metadata === "object") ||
        DISCOVERY_METADATA_FIELDS.some((field) =>
          Object.prototype.hasOwnProperty.call(discovery, field),
        );
      if (hasMetadataUpdate) {
        const existingMetadataRow = await db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}metadata`]);
        const existingMetadata = dbHelpers.parseJSON(existingMetadataRow?.value) || {};
        const nextMetadata = {
          ...existingMetadata,
          ...(discovery.metadata && typeof discovery.metadata === "object"
            ? discovery.metadata
            : {}),
        };
        for (const field of DISCOVERY_METADATA_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(discovery, field)) {
            nextMetadata[field] = discovery[field];
          }
        }
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
          `${prefix}metadata`,
          dbHelpers.stringifyJSON(nextMetadata),
          now,
        ]);
      }
      if (cacheNamespace) {
        await db.run(UPSERT_DISCOVERY_CACHE_SQL, [`${prefix}lastUpdated`, now, now]);
      }
    });
  };

  dbOps.deleteDiscoveryCacheByPrefix = async function (prefix) {
    const namespace = String(prefix || "").replace(/%$/, "").replace(/:$/, "");
    discoveryUserCache.delete(namespace);
    return db.run(DELETE_DISCOVERY_CACHE_BY_PREFIX_SQL, [`${prefix}%`]);
  };
}
