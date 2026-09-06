import assert from "node:assert/strict";
import test from "node:test";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [isolatedState, history, webhook, scanWorker, honker] = await setupIsolatedBackend(
  "lidarr-webhook",
  "backend/services/aurralHistoryService.js",
  "backend/routes/lidarrWebhook.js",
  "backend/services/libraryScanWorker.js",
  "backend/services/honkerDb.js",
);
const { db } = await import("../../backend/config/database.js");

const { upsertAurralHistory } = history;
const { handleLidarrWebhook } = webhook;
const { clearScheduledLibraryScan, getScheduledLibraryScanJobId } = scanWorker;
const { getLibraryScanQueue } = honker;

const cancelScheduledScan = async () => {
  const jobId = getScheduledLibraryScanJobId();
  if (jobId) getLibraryScanQueue().cancel(jobId);
  await clearScheduledLibraryScan();
};

function createResponse() {
  const result = { statusCode: 200, body: undefined, ended: false };
  return {
    result,
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
    end() {
      result.ended = true;
      return this;
    },
  };
}

test.beforeEach(async () => {
  await cancelScheduledScan();
  await resetDatabase();
  await db.run("DELETE FROM aurral_history");
});

test.afterEach(async () => {
  await cancelScheduledScan();
});

test("Lidarr Download webhook re-indexes only the imported artist", async () => {
  const response = createResponse();
  await handleLidarrWebhook(
    {
      body: {
        eventType: "Download",
        artist: { id: 77, name: "Scoped Artist", mbId: "artist-mbid" },
        album: { id: 42, title: "Blue Train" },
      },
    },
    response,
  );

  const jobId = getScheduledLibraryScanJobId();
  assert.ok(jobId);
  assert.deepEqual(response.result.body, { handled: false, scanJobId: jobId });
  assert.deepEqual(JSON.parse(getLibraryScanQueue().getJob(jobId).payload), {
    force: false,
    includeLidarr: true,
    artistIds: [77],
  });
});

test("Lidarr artist delete webhooks schedule a full re-index", async () => {
  const response = createResponse();
  await handleLidarrWebhook(
    { body: { eventType: "ArtistDelete", artist: { id: 77, name: "Gone Artist" } } },
    response,
  );

  const jobId = getScheduledLibraryScanJobId();
  assert.ok(jobId);
  assert.deepEqual(response.result.body, { handled: true, scanJobId: jobId });
  assert.deepEqual(JSON.parse(getLibraryScanQueue().getJob(jobId).payload), {
    force: false,
    includeLidarr: true,
  });
  getLibraryScanQueue().cancel(jobId);
  await clearScheduledLibraryScan();
});

test("Lidarr album delete webhooks re-index only the album's artist", async () => {
  const response = createResponse();
  await handleLidarrWebhook(
    { body: { eventType: "AlbumDelete", artist: { id: 78 }, album: { id: 5, title: "Gone Album" } } },
    response,
  );

  const jobId = getScheduledLibraryScanJobId();
  assert.ok(jobId);
  assert.deepEqual(response.result.body, { handled: true, scanJobId: jobId });
  assert.deepEqual(JSON.parse(getLibraryScanQueue().getJob(jobId).payload), {
    force: false,
    includeLidarr: true,
    artistIds: [78],
  });
  getLibraryScanQueue().cancel(jobId);
  await clearScheduledLibraryScan();

  // Without an artist id the deletion cannot be scoped.
  await handleLidarrWebhook(
    { body: { eventType: "AlbumDelete", album: { id: 6 } } },
    createResponse(),
  );
  const fullJobId = getScheduledLibraryScanJobId();
  assert.deepEqual(JSON.parse(getLibraryScanQueue().getJob(fullJobId).payload), {
    force: false,
    includeLidarr: true,
  });
  getLibraryScanQueue().cancel(fullJobId);
  await clearScheduledLibraryScan();
});

test("Lidarr Download webhook marks the matching request available", async () => {
  await upsertAurralHistory({
    referenceId: "42",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: {
      albumId: 42,
      albumName: "Blue Train",
      artistName: "John Coltrane",
      artistMbid: "artist-mbid",
      userId: 7,
      username: "alice",
    },
  });

  const response = createResponse();
  await handleLidarrWebhook(
    {
      body: {
        eventType: "Download",
        album: {
          id: 42,
          title: "Blue Train",
          artist: {
            artistName: "John Coltrane",
            foreignArtistId: "artist-mbid",
          },
        },
      },
    },
    response,
  );

  assert.deepEqual(response.result.body, { handled: true });
  const entry = await db.get(
    "SELECT status_label, metadata FROM aurral_history WHERE id = ?",
    ["aurral-album_requested-42"],
  );
  assert.equal(entry.status_label, "Downloaded");
  assert.equal(JSON.parse(entry.metadata).username, "alice");
});

test("Lidarr Download webhook ignores unrelated albums", async () => {
  await upsertAurralHistory({
    referenceId: "42",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: { albumId: 42, albumName: "Blue Train" },
  });

  const response = createResponse();
  await handleLidarrWebhook(
    { body: { eventType: "Download", album: { id: 99, title: "Other Album" } } },
    response,
  );

  assert.deepEqual(response.result.body, { handled: false });
  const entry = await db.get("SELECT status_label FROM aurral_history WHERE id = ?", [
    "aurral-album_requested-42",
  ]);
  assert.equal(entry.status_label, "Searching");
});

test("Lidarr Download webhook matches a request through its album metadata", async () => {
  await upsertAurralHistory({
    referenceId: "artist-mbid",
    kind: "album_requested",
    title: "Requested Blue Train",
    status: "processing",
    statusLabel: "Searching",
    metadata: { albumId: 42, albumName: "Blue Train" },
  });

  const response = createResponse();
  await handleLidarrWebhook(
    { body: { eventType: "Download", album: { id: 42, title: "Blue Train" } } },
    response,
  );

  assert.deepEqual(response.result.body, { handled: true });
  const entry = await db.get(
    "SELECT status_label, metadata FROM aurral_history WHERE id = ?",
    ["aurral-album_requested-artist-mbid"],
  );
  assert.equal(entry.status_label, "Downloaded");
  const metadata = JSON.parse(entry.metadata);
  assert.equal(metadata.albumId, "42");
  assert.equal(metadata.albumName, "Blue Train");
});

test("Lidarr non-download events are acknowledged without changing history", async () => {
  const response = createResponse();
  await handleLidarrWebhook({ body: { eventType: "Test" } }, response);
  assert.equal(response.result.statusCode, 204);
  assert.equal(response.result.ended, true);
});

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});
