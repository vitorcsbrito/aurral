import { db, dbHelpers } from "../../config/database.js";

const INSERT_AURRAL_HISTORY_SQL = `
  INSERT INTO aurral_history (
    id, kind, title, subtitle, status, status_label, href, metadata, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    kind = EXCLUDED.kind,
    title = EXCLUDED.title,
    subtitle = EXCLUDED.subtitle,
    status = EXCLUDED.status,
    status_label = EXCLUDED.status_label,
    href = EXCLUDED.href,
    metadata = EXCLUDED.metadata,
    created_at = EXCLUDED.created_at
`;
const GET_AURRAL_HISTORY_SQL = `
  SELECT id, kind, title, subtitle, status, status_label, href, metadata, created_at
  FROM aurral_history
  WHERE created_at >= ?
  ORDER BY created_at DESC
  LIMIT ?
`;
const GET_AURRAL_HISTORY_BY_ID_SQL = `
  SELECT id, kind, title, subtitle, status, status_label, href, metadata, created_at
  FROM aurral_history
  WHERE id = ?
`;
const DELETE_AURRAL_HISTORY_OLDER_THAN_SQL = "DELETE FROM aurral_history WHERE created_at < ?";
const COUNT_AURRAL_HISTORY_SQL = "SELECT COUNT(*) as count FROM aurral_history";
const DELETE_OLDEST_AURRAL_HISTORY_SQL = `
  DELETE FROM aurral_history
  WHERE id IN (
    SELECT id FROM aurral_history
    ORDER BY created_at ASC
    LIMIT ?
  )
`;

export default function register(dbOps) {
  dbOps.insertAurralHistory = async function (entry) {
    if (!entry?.id || !entry?.title) return null;
    await db.run(INSERT_AURRAL_HISTORY_SQL, [
      entry.id,
      entry.kind || "activity",
      entry.title,
      entry.subtitle || null,
      entry.status || "completed",
      entry.statusLabel || null,
      entry.href || null,
      dbHelpers.stringifyJSON(entry.metadata),
      Number(entry.createdAt) || Date.now(),
    ]);
    return entry;
  };

  dbOps.getAurralHistoryById = async function (id) {
    if (!id) return null;
    const row = await db.get(GET_AURRAL_HISTORY_BY_ID_SQL, [String(id)]);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle || null,
      status: row.status || "completed",
      statusLabel: row.status_label || null,
      href: row.href || null,
      metadata: dbHelpers.parseJSON(row.metadata),
      createdAt: row.created_at,
    };
  };

  dbOps.getAurralHistory = async function ({ since = 0, limit = 200 } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const safeSince = Number(since) || 0;
    const rows = await db.all(GET_AURRAL_HISTORY_SQL, [safeSince, safeLimit]);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle || null,
      status: row.status || "completed",
      statusLabel: row.status_label || null,
      href: row.href || null,
      metadata: dbHelpers.parseJSON(row.metadata),
      createdAt: row.created_at,
    }));
  };

  dbOps.pruneAurralHistory = async function ({ maxAgeMs = 30 * 24 * 60 * 60 * 1000, maxEntries = 1000 } = {}) {
    const cutoff = Date.now() - Math.max(0, Number(maxAgeMs) || 0);
    await db.transaction(async () => {
      await db.run(DELETE_AURRAL_HISTORY_OLDER_THAN_SQL, [cutoff]);
      const count = Number((await db.get(COUNT_AURRAL_HISTORY_SQL))?.count || 0);
      const overflow = count - Math.max(1, Number(maxEntries) || 500);
      if (overflow > 0) {
        await db.run(DELETE_OLDEST_AURRAL_HISTORY_SQL, [overflow]);
      }
    });
  };
}
