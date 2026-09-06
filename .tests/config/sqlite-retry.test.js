import test from "node:test";
import assert from "node:assert/strict";
import { isTransientSqliteError, runWithSqliteRetry } from "../../backend/config/sqlite-retry.js";

const sqliteError = (code) => Object.assign(new Error(code.toLowerCase()), { code });

test("runWithSqliteRetry retries transient lock errors and returns the result", async () => {
  let calls = 0;
  const retries = [];
  const result = await runWithSqliteRetry(
    () => {
      calls += 1;
      if (calls < 3) throw sqliteError(calls === 1 ? "SQLITE_PROTOCOL" : "SQLITE_BUSY");
      return "ok";
    },
    { baseDelayMs: 1, onRetry: (error, attempt) => retries.push([error.code, attempt]) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(retries, [
    ["SQLITE_PROTOCOL", 1],
    ["SQLITE_BUSY", 2],
  ]);
});

test("runWithSqliteRetry gives up after the configured attempts", async () => {
  let calls = 0;
  await assert.rejects(
    runWithSqliteRetry(
      () => {
        calls += 1;
        throw sqliteError("SQLITE_PROTOCOL");
      },
      { attempts: 3, baseDelayMs: 1 },
    ),
    { code: "SQLITE_PROTOCOL" },
  );
  assert.equal(calls, 3);
});

test("runWithSqliteRetry rethrows non-transient errors immediately", async () => {
  let calls = 0;
  await assert.rejects(
    runWithSqliteRetry(() => {
      calls += 1;
      throw sqliteError("SQLITE_CONSTRAINT_UNIQUE");
    }),
    { code: "SQLITE_CONSTRAINT_UNIQUE" },
  );
  assert.equal(calls, 1);
  assert.equal(isTransientSqliteError(sqliteError("SQLITE_CONSTRAINT_UNIQUE")), false);
  assert.equal(isTransientSqliteError(sqliteError("SQLITE_PROTOCOL")), true);
  assert.equal(isTransientSqliteError(new Error("plain")), false);
});
