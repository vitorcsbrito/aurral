import { db } from "../../config/database.js";

const INSERT_IDENTITY_SQL = `INSERT INTO user_identities (user_id, provider_type, provider_key, subject, display_name, linked_at)
  VALUES (?, ?, ?, ?, ?, ?) RETURNING id`;

const toIdentity = (row) =>
  row
    ? {
        id: row.id,
        userId: row.user_id,
        providerType: row.provider_type,
        providerKey: row.provider_key,
        subject: row.subject,
        displayName: row.display_name,
        linkedAt: row.linked_at,
      }
    : null;

async function insertIdentity(userId, { providerType, providerKey, subject, displayName = null }) {
  const safeUserId = parseInt(userId, 10);
  const linkedAt = Date.now();
  const row = await db.get(INSERT_IDENTITY_SQL, [
    safeUserId,
    providerType,
    providerKey,
    subject,
    displayName,
    linkedAt,
  ]);
  return toIdentity({
    id: row.id,
    user_id: safeUserId,
    provider_type: providerType,
    provider_key: providerKey,
    subject,
    display_name: displayName,
    linked_at: linkedAt,
  });
}

// A duplicate (provider_type, provider_key, subject) rejects with Postgres
// error code 23505; callers map it to a conflict.
export const userIdentityOps = {
  async findByProvider(providerType, providerKey, subject) {
    return toIdentity(
      await db.get(
        "SELECT * FROM user_identities WHERE provider_type = ? AND provider_key = ? AND subject = ?",
        [providerType, providerKey, subject],
      ),
    );
  },
  async getForUser(userId) {
    const rows = await db.all(
      "SELECT * FROM user_identities WHERE user_id = ? ORDER BY linked_at ASC, id ASC",
      [parseInt(userId, 10)],
    );
    return rows.map(toIdentity);
  },
  async getById(id) {
    return toIdentity(
      await db.get("SELECT * FROM user_identities WHERE id = ?", [parseInt(id, 10)]),
    );
  },
  async countForUser(userId) {
    const row = await db.get("SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ?", [
      parseInt(userId, 10),
    ]);
    return Number(row?.count || 0);
  },
  async unlink(id) {
    const result = await db.run("DELETE FROM user_identities WHERE id = ?", [parseInt(id, 10)]);
    return result.changes > 0;
  },
  // Replaces the user's identity for this provider type (one Plex account per
  // user). Rolls back, keeping the old identity, when the subject is taken.
  async replaceForUser(userId, identity) {
    return db.transaction(async () => {
      await db.run("DELETE FROM user_identities WHERE user_id = ? AND provider_type = ?", [
        parseInt(userId, 10),
        identity.providerType,
      ]);
      return insertIdentity(userId, identity);
    });
  },
  async link(userId, identity) {
    return insertIdentity(userId, identity);
  },
  // True when the account has no local password and at most one identity, so
  // removing an identity could leave it without a way to sign in.
  async isLastSignInMethod(userId) {
    const row = await db.get(
      `SELECT has_local_password,
         (SELECT COUNT(*) FROM user_identities WHERE user_id = users.id) AS identities
       FROM users WHERE id = ?`,
      [parseInt(userId, 10)],
    );
    return !row || (!row.has_local_password && Number(row.identities) <= 1);
  },
  // Removes one of the user's identities unless it is their last usable
  // sign-in method (or force is set). The user row is locked so concurrent
  // removals cannot each pass the check; afterUnlink runs in the same
  // transaction. Resolves { unlinked } or { unlinked: false, reason }.
  async unlinkUnlessLastSignIn(userId, identityId, { force = false, afterUnlink = null } = {}) {
    const safeUserId = parseInt(userId, 10);
    return db.transaction(async () => {
      const user = await db.get("SELECT has_local_password FROM users WHERE id = ? FOR UPDATE", [
        safeUserId,
      ]);
      const identity = user
        ? await db.get("SELECT id FROM user_identities WHERE id = ? AND user_id = ?", [
            parseInt(identityId, 10),
            safeUserId,
          ])
        : null;
      if (!identity) return { unlinked: false, reason: "not_found" };
      const { count } = await db.get(
        "SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ?",
        [safeUserId],
      );
      if (!force && Number(count) <= 1 && !user.has_local_password) {
        return { unlinked: false, reason: "last_auth_method" };
      }
      await db.run("DELETE FROM user_identities WHERE id = ?", [identity.id]);
      if (afterUnlink) await afterUnlink();
      return { unlinked: true };
    });
  },
  // Accounts flagged as predating identity linking stop being adoptable once
  // they have a linked identity. Runs at every startup.
  async reconcileMigrationFlags() {
    const result = await db.run(
      `UPDATE users SET needs_identity_migration = 0, allow_identity_adoption = 0
       WHERE needs_identity_migration = 1
         AND id IN (SELECT DISTINCT user_id FROM user_identities)`,
    );
    return result.changes;
  },
};
