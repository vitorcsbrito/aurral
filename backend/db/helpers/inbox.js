import { db, dbHelpers } from "../../config/database.js";

const mapInboxRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    sourceKey: row.source_key,
    title: row.title,
    subtitle: row.subtitle || null,
    href: row.href || null,
    imageUrl: row.image_url || null,
    metadata: dbHelpers.parseJSON(row.metadata) || {},
    isRead: row.is_read === 1,
    isSaved: row.is_saved === 1,
    isDismissed: row.is_dismissed === 1,
    isAdded: row.is_added === 1,
    dismissedUntil: row.dismissed_until || null,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const GET_INBOX_ITEMS_SQL = `
  SELECT *
  FROM inbox_items
  WHERE user_id = ?
    AND is_dismissed = 0
    AND (expires_at IS NULL OR expires_at > ?)
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`;

const GET_UNREAD_INBOX_ITEMS_SQL = `
  SELECT *
  FROM inbox_items
  WHERE user_id = ?
    AND is_read = 0
    AND is_dismissed = 0
    AND (expires_at IS NULL OR expires_at > ?)
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`;

const GET_UNREAD_COUNT_SQL = `
  SELECT COUNT(*) AS count
  FROM inbox_items
  WHERE user_id = ?
    AND is_read = 0
    AND is_dismissed = 0
    AND (expires_at IS NULL OR expires_at > ?)
`;

const GET_ITEM_SQL = "SELECT * FROM inbox_items WHERE user_id = ? AND id = ?";

const normalizeKinds = (kinds) =>
  [...new Set((Array.isArray(kinds) ? kinds : []).map((kind) => String(kind || "").trim()).filter(Boolean))];

const kindClause = (kinds) =>
  kinds.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";

const UPSERT_INBOX_ITEM_SQL = `
  INSERT INTO inbox_items (
    id,
    user_id,
    kind,
    source_key,
    title,
    subtitle,
    href,
    image_url,
    metadata,
    expires_at,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, kind, source_key) DO UPDATE SET
    title = EXCLUDED.title,
    subtitle = EXCLUDED.subtitle,
    href = EXCLUDED.href,
    image_url = EXCLUDED.image_url,
    metadata = EXCLUDED.metadata,
    expires_at = EXCLUDED.expires_at,
    is_read = CASE
      WHEN inbox_items.dismissed_until IS NOT NULL
        AND inbox_items.dismissed_until <= EXCLUDED.updated_at THEN 0
      ELSE inbox_items.is_read
    END,
    is_dismissed = CASE
      WHEN inbox_items.dismissed_until IS NOT NULL
        AND inbox_items.dismissed_until <= EXCLUDED.updated_at THEN 0
      ELSE inbox_items.is_dismissed
    END,
    dismissed_until = CASE
      WHEN inbox_items.dismissed_until IS NOT NULL
        AND inbox_items.dismissed_until <= EXCLUDED.updated_at THEN NULL
      ELSE inbox_items.dismissed_until
    END,
    updated_at = EXCLUDED.updated_at
`;

const UPDATE_INBOX_ITEM_SQL = `
  UPDATE inbox_items
  SET is_read = ?, is_saved = ?, is_dismissed = ?, is_added = ?,
      dismissed_until = ?, updated_at = ?
  WHERE user_id = ? AND id = ?
`;

const MARK_ALL_INBOX_ITEMS_READ_SQL = `
  UPDATE inbox_items
  SET is_read = 1, updated_at = ?
  WHERE user_id = ? AND is_dismissed = 0 AND is_read = 0
`;

