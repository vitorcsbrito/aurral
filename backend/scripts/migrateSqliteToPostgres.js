#!/usr/bin/env node
// Copies an existing aurral.db (SQLite) into the Postgres database at
// DATABASE_URL. Idempotent: rows that already exist are left alone.
//
//   node backend/scripts/migrateSqliteToPostgres.js [--sqlite /config/aurral.db] [--truncate] [--dry-run]

import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { db, closeDatabase, pingDatabase } from "../config/database.js";
import { migrateDatabase } from "../db/pg/schema.js";
import { resolveAurralDataDir } from "../config/data-dir.js";

const require = createRequire(import.meta.url);

// Parents before children so foreign keys resolve.
const TABLE_ORDER = [
  "settings",
  "discovery_cache",
  "images_cache",
  "users",
  "sessions",
  "lastfm_link_states",
  "subsonic_stars",
  "play_events",
  "playlist_download_jobs",
  "deezer_mbid_cache",
  "musicbrainz_artist_mbid_cache",
  "artist_overrides",
  "lidarr_artist_id_map",
  "library_artists",
  "library_albums",
  "library_tracks",
  "library_album_tracks",
  "library_media_files",
  "library_scan_runs",
  "library_genres",
  "library_search_documents",
  "aurral_history",
  "inbox_items",
  "slskd_transfer_history",
  "honker_task_runs",
];

const BATCH_SIZE = 500;

function parseArgs(argv) {
  const args = { sqlite: null, truncate: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--sqlite") args.sqlite = argv[++i];
    else if (arg.startsWith("--sqlite=")) args.sqlite = arg.slice("--sqlite=".length);
    else if (arg === "--truncate") args.truncate = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: migrateSqliteToPostgres.js [--sqlite <path>] [--truncate] [--dry-run]\n" +
          "  DATABASE_URL must point at the target Postgres database.",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function openSqlite(filePath) {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    throw new Error(
      `better-sqlite3 is required to read ${filePath} (npm install better-sqlite3): ${error.message}`,
    );
  }
  return new Database(filePath, { readonly: true, fileMustExist: true });
}

function sqliteTableExists(sqlite, table) {
  return !!sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

function sqliteColumns(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

async function pgColumns(table) {
  const rows = await db.all(
    `
      SELECT column_name, data_type, is_identity, is_generated
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?
      ORDER BY ordinal_position
    `,
    [table],
  );
  return rows.map((row) => ({
    name: row.column_name,
    type: row.data_type,
    identity: row.is_identity === "YES",
    generated: row.is_generated === "ALWAYS",
  }));
}

function coerce(value, type) {
  if (value == null) return null;
  if (type === "bigint" || type === "integer" || type === "smallint") {
    if (typeof value === "bigint") return Number(value);
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }
  if (type === "double precision" || type === "numeric" || type === "real") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (type === "boolean") return Number(value) !== 0 && value !== false;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : String(value);
}

async function copyTable(sqlite, table, { dryRun }) {
  if (!sqliteTableExists(sqlite, table)) {
    return { table, skipped: "missing in sqlite", copied: 0, total: 0 };
  }
  const target = (await pgColumns(table)).filter((column) => !column.generated);
  if (target.length === 0) {
    return { table, skipped: "missing in postgres", copied: 0, total: 0 };
  }
  const sourceColumns = new Set(sqliteColumns(sqlite, table));
  const columns = target.filter((column) => sourceColumns.has(column.name));
  if (columns.length === 0) {
    return { table, skipped: "no shared columns", copied: 0, total: 0 };
  }
  const total = Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  if (dryRun) return { table, copied: 0, total, columns: columns.map((c) => c.name) };

  const hasIdentity = columns.some((column) => column.identity);
  const columnList = columns.map((column) => `"${column.name}"`).join(", ");
  const selectSql = `SELECT ${columnList} FROM ${table}`;
  let copied = 0;
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const params = [];
    const tuples = batch.map((row) => {
      const placeholders = columns.map((column) => {
        params.push(coerce(row[column.name], column.type));
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const result = await db.run(
      `INSERT INTO ${table} (${columnList})${hasIdentity ? " OVERRIDING SYSTEM VALUE" : ""} VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
      params,
    );
    copied += Number(result.changes || 0);
    batch = [];
  };

  await db.transaction(async () => {
    for (const row of sqlite.prepare(selectSql).iterate()) {
      batch.push(row);
      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    if (hasIdentity) {
      const identity = columns.find((column) => column.identity).name;
      await db.exec(
        `SELECT setval(pg_get_serial_sequence('${table}', '${identity}'), COALESCE((SELECT MAX("${identity}") FROM ${table}), 0) + 1, false)`,
      );
    }
  });

  return { table, copied, total };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sqlitePath = path.resolve(
    args.sqlite || process.env.AURRAL_DB_PATH || path.join(resolveAurralDataDir(), "aurral.db"),
  );
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found at ${sqlitePath}`);
  }

  const info = await pingDatabase();
  console.log(`Source: ${sqlitePath}`);
  console.log(`Target: ${info?.version || "Postgres"}`);
  await migrateDatabase(db, { logger: console });

  const sqlite = openSqlite(sqlitePath);
  try {
    if (args.truncate && !args.dryRun) {
      const existing = [];
      for (const table of TABLE_ORDER) {
        if ((await pgColumns(table)).length > 0) existing.push(table);
      }
      await db.exec(`TRUNCATE ${existing.join(", ")} CASCADE`);
      console.log(`Truncated ${existing.length} table(s)`);
    }
    for (const table of TABLE_ORDER) {
      const result = await copyTable(sqlite, table, { dryRun: args.dryRun });
      if (result.skipped) {
        console.log(`${table}: skipped (${result.skipped})`);
      } else if (args.dryRun) {
        console.log(`${table}: ${result.total} row(s) would be copied`);
      } else {
        console.log(`${table}: ${result.copied}/${result.total} row(s) inserted`);
      }
    }
  } finally {
    sqlite.close();
  }
}

main()
  .then(() => closeDatabase())
  .then(() => {
    console.log("Done.");
  })
  .catch(async (error) => {
    console.error(`Migration failed: ${error.message}`);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
