import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const execFileAsync = promisify(execFile);

const importScript = fileURLToPath(
  new URL("../../backend/scripts/migrateSqliteToPostgres.js", import.meta.url),
);
// The script migrates into its own schema so this file's schema stays empty.
const importSchema = `${process.env.AURRAL_PG_SCHEMA}_import`;

function writeLegacyDatabase(file) {
  const sqlite = new Database(file);
  sqlite.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      permissions TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    );
  `);
  sqlite
    .prepare("INSERT INTO settings (key, value) VALUES ('integrations', ?)")
    .run(JSON.stringify({ general: { authUser: "boss", authPassword: "AURRAL_ENC:secret" } }));
  sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('boss', 'h', 'admin')").run();
  sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('fan', 'h', 'user')").run();
  sqlite
    .prepare("INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (1, 'legacy', ?, ?)")
    .run(Date.now(), Date.now() + 60_000);
  sqlite.close();
}

test("importing a pre-identity SQLite database upgrades its accounts once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "aurral-sqlite-import-"));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${importSchema}" CASCADE`);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });
  const file = join(dir, "aurral.db");
  writeLegacyDatabase(file);
  const runImport = () =>
    execFileAsync(process.execPath, [importScript, "--sqlite", file], {
      env: { ...process.env, AURRAL_PG_SCHEMA: importSchema },
    });
  const query = async (sql, params = []) => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${importSchema}", public`);
      return (await client.query(sql, params)).rows;
    } finally {
      client.release();
    }
  };
  const accounts = () =>
    query(
      `SELECT username, is_protected, has_local_password, needs_identity_migration
       FROM users ORDER BY username`,
    );

  await runImport();
  assert.deepEqual(await accounts(), [
    { username: "boss", is_protected: 1, has_local_password: 0, needs_identity_migration: 1 },
    { username: "fan", is_protected: 0, has_local_password: 0, needs_identity_migration: 1 },
  ]);
  assert.deepEqual(await query("SELECT token FROM sessions"), []);

  // Accounts and sessions created after the import survive a re-run.
  await query(
    "INSERT INTO users (username, password_hash, role, has_local_password) VALUES ('newcomer', 'h', 'user', 1)",
  );
  await query(
    "INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (1, 'current', $1, $2)",
    [Date.now(), Date.now() + 60_000],
  );
  await runImport();
  assert.deepEqual(await accounts(), [
    { username: "boss", is_protected: 1, has_local_password: 0, needs_identity_migration: 1 },
    { username: "fan", is_protected: 0, has_local_password: 0, needs_identity_migration: 1 },
    { username: "newcomer", is_protected: 0, has_local_password: 1, needs_identity_migration: 0 },
  ]);
  assert.deepEqual(await query("SELECT token FROM sessions"), [{ token: "current" }]);
});
