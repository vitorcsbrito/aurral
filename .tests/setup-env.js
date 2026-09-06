import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";

if (!process.env.AURRAL_DATA_DIR) {
  const dataDir = mkdtempSync(join(tmpdir(), `aurral-test-${process.pid}-`));
  process.env.AURRAL_DATA_DIR = dataDir;
  process.on("exit", () => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });
}

// Per-process schema: concurrent test processes share one database.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://aurral:aurral@localhost:5433/aurral_test";
}
if (!process.env.AURRAL_PG_SCHEMA) {
  process.env.AURRAL_PG_SCHEMA = `test_${process.pid}_${Date.now().toString(36)}`;
}
process.env.AURRAL_TEST_SERVER ??= "1";

const { ensureDatabaseSchemaNamespace, dropDatabaseSchemaNamespace, closeDatabase } =
  await import("../backend/config/database.js");
await ensureDatabaseSchemaNamespace();

// --import preloads run in worker threads; only the owner drops the schema.
let cleaned = false;
if (isMainThread) {
  process.on("beforeExit", () => {
    if (cleaned) return;
    cleaned = true;
    dropDatabaseSchemaNamespace()
      .catch(() => {})
      .then(() => closeDatabase())
      .catch(() => {});
  });
}
