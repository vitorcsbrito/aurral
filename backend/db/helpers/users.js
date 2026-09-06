import { db, dbHelpers } from "../../config/database.js";
import {
  DEFAULT_LISTEN_HISTORY_PROVIDER,
  getListenHistoryProfile,
  normalizeListenHistoryProvider,
  normalizeListenHistoryUsername,
  normalizeListenHistoryUrl,
} from "../../services/listeningHistory.js";

const USER_LIST_COLUMNS =
  "id, username, role, permissions, lastfm_username, listen_history_provider, listen_history_username, listen_history_url, lidarr_root_folder_path, lidarr_quality_profile_id";

const DEFAULT_PERMISSIONS = {
  accessFlow: false,
  addArtist: true,
  addAlbum: true,
  changeMonitoring: false,
  deleteArtist: false,
  deleteAlbum: false,
  deleteTrack: false,
};

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
    ...getListenHistoryProfile(row),
  };
};

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
    const row = await db.get("SELECT id, username, role, permissions FROM users WHERE id = ?", [
      parseInt(id, 10),
    ]);
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      role: row.role || "user",
      permissions: dbHelpers.parseJSON(row.permissions) || { ...DEFAULT_PERMISSIONS },
    };
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
    }));
  },
  async createUser(username, passwordHash, role = "user", permissions = null) {
    const un = String(username).trim();
    if (!un) return null;
    const perms = permissions ? { ...DEFAULT_PERMISSIONS, ...permissions } : { ...DEFAULT_PERMISSIONS };
    try {
      const row = await db.get(
        `INSERT INTO users (username, password_hash, role, permissions, lidarr_root_folder_path, lidarr_quality_profile_id)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        [un.toLowerCase(), passwordHash, role, dbHelpers.stringifyJSON(perms), null, null],
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
      };
    } catch {
      return null;
    }
  },
  async updateUser(id, data) {
    const existing = await userOps.getUserById(id);
    if (!existing) return null;
    const username = data.username !== undefined ? String(data.username).trim() : existing.username;
    const passwordHash = data.passwordHash !== undefined ? data.passwordHash : existing.passwordHash;
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
    try {
      await db.run(
        `UPDATE users SET username = ?, password_hash = ?, role = ?, permissions = ?, lastfm_username = ?,
           listen_history_provider = ?, listen_history_username = ?, listen_history_url = ?,
           lidarr_root_folder_path = ?, lidarr_quality_profile_id = ?
         WHERE id = ?`,
        [
          username.toLowerCase(),
          passwordHash,
          role,
          dbHelpers.stringifyJSON(permissions),
          lastfmUsername,
          listenHistoryProvider,
          resolvedUsername,
          resolvedUrl,
          lidarrRootFolderPath,
          lidarrQualityProfileId,
          parseInt(id, 10),
        ],
      );
      return {
        id: parseInt(id, 10),
        username,
        role,
        permissions,
        listenHistoryProvider,
        listenHistoryUsername: resolvedUsername,
        listenHistoryUrl: resolvedUrl,
        lastfmUsername,
        lidarrRootFolderPath,
        lidarrQualityProfileId,
      };
    } catch {
      return null;
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
