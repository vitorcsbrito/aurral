import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

// Postgres is the only backend. DATABASE_URL is required; there is no
// embedded fallback.
const { Pool, types } = pg;

// int8/numeric arrive as strings from pg; ids and epoch millis are numbers.
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));

const DEFAULT_POOL_MAX = 10;

export function resolveDatabaseConfig(env = process.env) {
  const connectionString = String(env.DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Aurral needs a Postgres connection string, e.g. postgres://user:pass@host:5432/aurral",
    );
  }
  const max = Number.parseInt(String(env.AURRAL_PG_POOL_MAX || ""), 10);
  const schema = String(env.AURRAL_PG_SCHEMA || "").trim();
  if (schema && !/^[a-z_][a-z0-9_]*$/i.test(schema)) {
    throw new Error(`AURRAL_PG_SCHEMA must be a plain identifier, got "${schema}"`);
  }
  return {
    connectionString,
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_POOL_MAX,
    applicationName: env.AURRAL_PG_APPLICATION_NAME || "aurral",
    schema: schema || null,
  };
}

// Rewrites `?` placeholders to `$1..$n`, skipping quoted strings, dollar
// quotes, and comments. SQL already using `$n` is returned unchanged.
export function toPositionalPlaceholders(sql) {
  if (!sql.includes("?")) return sql;
  let out = "";
  let index = 0;
  let count = 0;
  const length = sql.length;
  while (index < length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'" || char === '"') {
      const quote = char;
      let end = index + 1;
      while (end < length) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      out += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? length : end;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? length : end + 2;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "$" && next === "$") {
      const end = sql.indexOf("$$", index + 2);
      const stop = end === -1 ? length : end + 2;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "?") {
      count += 1;
      out += `$${count}`;
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const normalizeParams = (params) => {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params)) return [params];
  return params.map((value) => (value === undefined ? null : value));
};

const transactionContext = new AsyncLocalStorage();

// Inside db.transaction(), the async context routes queries to its client.
function createSession(execute) {
  return {
    async query(sql, params) {
      const result = await execute(toPositionalPlaceholders(sql), normalizeParams(params));
      return result.rows;
    },
    async all(sql, params) {
      const result = await execute(toPositionalPlaceholders(sql), normalizeParams(params));
      return result.rows;
    },
    async get(sql, params) {
      const result = await execute(toPositionalPlaceholders(sql), normalizeParams(params));
      return result.rows[0];
    },
    async run(sql, params) {
      const result = await execute(toPositionalPlaceholders(sql), normalizeParams(params));
      return { changes: result.rowCount ?? 0, rows: result.rows };
    },
    async exec(sql) {
      await execute(sql, []);
    },
  };
}

let pool = null;
let poolConfig = null;

function getPool() {
  if (!pool) {
    poolConfig = resolveDatabaseConfig();
    pool = new Pool({
      connectionString: poolConfig.connectionString,
      max: poolConfig.max,
      allowExitOnIdle: true,
      application_name: poolConfig.applicationName,
      // Test processes each get their own schema on a shared database.
      ...(poolConfig.schema ? { options: `-c search_path=${poolConfig.schema},public` } : {}),
    });
    pool.on("error", (error) => {
      console.error(`[db] Idle Postgres client error: ${error?.message || error}`);
    });
  }
  return pool;
}

export async function ensureDatabaseSchemaNamespace() {
  const config = poolConfig || resolveDatabaseConfig();
  if (!config.schema) return null;
  await getPool().query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
  return config.schema;
}

export async function dropDatabaseSchemaNamespace() {
  const config = poolConfig || resolveDatabaseConfig();
  if (!config.schema) return null;
  await getPool().query(`DROP SCHEMA IF EXISTS "${config.schema}" CASCADE`);
  return config.schema;
}

const executeOnPool = (sql, params) => getPool().query(sql, params);

function currentExecute() {
  const active = transactionContext.getStore();
  return active ? active.execute : executeOnPool;
}

const routed = createSession((sql, params) => currentExecute()(sql, params));

let savepointCounter = 0;

// Runs `fn` inside BEGIN/COMMIT on a dedicated client. Nested calls become
// savepoints on the same client.
async function transaction(fn) {
  const active = transactionContext.getStore();
  if (active) {
    savepointCounter += 1;
    const name = `sp_${savepointCounter}`;
    await active.execute(`SAVEPOINT ${name}`, []);
    try {
      const result = await fn(routed);
      await active.execute(`RELEASE SAVEPOINT ${name}`, []);
      return result;
    } catch (error) {
      await active.execute(`ROLLBACK TO SAVEPOINT ${name}`, []);
      throw error;
    }
  }
  const client = await getPool().connect();
  const execute = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    const result = await transactionContext.run({ execute, client }, () => fn(routed));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export const db = {
  ...routed,
  transaction,
  inTransaction: () => Boolean(transactionContext.getStore()),
  get pool() {
    return getPool();
  },
};

export const dbHelpers = {
  parseJSON: (text) => {
    if (text === null || text === undefined || text === "") return null;
    if (typeof text === "object") return text;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },

  stringifyJSON: (obj) => {
    if (obj === undefined) return null;
    try {
      return JSON.stringify(obj);
    } catch {
      return null;
    }
  },
};

export async function pingDatabase() {
  await ensureDatabaseSchemaNamespace();
  const row = await db.get("SELECT current_database() AS database, version() AS version");
  return row;
}

export async function closeDatabase() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}
