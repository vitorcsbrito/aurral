import { db, dbHelpers } from "../../config/database.js";
import { decryptWithKey, encryptWithKey } from "../../config/encryption.js";
import { getSettingsEncryptionKey } from "./settings.js";
import {
  DEFAULT_LISTEN_HISTORY_PROVIDER,
  getListenHistoryProfile,
  normalizeListenHistoryProvider,
  normalizeListenHistoryUsername,
  normalizeListenHistoryUrl,
} from "../../services/listeningHistory.js";

const USER_LIST_COLUMNS =
  "id, username, role, permissions, lastfm_username, listen_history_provider, listen_history_username, listen_history_url, lidarr_root_folder_path, lidarr_quality_profile_id, status, is_protected, role_source, has_local_password, needs_identity_migration, allow_identity_adoption";

const DEFAULT_PERMISSIONS = {
  accessFlow: false,
  addArtist: true,
  addAlbum: true,
  changeMonitoring: false,
  deleteArtist: false,
  deleteAlbum: false,
  deleteTrack: false,
};

// Account lifecycle and identity-linking fields shared by every user shape.
const toLifecycleFields = (row) => ({
  status: row.status || "active",
  isProtected: !!row.is_protected,
  roleSource: row.role_source || "local",
  hasLocalPassword: !!row.has_local_password,
  needsIdentityMigration: !!row.needs_identity_migration,
  allowIdentityAdoption: !!row.allow_identity_adoption,
});

const toUser = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role || "user",
    permissions: dbHelpers.parseJSON(row.permissions) || { ...DEFAULT_PERMISSIONS },
    lidarrRootFolderPath: row.lidarr_root_folder_path || null,
    lidarrQualityProfileId:
      row.lidarr_quality_profile_id != null ? Number(row.lidarr_quality_profile_id) : null,
    ...toLifecycleFields(row),
    ...getListenHistoryProfile(row),
  };
};

function encryptSubsonicPassword(password) {
  const value = password == null ? "" : String(password);
  return value ? encryptWithKey(value, getSettingsEncryptionKey()) : null;
}

function decryptSubsonicPassword(value) {
  if (!value) return null;
  const decrypted = decryptWithKey(value, getSettingsEncryptionKey());
  return decrypted || null;
}

