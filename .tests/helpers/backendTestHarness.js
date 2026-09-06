import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawn } from "child_process";
import http from "http";
import net from "net";
import { db } from "../../backend/config/database.js";
import { migrateDatabase } from "../../backend/db/pg/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const RESET_TABLES = [
  "sessions",
  "lastfm_link_states",
  "subsonic_stars",
  "play_events",
  "honker_task_runs",
  "slskd_transfer_history",
  "playlist_download_jobs",
  "inbox_items",
  "users",
  "discovery_cache",
  "images_cache",
  "deezer_mbid_cache",
  "musicbrainz_artist_mbid_cache",
  "artist_overrides",
  "lidarr_artist_id_map",
  "library_media_files",
  "library_album_tracks",
  "library_tracks",
  "library_albums",
  "library_artists",
  "library_scan_runs",
  "library_search_documents",
  "settings",
];

export async function createIsolatedStateDir(
  name = "test",
  { dataDirRelativePath = "data" } = {},
) {
  const baseDir = await mkdtemp(
    join(tmpdir(), `aurral-${String(name || "test")}-`),
  );
  const dataDir = join(baseDir, dataDirRelativePath);
  await mkdir(dataDir, { recursive: true });
  return {
    baseDir,
    dataDir,
  };
}

export function applyIsolatedBackendEnv(paths) {
  process.env.AURRAL_DATA_DIR = paths.dataDir;
  process.env.AURRAL_HONKER_DB_PATH = join(paths.dataDir, "honker.db");
  process.env.WEEKLY_FLOW_FOLDER = join(paths.baseDir, "weekly-flow");
  process.env.DOWNLOAD_FOLDER = join(paths.baseDir, "downloads");
  process.env.NODE_ENV = "test";
  process.env.JSON_BODY_LIMIT = "2mb";
}

export async function cleanupIsolatedState(paths) {
  if (!paths?.baseDir) return;
  try {
    const honkerRuntime = await importFromRepo(
      "backend/services/honkerWorkerRuntime.js",
    );
    await honkerRuntime.shutdownHonkerInfrastructure({ timeoutMs: 5000 });
  } catch {}
  try {
    const honkerDb = await importFromRepo("backend/services/honkerDb.js");
    honkerDb.closeHonkerDb();
  } catch {}
  // Workers may still write here; retry ENOTEMPTY/EBUSY briefly.
  await rm(paths.baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export async function importFromRepo(relativePath) {
  const moduleUrl = pathToFileURL(join(repoRoot, relativePath)).href;
  return import(moduleUrl);
}

export async function setupIsolatedBackend(name, ...modulePaths) {
  const paths = await createIsolatedStateDir(name);
  applyIsolatedBackendEnv(paths);
  await ensureTestDatabase();
  await reloadMirrors();
  const modules = await Promise.all(modulePaths.map(importFromRepo));
  return [paths, ...modules];
}

let schemaReady = null;

// Applies the Postgres schema once per test process (schema from setup-env).
export function ensureTestDatabase() {
  if (!schemaReady) schemaReady = migrateDatabase(db, { logger: { info() {} } });
  return schemaReady;
}

// Reloads the sync mirrors so callers see the reset state immediately.
export async function reloadMirrors() {
  const settings = await importFromRepo("backend/db/helpers/settings.js");
  await settings.loadSettingsCache();
  const helpers = await importFromRepo("backend/db/helpers/index.js");
  await helpers.dbOps.loadDiscoveryCacheMirror();
}

export async function resetDatabase() {
  await ensureTestDatabase();
  // TRUNCATE needs ACCESS EXCLUSIVE; background pollers deadlock it (40P01).
  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.exec(`TRUNCATE ${RESET_TABLES.join(", ")} CASCADE`);
      break;
    } catch (error) {
      if (error?.code !== "40P01" || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  await reloadMirrors();
}

export function createMockHttpServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function probeServerHealth(port) {
  const status = await new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health/live",
        timeout: 1000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode || 0);
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("Health probe timed out"));
    });
    request.on("error", reject);
  });
  return status >= 200 && status < 300;
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 30000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(
        `Server exited before ready${lastError ? `: ${lastError}` : ""}`,
      );
    }
    try {
      if (await probeServerHealth(port)) {
        return;
      }
      lastError = "Unexpected health status";
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for server on port ${port}: ${lastError}`);
}

// Asks the OS for a free port; concurrent test processes stop colliding.
async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function startServerProcess({
  port,
  extraEnv = {},
} = {}) {
  const chosenPort =
    Number.isInteger(port) && port > 0 ? port : await findFreePort();
  const child = spawn("node", ["backend/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(chosenPort),
      AURRAL_TEST_SERVER: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  try {
    await waitForServer(chosenPort, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\n${logs}`.trim());
  }
  return {
    child,
    port: chosenPort,
    logs: () => logs,
    async stop() {
      if (child.exitCode != null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}