export default function register(dbOps) {
  dbOps.getInboxItems = async function (userId, { limit = 50, unreadOnly = false, kinds = [] } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 50)));
    const selectedKinds = normalizeKinds(kinds);
    if (selectedKinds.length > 0) {
      const sql = `
        SELECT *
        FROM inbox_items
        WHERE user_id = ?
          ${unreadOnly ? "AND is_read = 0" : ""}
          AND is_dismissed = 0
          AND (expires_at IS NULL OR expires_at > ?)
          ${kindClause(selectedKinds)}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `;
      const rows = await db.all(sql, [Number(userId), Date.now(), ...selectedKinds, safeLimit]);
      return rows.map(mapInboxRow);
    }
    const sql = unreadOnly ? GET_UNREAD_INBOX_ITEMS_SQL : GET_INBOX_ITEMS_SQL;
    const rows = await db.all(sql, [Number(userId), Date.now(), safeLimit]);
    return rows.map(mapInboxRow);
  };

  dbOps.getInboxUnreadCount = async function (userId, kinds = []) {
    const selectedKinds = normalizeKinds(kinds);
    if (selectedKinds.length > 0) {
      const sql = `
        SELECT COUNT(*) AS count
        FROM inbox_items
        WHERE user_id = ?
          AND is_read = 0
          AND is_dismissed = 0
          AND (expires_at IS NULL OR expires_at > ?)
          ${kindClause(selectedKinds)}
      `;
      const row = await db.get(sql, [Number(userId), Date.now(), ...selectedKinds]);
      return Number(row?.count || 0);
    }
    const row = await db.get(GET_UNREAD_COUNT_SQL, [Number(userId), Date.now()]);
    return Number(row?.count || 0);
  };

  dbOps.getInboxItem = async function (userId, itemId) {
    const row = await db.get(GET_ITEM_SQL, [Number(userId), String(itemId || "")]);
    return mapInboxRow(row);
  };

  dbOps.upsertInboxItem = async function (item) {
    const now = Date.now();
    const userId = Number(item?.userId);
    const kind = String(item?.kind || "").trim();
    const sourceKey = String(item?.sourceKey || "").trim();
    const title = String(item?.title || "").trim();
    if (!Number.isInteger(userId) || userId <= 0 || !kind || !sourceKey || !title) {
      return null;
    }
    const id = String(item.id || `${userId}:${kind}:${sourceKey}`);
    await db.run(UPSERT_INBOX_ITEM_SQL, [
      id,
      userId,
      kind,
      sourceKey,
      title,
      item.subtitle ? String(item.subtitle) : null,
      item.href ? String(item.href) : null,
      item.imageUrl ? String(item.imageUrl) : null,
      dbHelpers.stringifyJSON(item.metadata || {}),
      item.expiresAt == null ? null : Number(item.expiresAt),
      Number(item.createdAt) || now,
      now,
    ]);
    const row = await db.get(GET_ITEM_SQL, [userId, id]);
    return mapInboxRow(row);
  };

  dbOps.updateInboxItem = async function (userId, itemId, updates = {}) {
    const current = await db.get(GET_ITEM_SQL, [Number(userId), String(itemId || "")]);
    if (!current) return null;
    const nextRead = updates.isRead === undefined ? current.is_read : updates.isRead ? 1 : 0;
    const nextSaved = updates.isSaved === undefined ? current.is_saved : updates.isSaved ? 1 : 0;
    const nextDismissed =
      updates.isDismissed === undefined ? current.is_dismissed : updates.isDismissed ? 1 : 0;
    const nextAdded = updates.isAdded === undefined ? current.is_added : updates.isAdded ? 1 : 0;
    const nextDismissedUntil =
      updates.dismissedUntil === undefined ? current.dismissed_until : updates.dismissedUntil;
    await db.run(UPDATE_INBOX_ITEM_SQL, [
      nextRead,
      nextSaved,
      nextDismissed,
      nextAdded,
      nextDismissedUntil == null ? null : Number(nextDismissedUntil),
      Date.now(),
      Number(userId),
      String(itemId),
    ]);
    const row = await db.get(GET_ITEM_SQL, [Number(userId), String(itemId)]);
    return mapInboxRow(row);
  };

  dbOps.markAllInboxItemsRead = async function (userId) {
    return await db.run(MARK_ALL_INBOX_ITEMS_READ_SQL, [Date.now(), Number(userId)]);
  };
}

export { mapInboxRow };
