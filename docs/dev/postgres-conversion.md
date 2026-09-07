# Converting a module from SQLite to Postgres

Aurral moved from better-sqlite3 (synchronous) to Postgres via
`backend/config/database.js` (asynchronous). New code follows the rules
below. Only `backend/scripts/migrateSqliteToPostgres.js` may import
`better-sqlite3`; the Honker job queue keeps its own SQLite file through
`backend/services/honkerDb.js`.

## The client

```js
import { db, dbHelpers } from "../config/database.js";

await db.all(sql, params);   // rows
await db.get(sql, params);   // first row or undefined
await db.run(sql, params);   // { changes, rows }
await db.exec(sql);          // multi-statement DDL, no params
await db.transaction(async () => { ... });  // BEGIN/COMMIT, nested = savepoint
```

`params` is always an array. `?` placeholders are rewritten to `$n`; `$n`
also works. Queries made inside `db.transaction()` run on its client
automatically, so helpers called from inside a transaction need no `tx`
argument. `db.inTransaction()` reports whether one is active.

Never open a `db.transaction()` and then `await` something unrelated to the
database for a long time inside it (HTTP calls, file scans): it pins a pool
connection.

## Mechanical rewrites

| SQLite | Postgres |
| --- | --- |
| `const stmt = db.prepare(sql)` at module level; `stmt.get(a, b)` | `await db.get(sql, [a, b])` inline (keep the SQL string as a module constant when reused) |
| `stmt.all(...)` / `stmt.run(...)` | `await db.all(sql, [...])` / `await db.run(sql, [...])` |
| `stmt.iterate(...)` | `await db.all(...)` then iterate |
| `result.lastInsertRowid` | append `RETURNING id` and use `(await db.get(...)).id` |
| `result.changes` | `(await db.run(...)).changes` |
| `db.transaction(() => { ... })()` | `await db.transaction(async () => { ... })` |
| `db.transaction(fn).deferred` | `await db.transaction(async () => ...)` (no distinction) |
| `INSERT OR REPLACE INTO t (k, v) VALUES (?, ?)` | `INSERT INTO t (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v` |
| `INSERT OR IGNORE INTO ...` | `INSERT INTO ... ON CONFLICT DO NOTHING` |
| `col COLLATE NOCASE` (ORDER BY / index / compare) | `lower(col)` |
| `col LIKE ?` relying on case-insensitivity | `col ILIKE ?` |
| `json_extract(col, '$.a.b')` | `aurral_json(col) -> 'a' ->> 'b'` (`aurral_json` returns NULL for invalid text) |
| `json_valid(col)` guards | drop; `aurral_json` already tolerates bad JSON |
| `json_each(...)` over arrays | `jsonb_array_elements_text(...)` |
| `group_concat(x)` / `group_concat(DISTINCT x)` | `string_agg(x, ',')` / `string_agg(DISTINCT x, ',')` |
| `MAX(a, b)` (two-argument scalar) | `GREATEST(a, b)` |
| `SUM(cond)` | `COUNT(*) FILTER (WHERE cond)` |
| `IFNULL` | `COALESCE` |
| `unixepoch()` | `EXTRACT(EPOCH FROM now())::BIGINT` |
| `rowid` | `id` |
| `PRAGMA table_info(t)` | `SELECT column_name FROM information_schema.columns WHERE table_name = 't'` |
| `sqlite_master` lookups | `SELECT to_regclass('t')` (NULL when missing) |
| `library_search_fts MATCH ?` | `search_document.search_text LIKE '%' \|\| lower(?) \|\| '%'` (pg_trgm GIN index) |
| `WITHOUT ROWID`, `AUTOINCREMENT`, `PRAGMA ...` | remove; schema lives in `backend/db/pg/schema.js` |
| `db.exec` of `CREATE TABLE ...` at runtime | remove; add to the schema migrations instead |
| boolean-ish `col = 1` on INTEGER flag columns | keep as is (columns stay INTEGER 0/1) |
| `LIMIT ? OFFSET ?` | keep |
| `random()` | keep |

Postgres compares `TEXT` case-sensitively and `=` on `NULL` is never true, same
as SQLite. Integers arrive as JS numbers (int8 is parsed). Timestamps are
epoch milliseconds in `BIGINT` columns, unchanged.

Placeholder parameters must not be `undefined`; the client turns `undefined`
into `NULL`, but be explicit where the old code passed nothing.

## Making callers async

When a helper becomes `async`, every caller must `await` it, and its callers
in turn become `async`. Follow the chain up to the route handler, worker
loop, or startup code. Watch for:

- default parameter values such as `(settings = dbOps.getSettings())` (only
  `getSettings()` is allowed to stay synchronous; see below);
- `Array.prototype.map/filter/forEach` callbacks that call a now-async
  helper: switch to `for ... of` with `await`, or `Promise.all` when order
  does not matter and the work is read-only;
- getters, constructors, and module top-level code: move the DB access into
  an explicit `async init()` invoked from `appRuntime`;
- Express middleware: make the middleware `async` and wrap in try/catch
  calling `next(error)`.

## What stays synchronous

`dbOps.getSettings()` and `dbOps.getJSONSetting(key)` read an in-memory
mirror of the `settings` table loaded by `loadSettingsCache()` at startup.
Writes (`updateSettings`, `setJSONSetting`, `deleteSetting`) are async and
update the mirror after the database commits. Use
`await dbOps.readJSONSetting(key)` when a key may have been written by
another process or thread (scan worker, migration script).

Two more mirrors follow the same pattern and are loaded by
`initializeDataLayer()` in `backend/services/appRuntime.js` before the HTTP
server listens:

- the discovery cache (`dbOps.getDiscoveryCacheSync(namespace)`, refreshed
  after every `updateDiscoveryCache`);
- the weekly-flow download tracker, whose in-memory job map is authoritative
  and persists through an ordered write-behind queue
  (`flushDownloadTrackerWrites()` awaits it).

Every other read goes through `await`. Do not add new mirrors; make the
caller async instead.

## Tests

Tests run against a real Postgres. `.tests/setup-env.js` points
`DATABASE_URL` at `postgres://aurral:aurral@localhost:5433/aurral_test` unless
set, gives each test process its own schema (`AURRAL_PG_SCHEMA`), and drops it
at exit. Start the local server with:

```
docker run -d --name aurral-test-pg -e POSTGRES_USER=aurral -e POSTGRES_PASSWORD=aurral \
  -e POSTGRES_DB=aurral_test -p 5433:5432 postgres:18-alpine
```

`setupIsolatedBackend()` from `.tests/helpers/backendTestHarness.js` migrates
the schema and loads the mirrors before importing the modules under test;
`await resetDatabase()` truncates every table and reloads the mirrors between
cases. Convert `test("...", () => {...})` bodies to `async` and `await` the
helpers; replace assertions on `lastInsertRowid` with the returned id.
Library scan worker threads inherit `AURRAL_PG_SCHEMA`, so their writes land
in the same schema as the test that spawned them.

Run a subset with:

```
node --test --import ./.tests/setup-env.js --test-timeout=60000 .tests/db/*.test.js
```
