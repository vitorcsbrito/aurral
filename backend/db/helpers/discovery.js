import { db, dbHelpers } from "../../config/database.js";

const GET_DISCOVERY_CACHE_SQL = "SELECT value, last_updated FROM discovery_cache WHERE key = ?";
const LIST_DISCOVERY_CACHE_SQL = "SELECT key, value, last_updated FROM discovery_cache";
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

const DISCOVERY_FIELDS = [
  "metadata",
  "recommendations",
  "globalTop",
  "basedOn",
  "topTags",
  "topGenres",
  "fallbackGenres",
  "fallbackGenrePools",
  "discoverPlaylists",
  "provider",
  "lastUpdated",
];
const DISCOVERY_FIELD_SET = new Set(DISCOVERY_FIELDS);

// Sync mirror of discovery_cache; "" key = global namespace.
const discoveryMirror = new Map();
const mirrorKey = (cacheNamespace) => (cacheNamespace ? String(cacheNamespace) : "");

function splitDiscoveryKey(key) {
  const text = String(key || "");
  const idx = text.lastIndexOf(":");
  if (idx === -1) {
    return DISCOVERY_FIELD_SET.has(text) ? { namespace: null, field: text } : null;
  }
  const field = text.slice(idx + 1);
  if (!DISCOVERY_FIELD_SET.has(field)) return null;
  return { namespace: text.slice(0, idx) || null, field };
}

function buildDiscoveryResult(rowsByField, cacheNamespace) {
  const row = (field) => rowsByField.get(field) || null;
  const metadata = dbHelpers.parseJSON(row("metadata")?.value) || {};
  const recommendations = dbHelpers.parseJSON(row("recommendations")?.value);
  const globalTop = dbHelpers.parseJSON(row("globalTop")?.value);
  const basedOn = dbHelpers.parseJSON(row("basedOn")?.value);
  const topTags = dbHelpers.parseJSON(row("topTags")?.value);
  const topGenres = dbHelpers.parseJSON(row("topGenres")?.value);
  const fallbackGenres = dbHelpers.parseJSON(row("fallbackGenres")?.value);
  const fallbackGenrePools = dbHelpers.parseJSON(row("fallbackGenrePools")?.value);
  const discoverPlaylists = dbHelpers.parseJSON(row("discoverPlaylists")?.value);
  const provider = row("provider")?.value || null;
  const lastUpdated = cacheNamespace
    ? row("lastUpdated")?.value || row("recommendations")?.last_updated || null
    : row("recommendations")?.last_updated || row("globalTop")?.last_updated || null;

  return {
    recommendations: recommendations || [],
    globalTop: globalTop || [],
    basedOn: basedOn || [],
    topTags: topTags || [],
    topGenres: topGenres || [],
    fallbackGenres: fallbackGenres || [],
    fallbackGenrePools:
      fallbackGenrePools && typeof fallbackGenrePools === "object" ? fallbackGenrePools : {},
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
}

async function readDiscoveryRows(cacheNamespace) {
  const prefix = cacheNamespace ? `${cacheNamespace}:` : "";
  const rows = await Promise.all(
    DISCOVERY_FIELDS.map((field) => db.get(GET_DISCOVERY_CACHE_SQL, [`${prefix}${field}`])),
  );
  const rowsByField = new Map();
  DISCOVERY_FIELDS.forEach((field, index) => {
    if (rows[index]) rowsByField.set(field, rows[index]);
  });
  return rowsByField;
}

async function refreshMirror(cacheNamespace) {
  const result = buildDiscoveryResult(await readDiscoveryRows(cacheNamespace), cacheNamespace);
  discoveryMirror.set(mirrorKey(cacheNamespace), result);
  return result;
}

export default function register(dbOps) {
  dbOps.loadDiscoveryCacheMirror = async function () {
    const rows = await db.all(LIST_DISCOVERY_CACHE_SQL);
    const grouped = new Map();
    for (const row of rows) {
      const parsed = splitDiscoveryKey(row.key);
      if (!parsed) continue;
      const key = mirrorKey(parsed.namespace);
      if (!grouped.has(key)) grouped.set(key, new Map());
      grouped.get(key).set(parsed.field, row);
    }
    discoveryMirror.clear();
    for (const [key, rowsByField] of grouped) {
      discoveryMirror.set(key, buildDiscoveryResult(rowsByField, key || null));
    }
    if (!discoveryMirror.has("")) {
      discoveryMirror.set("", buildDiscoveryResult(new Map(), null));
    }
    return discoveryMirror.size;
  };

  dbOps.resetDiscoveryCacheMirror = function () {
    discoveryMirror.clear();
  };

  // Empty shape when namespace unknown or mirror not loaded.
  dbOps.getDiscoveryCacheSync = function (cacheNamespace = null) {
    return (
      discoveryMirror.get(mirrorKey(cacheNamespace)) ||
      buildDiscoveryResult(new Map(), cacheNamespace)
    );
  };

  dbOps.getDiscoveryCache = async function (cacheNamespace = null) {
    return refreshMirror(cacheNamespace);
  };

  dbOps.updateDiscoveryCache = async function (discovery, cacheNamespace = null) {
    const now = new Date().toISOString();
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";
    await db.transaction(async () => {
      const jsonFields = [
        "recommendations",
        "globalTop",
        "basedOn",
        "topTags",
        "topGenres",
        "fallbackGenres",
        "fallbackGenrePools",
        "discoverPlaylists",
      ];
      for (const field of jsonFields) {
        if (discovery[field]) {
          await db.run(UPSERT_DISCOVERY_CACHE_SQL, [
            `${prefix}${field}`,
            dbHelpers.stringifyJSON(discovery[field]),
            now,
          ]);
        }
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
    await refreshMirror(cacheNamespace);
  };

  dbOps.deleteDiscoveryCacheByPrefix = async function (prefix) {
    const namespace = String(prefix || "").replace(/%$/, "").replace(/:$/, "");
    const result = await db.run(DELETE_DISCOVERY_CACHE_BY_PREFIX_SQL, [`${prefix}%`]);
    for (const key of [...discoveryMirror.keys()]) {
      if (key && key.startsWith(namespace)) discoveryMirror.delete(key);
    }
    return result;
  };
}