// Applies an updateUser change set to a row read under lock. Errors from the
// write propagate so the caller's transaction rolls back.
async function writeUserUpdate(row, existing, data) {
  const username = data.username !== undefined ? String(data.username).trim() : existing.username;
  const passwordHash = data.passwordHash !== undefined ? data.passwordHash : existing.passwordHash;
  // A new password hash without a matching plaintext drops the stored
  // Subsonic credential so token auth cannot keep using the old password.
  const passwordHashChanged =
    data.passwordHash !== undefined && data.passwordHash !== existing.passwordHash;
  const subsonicPassword =
    data.subsonicPassword !== undefined
      ? encryptSubsonicPassword(data.subsonicPassword)
      : passwordHashChanged
        ? null
        : (row.subsonic_password ?? null);
  const role = data.role !== undefined ? data.role : existing.role;
  const permissions =
    data.permissions !== undefined
      ? { ...DEFAULT_PERMISSIONS, ...data.permissions }
      : existing.permissions;
  const listenHistoryProvider = normalizeListenHistoryProvider(
    data.listenHistoryProvider !== undefined
      ? data.listenHistoryProvider
      : data.lastfmUsername !== undefined
        ? "lastfm"
        : existing.listenHistoryProvider,
  );
  const listenHistoryUsername = normalizeListenHistoryUsername(
    data.listenHistoryUsername !== undefined
      ? data.listenHistoryUsername
      : data.lastfmUsername !== undefined
        ? data.lastfmUsername
        : existing.listenHistoryUsername,
  );
  const listenHistoryUrl = normalizeListenHistoryUrl(
    data.listenHistoryUrl !== undefined ? data.listenHistoryUrl : existing.listenHistoryUrl,
  );
  const resolvedUsername = ["koito", "local"].includes(listenHistoryProvider)
    ? null
    : listenHistoryUsername;
  const resolvedUrl = listenHistoryProvider === "koito" ? listenHistoryUrl : null;
  const lastfmUsername = listenHistoryProvider === "lastfm" ? resolvedUsername : null;
  const lidarrRootFolderPath =
    data.lidarrRootFolderPath !== undefined
      ? data.lidarrRootFolderPath
        ? String(data.lidarrRootFolderPath).trim()
        : null
      : existing.lidarrRootFolderPath;
  const parsedLidarrQualityProfileId =
    data.lidarrQualityProfileId !== undefined && data.lidarrQualityProfileId !== null
      ? Number(data.lidarrQualityProfileId)
      : data.lidarrQualityProfileId === null
        ? null
        : existing.lidarrQualityProfileId;
  const lidarrQualityProfileId =
    parsedLidarrQualityProfileId != null && Number.isFinite(parsedLidarrQualityProfileId)
      ? Math.trunc(parsedLidarrQualityProfileId)
      : parsedLidarrQualityProfileId === null
        ? null
        : existing.lidarrQualityProfileId;
  const status = data.status !== undefined ? data.status : existing.status;
  const roleSource = data.roleSource !== undefined ? data.roleSource : existing.roleSource;
  const hasLocalPassword =
    data.hasLocalPassword !== undefined ? !!data.hasLocalPassword : existing.hasLocalPassword;
  const needsIdentityMigration =
    data.needsIdentityMigration !== undefined
      ? !!data.needsIdentityMigration
      : existing.needsIdentityMigration;
  const allowIdentityAdoption =
    data.allowIdentityAdoption !== undefined
      ? !!data.allowIdentityAdoption
      : existing.allowIdentityAdoption;
  await db.run(
    `UPDATE users SET username = ?, password_hash = ?, subsonic_password = ?, role = ?, permissions = ?,
       lastfm_username = ?, listen_history_provider = ?, listen_history_username = ?, listen_history_url = ?,
       lidarr_root_folder_path = ?, lidarr_quality_profile_id = ?, status = ?, role_source = ?,
       has_local_password = ?, needs_identity_migration = ?, allow_identity_adoption = ?
     WHERE id = ?`,
    [
      username.toLowerCase(),
      passwordHash,
      subsonicPassword,
      role,
      dbHelpers.stringifyJSON(permissions),
      lastfmUsername,
      listenHistoryProvider,
      resolvedUsername,
      resolvedUrl,
      lidarrRootFolderPath,
      lidarrQualityProfileId,
      status,
      roleSource,
      hasLocalPassword ? 1 : 0,
      needsIdentityMigration ? 1 : 0,
      allowIdentityAdoption ? 1 : 0,
      row.id,
    ],
  );
  return {
    id: row.id,
    username,
    role,
    permissions,
    listenHistoryProvider,
    listenHistoryUsername: resolvedUsername,
    listenHistoryUrl: resolvedUrl,
    lastfmUsername,
    lidarrRootFolderPath,
    lidarrQualityProfileId,
    status,
    isProtected: existing.isProtected,
    roleSource,
    hasLocalPassword,
    needsIdentityMigration,
    allowIdentityAdoption,
  };
}

