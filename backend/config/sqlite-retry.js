// SQLite reports lock races as errors the caller is expected to retry.
// SQLITE_PROTOCOL: a WAL read/write start lost the header race ~100 times
// (~10 s) against a busy writer on another connection.
const TRANSIENT_SQLITE_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_PROTOCOL",
]);

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 100;

export function isTransientSqliteError(error) {
  return TRANSIENT_SQLITE_CODES.has(String(error?.code || ""));
}

// Runs a synchronous SQLite operation, retrying transient lock errors with
// exponential backoff. Resolves with the operation's return value.
export async function runWithSqliteRetry(
  operation,
  { attempts = DEFAULT_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, onRetry = null } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isTransientSqliteError(error) || attempt >= attempts) throw error;
      onRetry?.(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}
