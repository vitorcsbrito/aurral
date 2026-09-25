import axios from "../../lib/axiosFetch.js";
import { readPlaylistPages, requirePlaylistPath } from "./playback/playlistUsage.js";

const CLIENT_NAME = "Aurral";
const CLIENT_VERSION = "1.0.0";
const JELLYFIN_TIMEOUT_MS = 30_000;

export class JellyfinClient {
  constructor(url, apiKey, userId) {
    this.url = url ? String(url).replace(/\/+$/, "") : null;
    this.apiKey = apiKey || null;
    this.userId = userId ? String(userId).trim() : null;
  }

  isConfigured() {
    return Boolean(this.url && this.apiKey && this.userId);
  }

  headers() {
    return {
      Accept: "application/json",
      Authorization: `MediaBrowser Client="${CLIENT_NAME}", Device="${CLIENT_NAME}", DeviceId="aurral", Version="${CLIENT_VERSION}", Token="${this.apiKey || ""}"`,
    };
  }

  async request(method, endpoint, { params, data } = {}) {
    if (!this.isConfigured()) throw new Error("Jellyfin is not configured");
    const response = await axios({
      method,
      url: `${this.url}${endpoint}`,
      params,
      data,
      headers: this.headers(),
      timeout: JELLYFIN_TIMEOUT_MS,
    });
    return response.data;
  }

  async ping() {
    return this.request("GET", "/System/Info");
  }

  async getUser() {
    return this.request("GET", `/Users/${encodeURIComponent(this.userId)}`);
  }

  async getUsers() {
    return this.request("GET", "/Users");
  }

  async getPlaylistTrackPaths(excludedIds = new Set()) {
    // An API key can enumerate users; query each user's private playlists too.
    const users = await this.getUsers();
    if (!Array.isArray(users) || !users.length || users.some((user) => !user?.Id)) {
      throw new Error("Cannot enumerate Jellyfin users for playlist protection");
    }
    const paths = new Set();
    for (const user of users) {
      const playlists = await readPlaylistPages(async (startIndex) => {
        const page = await this.request("GET", "/Items", { params: {
          userId: user.Id, recursive: true, includeItemTypes: "Playlist",
          startIndex, limit: 200, enableTotalRecordCount: true,
        } });
        return { items: page?.Items, total: page?.TotalRecordCount };
      });
      for (const playlist of playlists) {
        if (!playlist?.Id) throw new Error("Jellyfin playlist is missing its ID");
        const id = String(playlist.Id);
        if (excludedIds.has(id)) continue;
        const entries = await readPlaylistPages(async (startIndex) => {
          const page = await this.request("GET", `/Playlists/${encodeURIComponent(id)}/Items`, {
            params: { userId: user.Id, startIndex, limit: 200, fields: "Path", enableImages: false },
          });
          return { items: page?.Items, total: page?.TotalRecordCount };
        });
        for (const entry of entries) {
          if (entry.Type && entry.Type !== "Audio") continue;
          paths.add(requirePlaylistPath(entry.Path));
        }
      }
    }
    return [...paths];
  }

  async getAudioItems() {
    const items = [];
    const limit = 1_000;
    for (let startIndex = 0; ; startIndex += limit) {
      const page = await this.request("GET", "/Items", {
        params: {
          userId: this.userId,
          recursive: true,
          includeItemTypes: "Audio",
          fields: "Path,ProviderIds",
          startIndex,
          limit,
          enableTotalRecordCount: true,
        },
      });
      const pageItems = Array.isArray(page?.Items) ? page.Items : [];
      items.push(...pageItems);
      if (pageItems.length < limit || items.length >= Number(page?.TotalRecordCount || 0)) {
        return items;
      }
    }
  }

  async createPlaylist({ name, itemIds }) {
    return this.request("POST", "/Playlists", {
      data: {
        Name: name,
        Ids: itemIds,
        UserId: this.userId,
        MediaType: "Audio",
        IsPublic: true,
      },
    });
  }

  async updatePlaylist(playlistId, { name, itemIds }) {
    const replacement = await this.createPlaylist({ name, itemIds });
    const replacementId = replacement?.Id ?? replacement?.id;
    if (!replacementId) throw new Error("Jellyfin did not return a replacement playlist ID");
    try {
      await this.deletePlaylist(playlistId);
    } catch (error) {
      if (Number(error?.response?.status) !== 404) {
        try {
          await this.deletePlaylist(replacementId);
        } catch {}
        throw error;
      }
    }
    return replacement;
  }

  async deletePlaylist(playlistId) {
    return this.request("DELETE", `/Items/${encodeURIComponent(playlistId)}`, {
      params: { userId: this.userId },
    });
  }

  async scanLibrary() {
    return this.request("POST", "/Library/Refresh");
  }
}
