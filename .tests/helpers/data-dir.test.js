import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

test("the test runner isolates each process from the repository database", () => {
  const schema = process.env.AURRAL_PG_SCHEMA;
  assert.ok(schema, "AURRAL_PG_SCHEMA must be set by .tests/setup-env.js");
  assert.notEqual(
    schema,
    "public",
    "concurrent test processes must not share the public schema",
  );
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must be set by .tests/setup-env.js");
});

test("resolveAurralDataDir prefers AURRAL_DATA_DIR", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aurral-data-dir-"));
  const previous = process.env.AURRAL_DATA_DIR;
  process.env.AURRAL_DATA_DIR = tempDir;
  const { resolveAurralDataDir } = await import(
    "../../backend/config/data-dir.js"
  );
  assert.equal(resolveAurralDataDir(), path.resolve(tempDir));
  if (previous === undefined) delete process.env.AURRAL_DATA_DIR;
  else process.env.AURRAL_DATA_DIR = previous;
});

test("ensureDataDir creates the resolved directory", async () => {
  const tempDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "aurral-data-dir-")),
    "nested",
  );
  const previous = process.env.AURRAL_DATA_DIR;
  process.env.AURRAL_DATA_DIR = tempDir;
  const { ensureDataDir } = await import("../../backend/config/data-dir.js");
  assert.equal(ensureDataDir(), path.resolve(tempDir));
  assert.equal(fs.existsSync(tempDir), true);
  if (previous === undefined) delete process.env.AURRAL_DATA_DIR;
  else process.env.AURRAL_DATA_DIR = previous;
});