export const userOps = {
  getDefaultPermissions() {
    return { ...DEFAULT_PERMISSIONS };
  },
  async getUserByUsername(username) {
    const row = await db.get("SELECT * FROM users WHERE username = ?", [
      String(username).trim().toLowerCase(),
    ]);
    return toUser(row);
  },
  async getUserById(id) {
    const row = await db.get("SELECT * FROM users WHERE id = ?", [parseInt(id, 10)]);
    return toUser(row);
  },
  async getUserAuthById(id) {
    const row = await db.get(
      "SELECT id, username, role, permissions, status, is_protected, role_source FROM users WHERE id = ?",
      [parseInt(id, 10)],
    );
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || { ...DEFAULT_PERMISSIONS },
      status: row.status || "active",
      isProtected: !!row.is_protected,
      roleSource: row.role_source || "local",
    };
  },
  async getSubsonicPasswordById(id) {
    const row = await db.get("SELECT subsonic_password FROM users WHERE id = ?", [
      parseInt(id, 10),
    ]);
    return decryptSubsonicPassword(row?.subsonic_password);
  },
  // Records a successful password login: the plaintext for Subsonic token
  // auth, an optional rehash, and that the account has a usable password.
  // Nothing is written unless the row still holds the hash the password was
  // verified against, so a login racing a password change cannot store the
  // old password.
  async recordPasswordLogin(id, { verifiedHash, password, newHash = null }) {
    const userId = parseInt(id, 10);
    return db.transaction(async () => {
      const row = await db.get(
        "SELECT password_hash, subsonic_password, has_local_password FROM users WHERE id = ? FOR UPDATE",
        [userId],
      );
      if (!row || !verifiedHash || row.password_hash !== verifiedHash) return false;
      const next = password == null ? "" : String(password);
      const sets = [];
      const params = [];
      if (newHash) {
        sets.push("password_hash = ?");
        params.push(newHash);
      }
      if (decryptSubsonicPassword(row.subsonic_password) !== (next || null)) {
        sets.push("subsonic_password = ?");
        params.push(encryptSubsonicPassword(next));
      }
      if (!row.has_local_password) sets.push("has_local_password = 1");
      if (sets.length === 0) return false;
      await db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, [...params, userId]);
      return true;
    });
  },
  async countUsers() {
    return (await db.get("SELECT COUNT(*) AS count FROM users")).count;
  },
  async getAllUsers() {
    const rows = await db.all(`SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY username`);
    return rows.map((row) => ({
      ...getListenHistoryProfile(row),
      id: row.id,
      username: row.username,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || { ...DEFAULT_PERMISSIONS },
      lidarrRootFolderPath: row.lidarr_root_folder_path || null,
      lidarrQualityProfileId:
        row.lidarr_quality_profile_id != null ? Number(row.lidarr_quality_profile_id) : null,
      ...toLifecycleFields(row),
    }));
  },
  // hasLocalPassword is false for accounts provisioned by an external identity
  // (their password hash is random); isProtected marks the recovery admin.
  async createUser(
    username,
    passwordHash,
    role = "user",
    permissions = null,
    hasLocalPassword = true,
    isProtected = false,
    subsonicPassword = null,
  ) {
    const un = String(username).trim();
    if (!un) return null;
    const perms = permissions ? { ...DEFAULT_PERMISSIONS, ...permissions } : { ...DEFAULT_PERMISSIONS };
    try {
      const row = await db.get(
        `INSERT INTO users (username, password_hash, subsonic_password, role, permissions, lidarr_root_folder_path, lidarr_quality_profile_id, has_local_password, is_protected)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          un.toLowerCase(),
          passwordHash,
          encryptSubsonicPassword(subsonicPassword),
          role,
          dbHelpers.stringifyJSON(perms),
          null,
          null,
          hasLocalPassword ? 1 : 0,
          isProtected ? 1 : 0,
        ],
      );
      return {
        id: row.id,
        username: un,
        role,
        permissions: perms,
        listenHistoryProvider: DEFAULT_LISTEN_HISTORY_PROVIDER,
        listenHistoryUsername: null,
        listenHistoryUrl: null,
        lastfmUsername: null,
        lidarrRootFolderPath: null,
        lidarrQualityProfileId: null,
        status: "active",
        isProtected: !!isProtected,
        roleSource: "local",
        hasLocalPassword: !!hasLocalPassword,
        needsIdentityMigration: false,
        allowIdentityAdoption: false,
      };
    } catch {
      return null;
    }
  },
  // The whole row is rewritten from a locked read, so concurrent updates
  // (an admin role change and a login) cannot write back stale fields.
  async updateUser(id, data) {
    const userId = parseInt(id, 10);
    let writing = false;
    try {
      return await db.transaction(async () => {
        const row = await db.get("SELECT * FROM users WHERE id = ? FOR UPDATE", [userId]);
        const existing = toUser(row);
        if (!existing) return null;
        writing = true;
        const result = await writeUserUpdate(row, existing, data);
        writing = false;
        return result;
      });
    } catch (error) {
      // A rejected write (such as a duplicate username) reports as null.
      if (writing) return null;
      throw error;
    }
  },

  async setProtected(id, isProtected) {
    try {
      await db.run("UPDATE users SET is_protected = ? WHERE id = ?", [
        isProtected ? 1 : 0,
        parseInt(id, 10),
      ]);
      return true;
    } catch {
      return false;
    }
  },
  async deleteUser(id) {
    try {
      await db.run("DELETE FROM users WHERE id = ?", [parseInt(id, 10)]);
      return true;
    } catch {
      return false;
    }
  },
  async getAllListeningHistoryUsers() {
    const rows = await db.all(
      `SELECT id, username, lastfm_username, listen_history_provider, listen_history_username, listen_history_url
       FROM users
       WHERE (listen_history_username IS NOT NULL AND TRIM(listen_history_username) != '')
          OR (listen_history_url IS NOT NULL AND TRIM(listen_history_url) != '')`,
    );
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      ...getListenHistoryProfile(row),
    }));
  },
};
