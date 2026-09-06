import { db } from "../config/database.js";
import { getPlayEventOutbox } from "./honkerDb.js";
import { scrobbleConnectionStore } from "./scrobbleConnectionStore.js";
import { getKoitoListenBrainzBaseUrl } from "./koitoClient.js";

const GET_EVENT_SQL = "SELECT * FROM play_events WHERE id = ?";
const GET_HISTORY_SQL =
  "SELECT * FROM play_events WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT ? OFFSET ?";
const GET_ARTISTS_SQL = `
  SELECT artist, MAX(artist_mbid) AS artist_mbid, COUNT(*) AS play_count,
         MAX(played_at) AS last_played_at
  FROM play_events
  WHERE user_id = ?
  GROUP BY artist
  ORDER BY play_count DESC, last_played_at DESC
  LIMIT ?
`;
const INSERT_EVENT_SQL = `
  INSERT INTO play_events
    (user_id, track_id, title, artist, album, artist_mbid, album_mbid, track_mbid,
     duration_ms, played_at, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING id
`;

const text = (value, max = 500) => String(value || "").trim().slice(0, max);
const positiveInt = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const toPublicEvent = (row) => row && ({
  id: row.id,
  userId: row.user_id,
  trackId: row.track_id,
  title: row.title,
  artist: row.artist,
  album: row.album,
  artistMbid: row.artist_mbid,
  albumMbid: row.album_mbid,
  trackMbid: row.track_mbid,
  durationMs: row.duration_ms,
  playedAt: row.played_at,
  source: row.source,
});

export const getPlayHistory = async (userId, { limit = 50, offset = 0 } = {}) => {
  const safeLimit = Math.min(100, Math.max(1, positiveInt(limit, 50)));
  const safeOffset = Math.max(0, positiveInt(offset, 0));
  const rows = await db.all(GET_HISTORY_SQL, [userId, safeLimit, safeOffset]);
  return rows.map(toPublicEvent);
};

export const getTopPlayedArtists = async (userId, { limit = 20 } = {}) => {
  const safeLimit = Math.min(100, Math.max(1, positiveInt(limit, 20)));
  const rows = await db.all(GET_ARTISTS_SQL, [userId, safeLimit]);
  return rows.map((row) => ({
    artistName: row.artist,
    mbid: row.artist_mbid || null,
    playcount: Number(row.play_count) || 0,
    lastPlayedAt: Number(row.last_played_at) || null,
  }));
};

// The event row lives in Postgres; delivery jobs live in honker's queue.
export const recordPlayEvent = async (userId, input = {}) => {
  const trackId = text(input.trackId, 500);
  const title = text(input.title, 500);
  const artist = text(input.artist, 500);
  if (!trackId || !title || !artist) throw new Error("trackId, title, and artist are required");
  const playedAtValue = Number(input.playedAt);
  const playedAt = Number.isFinite(playedAtValue)
    ? (playedAtValue < 10_000_000_000 ? Math.trunc(playedAtValue * 1000) : Math.trunc(playedAtValue))
    : Date.now();
  const connections = await scrobbleConnectionStore.getConnections(userId);
  const inserted = await db.get(INSERT_EVENT_SQL, [
    userId,
    trackId,
    title,
    artist,
    text(input.album, 500) || null,
    text(input.artistMbid, 100) || null,
    text(input.albumMbid, 100) || null,
    text(input.trackMbid, 100) || null,
    positiveInt(input.durationMs),
    playedAt,
    text(input.source, 50) || "unknown",
    Date.now(),
  ]);
  const eventId = inserted?.id;
  const outbox = getPlayEventOutbox();
  for (const [provider, connection] of Object.entries(connections)) {
    outbox.enqueue({
      eventId,
      userId,
      provider,
      connectionRevision: connection.connectionRevision,
    });
  }
  return toPublicEvent(await db.get(GET_EVENT_SQL, [eventId]));
};

export const deliverPlayEvent = async ({ eventId, userId, provider, connectionRevision }) => {
  const event = toPublicEvent(await db.get(GET_EVENT_SQL, [eventId]));
  const connection = await scrobbleConnectionStore.getConnection(userId, provider);
  if (!event || !connection || !connectionRevision || connection.connectionRevision !== connectionRevision) return;
  if (provider === "lastfm") {
    const { lastfmScrobble } = await import("./apiClients/lastfm.js");
    await lastfmScrobble(event, connection.token);
    return;
  }
  if (provider === "listenbrainz") {
    const { listenbrainzSubmit } = await import("./apiClients/listenbrainz.js");
    await listenbrainzSubmit({ token: connection.token, event });
    return;
  }
  if (provider === "koito") {
    const { listenbrainzSubmit } = await import("./apiClients/listenbrainz.js");
    await listenbrainzSubmit({
      token: connection.token,
      baseUrl: getKoitoListenBrainzBaseUrl(connection.baseUrl || ""),
      event,
    });
    return;
  }
};
