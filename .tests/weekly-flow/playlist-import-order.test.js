import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  importFromRepo,
  resetDatabase,
} from "../helpers/backendTestHarness.js";

const [
  isolatedState,
  { dbOps, userOps },
  trackerModule,
  playlistConfigModule,
  operationsModule,
  workerModule,
  playlistSourceModule,
  playlistManagerModule,
  spotifyClientModule,
  importSyncModule,
  listenbrainzPlaylistsModule,
  lastfmStationsModule,
] = await setupIsolatedBackend(
  "playlist-import-order",
  "backend/db/helpers/index.js",
  "backend/services/weeklyFlow/weeklyFlowDownloadTracker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistConfig.js",
  "backend/services/weeklyFlow/weeklyFlowOperations.js",
  "backend/services/weeklyFlow/weeklyFlowWorker.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistSource.js",
  "backend/services/weeklyFlow/weeklyFlowPlaylistManager.js",
  "backend/services/spotify/spotifyClient.js",
  "backend/services/importLists/importListSync.js",
  "backend/services/importLists/listenbrainzPlaylists.js",
  "backend/services/importLists/lastfmStations.js",
);

const { downloadTracker } = trackerModule;
const {
  flowPlaylistConfig,
  orderJobsBySharedPlaylistTracks,
  rebuildSharedPlaylistTracksFromJobs,
} = playlistConfigModule;
const { appendSharedPlaylistTracks, processWeeklyFlowOperation, updateSharedPlaylist } = operationsModule;
const { weeklyFlowWorker } = workerModule;
const { playlistSource } = playlistSourceModule;
const { playlistManager } = playlistManagerModule;
const { spotifyClient } = spotifyClientModule;
const { listenbrainzPlaylistClient } = listenbrainzPlaylistsModule;
const { lastfmStationClient } = lastfmStationsModule;
const { syncSharedPlaylistImport } = importSyncModule;

const weeklyFlowRoot = process.env.WEEKLY_FLOW_FOLDER;

async function writeReusableTrack(track, playlistType = "source-playlist") {
  const sourcePath = path.join(
    weeklyFlowRoot,
    "aurral-weekly-flow",
    playlistType,
    track.artistName,
    track.albumName || "Unknown Album",
    `${track.trackName}.flac`,
  );
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "audio");
  const jobId = downloadTracker.addJob(track, playlistType);
  downloadTracker.setDone(jobId, sourcePath, track.albumName);
  return { jobId, sourcePath };
}

await downloadTracker.init();

test.beforeEach(async () => {
  await resetDatabase();
  await dbOps.updateSettings({
    integrations: {},
    onboardingComplete: true,
    flows: [],
    sharedPlaylists: [],
    playlistWorker: { existingFileMode: "reuse", concurrency: 1 },
    playlistArtwork: { style: "aurral" },
  });
  downloadTracker.clearAll();
  weeklyFlowWorker.stop();
  await fs.rm(weeklyFlowRoot, { recursive: true, force: true });
});

test.after(async () => {
  weeklyFlowWorker.stop();
  await cleanupIsolatedState(isolatedState);
});

test("orderJobsBySharedPlaylistTracks follows config order over createdAt", () => {
  const tracks = [
    { artistName: "A", trackName: "One", albumName: "Album" },
    { artistName: "B", trackName: "Two", albumName: "Album" },
    { artistName: "C", trackName: "Three", albumName: "Album" },
  ];
  const jobs = [
    { id: 2, createdAt: 20, ...tracks[1] },
    { id: 3, createdAt: 30, ...tracks[2] },
    { id: 1, createdAt: 10, ...tracks[0] },
  ];
  const ordered = orderJobsBySharedPlaylistTracks(jobs, tracks);
  assert.deepEqual(
    ordered.map((job) => job.id),
    [1, 2, 3],
  );
});

test("rebuildSharedPlaylistTracksFromJobs keeps remaining config order", () => {
  const tracks = [
    { artistName: "A", trackName: "One", albumName: "Album" },
    { artistName: "B", trackName: "Two", albumName: "Album" },
    { artistName: "C", trackName: "Three", albumName: "Album" },
    { artistName: "D", trackName: "Four", albumName: "Album" },
  ];
  const jobs = [
    { id: 10, createdAt: 40, ...tracks[3] },
    { id: 11, createdAt: 10, ...tracks[0] },
    { id: 12, createdAt: 30, ...tracks[2] },
  ];
  const remaining = rebuildSharedPlaylistTracksFromJobs(tracks, jobs);
  assert.deepEqual(
    remaining.map((track) => track.trackName),
    ["One", "Three", "Four"],
  );
});

test("mixed reuse seeding keeps import job order", async () => {
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => false;
  try {
    const reusableA = {
      artistName: "Artist A",
      trackName: "Owned",
      albumName: "Album",
    };
    const missingB = {
      artistName: "Artist B",
      trackName: "Missing",
      albumName: "Album",
    };
    const reusableC = {
      artistName: "Artist C",
      trackName: "Also Owned",
      albumName: "Album",
    };
    const missingD = {
      artistName: "Artist D",
      trackName: "Also Missing",
      albumName: "Album",
    };
    await writeReusableTrack(reusableA);
    await writeReusableTrack(reusableC);

    const playlist = await flowPlaylistConfig.createSharedPlaylist({
      name: "Import Order",
      tracks: [],
    });
    const imported = [reusableA, missingB, reusableC, missingD];
    const result = await appendSharedPlaylistTracks({
      playlistId: playlist.id,
      tracks: imported,
    });

    assert.equal(result.tracksReused, 2);
    assert.equal(result.tracksQueued, 2);

    const jobs = orderJobsBySharedPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks,
    );
    assert.deepEqual(
      jobs.map((job) => `${job.artistName}:${job.trackName}:${job.status}`),
      [
        "Artist A:Owned:done",
        "Artist B:Missing:pending",
        "Artist C:Also Owned:done",
        "Artist D:Also Missing:pending",
      ],
    );
    assert.deepEqual(
      jobs.map((job) => job.createdAt),
      [...jobs].map((job) => job.createdAt).sort((left, right) => left - right),
    );
  } finally {
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("flow refresh clears playback before downloads finish", async () => {
  const originalBuildPlan = playlistSource.buildFlowRunPlan;
  const originalRefresh = playlistManager.refreshPlaylist;
  const originalScheduleNextRun = flowPlaylistConfig.scheduleNextRun;
  const events = [];
  try {
    await dbOps.updateSettings({
      ...dbOps.getSettings(),
      integrations: {
        lastfm: { apiKey: "test" },
        slskd: { enabled: true, url: "http://slskd", apiKey: "test" },
      },
    });
    const flow = await flowPlaylistConfig.createFlow({
      name: "Refresh Before Download",
      mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
      size: 1,
      scheduleDays: [1],
    });
    await flowPlaylistConfig.setEnabled(flow.id, true);
    playlistSource.buildFlowRunPlan = async () => ({
      primaryTracks: [],
      reserveTracks: [],
      diagnostics: { targets: { primary: 0 }, achieved: { primary: 0, reserve: 0 } },
    });
    playlistManager.refreshPlaylist = async (playlistId) => {
      await new Promise((resolve) => setImmediate(resolve));
      events.push(["refresh", playlistId]);
    };
    flowPlaylistConfig.scheduleNextRun = (playlistId) => {
      events.push(["schedule", playlistId]);
    };

    await processWeeklyFlowOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });

    assert.deepEqual(events, [
      ["refresh", flow.id],
      ["schedule", flow.id],
    ]);
  } finally {
    playlistSource.buildFlowRunPlan = originalBuildPlan;
    playlistManager.refreshPlaylist = originalRefresh;
    flowPlaylistConfig.scheduleNextRun = originalScheduleNextRun;
    weeklyFlowWorker.stop();
  }
});

test("deleting a track keeps remaining import order in config", async () => {
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => false;
  try {
    const tracks = [
      { artistName: "A", trackName: "One", albumName: "Album" },
      { artistName: "B", trackName: "Two", albumName: "Album" },
      { artistName: "C", trackName: "Three", albumName: "Album" },
      { artistName: "D", trackName: "Four", albumName: "Album" },
    ];
    await writeReusableTrack(tracks[0]);
    await writeReusableTrack(tracks[2]);

    const playlist = await flowPlaylistConfig.createSharedPlaylist({
      name: "Delete Order",
      tracks: [],
    });
    await appendSharedPlaylistTracks({
      playlistId: playlist.id,
      tracks,
    });

    const jobsBefore = orderJobsBySharedPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks,
    );
    const removedJobId = jobsBefore[1].id;

    const deleted = await processWeeklyFlowOperation({
      kind: "shared-playlist-delete-track",
      playlistId: playlist.id,
      jobId: removedJobId,
    });
    assert.equal(deleted.success, true);

    const updated = flowPlaylistConfig.getSharedPlaylist(playlist.id);
    assert.deepEqual(
      updated.tracks.map((track) => track.trackName),
      ["One", "Three", "Four"],
    );

    const jobsAfter = orderJobsBySharedPlaylistTracks(
      downloadTracker.getByPlaylistType(playlist.id),
      updated.tracks,
    );
    assert.deepEqual(
      jobsAfter.map((job) => job.trackName),
      ["One", "Three", "Four"],
    );
  } finally {
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("replacing a shared playlist removes Spotify tracks and honors file retention", async () => {
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => false;
  try {
    const track = {
      artistName: "A",
      trackName: "Removed",
      albumName: "Album",
    };
    const keepPlaylist = await flowPlaylistConfig.createSharedPlaylist({
      name: "Keep Removed",
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "keep-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    await fs.mkdir(weeklyFlowRoot, { recursive: true });
    const keepPath = path.join(weeklyFlowRoot, "keep-removed.flac");
    await fs.writeFile(keepPath, "audio");
    const keepJobId = downloadTracker.addJob(track, keepPlaylist.id);
    downloadTracker.setDone(keepJobId, keepPath, track.albumName);

    await updateSharedPlaylist({
      playlistId: keepPlaylist.id,
      tracks: [],
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: keepPlaylist.importSource,
    });
    assert.deepEqual(flowPlaylistConfig.getSharedPlaylist(keepPlaylist.id).tracks, []);
    await fs.access(keepPath);

    const deletePlaylist = await flowPlaylistConfig.createSharedPlaylist({
      name: "Delete Removed",
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "delete-id",
        syncEnabled: true,
        syncIntervalHours: 24,
        keepRemovedTracks: false,
      },
    });
    const deletePath = path.join(weeklyFlowRoot, "delete-removed.flac");
    await fs.writeFile(deletePath, "audio");
    const deleteJobId = downloadTracker.addJob(track, deletePlaylist.id);
    downloadTracker.setDone(deleteJobId, deletePath, track.albumName);

    await updateSharedPlaylist({
      playlistId: deletePlaylist.id,
      tracks: [],
      hasTracksUpdate: true,
      hasImportSourceUpdate: true,
      importSource: deletePlaylist.importSource,
      deleteUnsharedFiles: true,
    });
    assert.deepEqual(flowPlaylistConfig.getSharedPlaylist(deletePlaylist.id).tracks, []);
    await assert.rejects(fs.access(deletePath));
  } finally {
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("imported playlist sync preserves enriched jobs while replacing removed tracks", async () => {
  const originalStart = weeklyFlowWorker.start;
  weeklyFlowWorker.start = async () => false;
  try {
    const pending = {
      artistName: "Artist", trackName: "Pending", albumName: "Album",
      artistMbid: "11111111-1111-1111-1111-111111111111",
    };
    const completed = {
      artistName: "Artist", trackName: "Completed", albumName: "Album",
      albumMbid: "22222222-2222-2222-2222-222222222222",
    };
    const removed = { artistName: "Artist", trackName: "Removed", albumName: "Album" };
    const playlist = await flowPlaylistConfig.createSharedPlaylist({
      name: "Imported Job Retention",
      ownerUserId: 7,
      tracks: [pending, completed, removed],
      importSource: {
        provider: "spotify-playlist",
        externalId: "imported-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    const pendingJobId = downloadTracker.addJob(pending, playlist.id);
    const completedJobId = downloadTracker.addJob(completed, playlist.id);
    await fs.mkdir(weeklyFlowRoot, { recursive: true });
    const completedPath = path.join(weeklyFlowRoot, "imported-retained-completed.flac");
    await fs.writeFile(completedPath, "audio");
    downloadTracker.setDone(completedJobId, completedPath, completed.albumName);
    const removedJobId = downloadTracker.addJob(removed, playlist.id);

    const result = await updateSharedPlaylist({
      playlistId: playlist.id,
      tracks: [
        { artistName: "Artist", trackName: "Pending", albumName: "Album" },
        { artistName: "Artist", trackName: "Completed", albumName: "Album" },
        { artistName: "Artist", trackName: "New", albumName: "Album" },
      ],
      hasTracksUpdate: true,
      mergeImportSource: true,
    });

    assert.equal(result.tracksQueued, 1);
    assert.ok(downloadTracker.getJob(pendingJobId));
    assert.equal(downloadTracker.getJob(completedJobId)?.status, "done");
    await fs.access(completedPath);
    assert.equal(downloadTracker.getJob(removedJobId), null);
    assert.ok(downloadTracker.getByPlaylistType(playlist.id).some((job) => job.trackName === "New"));
  } finally {
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("ListenBrainz sync uses the shared import update path", async () => {
  const originalStart = weeklyFlowWorker.start;
  const originalGetGeneratedPlaylistTracks =
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks;
  weeklyFlowWorker.start = async () => false;
  try {
    const playlist = await flowPlaylistConfig.createSharedPlaylist({
      name: "ListenBrainz Mix",
      ownerUserId: 7,
      tracks: [{ artistName: "Old Artist", trackName: "Old Song" }],
      importSource: {
        provider: "listenbrainz-createdfor",
        externalId: "weekly-jams",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = async () => ({
      tracks: [{ artistName: "New Artist", trackName: "New Song" }],
      stats: { incomplete: 0, duplicate: 0 },
    });

    await syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.deepEqual(flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks, [
      {
        artistName: "New Artist",
        trackName: "New Song",
        albumName: null,
        artistMbid: null,
        albumMbid: null,
        trackMbid: null,
        releaseYear: null,
        durationMs: null,
        artistAliases: [],
        reason: null,
      },
    ]);
  } finally {
    listenbrainzPlaylistClient.getGeneratedPlaylistTracks = originalGetGeneratedPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("Last.fm station sync refreshes the saved station and username", async () => {
  const originalStart = weeklyFlowWorker.start;
  const originalGetStationTracks = lastfmStationClient.getStationTracks;
  weeklyFlowWorker.start = async () => false;
  try {
    const playlist = await flowPlaylistConfig.createSharedPlaylist({
      name: "Last.fm Mix",
      ownerUserId: 7,
      tracks: [{ artistName: "Old Artist", trackName: "Old Song" }],
      importSource: {
        provider: "lastfm-station",
        externalId: "mix",
        externalUsername: "station-user",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    let requested;
    lastfmStationClient.getStationTracks = async (userId, station, username) => {
      requested = { userId, station, username };
      return {
        tracks: [{ artistName: "New Artist", trackName: "New Song" }],
        stats: { incomplete: 0, duplicate: 0 },
      };
    };

    await syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });

    assert.deepEqual(requested, {
      userId: 7,
      station: "mix",
      username: "station-user",
    });
    assert.deepEqual(
      flowPlaylistConfig.getSharedPlaylist(playlist.id).tracks.map(({ artistName, trackName }) => ({
        artistName,
        trackName,
      })),
      [{ artistName: "New Artist", trackName: "New Song" }],
    );
    assert.equal(
      flowPlaylistConfig.getSharedPlaylist(playlist.id).importSource.externalUsername,
      "station-user",
    );
  } finally {
    lastfmStationClient.getStationTracks = originalGetStationTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("Spotify sync keeps a retention change made while Spotify is pending", async () => {
  const originalStart = weeklyFlowWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  weeklyFlowWorker.start = async () => false;
  try {
    const track = {
      artistName: "A",
      trackName: "Removed",
      albumName: "Album",
    };
    const playlist = await flowPlaylistConfig.createSharedPlaylist({
      name: "Pending Retention",
      ownerUserId: 7,
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "pending-id",
        syncEnabled: true,
        syncIntervalHours: 24,
      },
    });
    await fs.mkdir(weeklyFlowRoot, { recursive: true });
    const finalPath = path.join(weeklyFlowRoot, "pending-retention.flac");
    await fs.writeFile(finalPath, "audio");
    const jobId = downloadTracker.addJob(track, playlist.id);
    downloadTracker.setDone(jobId, finalPath, track.albumName);

    let resolveSpotifyTracks;
    spotifyClient.listPlaylistTracks = () =>
      new Promise((resolve) => {
        resolveSpotifyTracks = resolve;
      });
    const syncPromise = syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    await flowPlaylistConfig.updateSharedPlaylist(playlist.id, {
      importSource: {
        ...playlist.importSource,
        keepRemovedTracks: false,
      },
    });
    resolveSpotifyTracks([]);
    await syncPromise;

    const updated = flowPlaylistConfig.getSharedPlaylist(playlist.id);
    assert.equal(updated.importSource.keepRemovedTracks, false);
    assert.equal(updated.tracks.length, 0);
    await assert.rejects(fs.access(finalPath));
  } finally {
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

test("Spotify cleanup serializes retention updates with file removal", async () => {
  const originalStart = weeklyFlowWorker.start;
  const originalListPlaylistTracks = spotifyClient.listPlaylistTracks;
  const originalRm = fs.rm;
  let resolveRemovalStarted;
  let releaseRemoval;
  const removalStarted = new Promise((resolve) => {
    resolveRemovalStarted = resolve;
  });
  const removalBlocked = new Promise((resolve) => {
    releaseRemoval = resolve;
  });
  weeklyFlowWorker.start = async () => false;
  try {
    const track = {
      artistName: "A",
      trackName: "Cleanup",
      albumName: "Album",
    };
    const playlist = await flowPlaylistConfig.createSharedPlaylist({
      name: "Serialized Retention",
      ownerUserId: 7,
      tracks: [track],
      importSource: {
        provider: "spotify-playlist",
        externalId: "serialized-id",
        syncEnabled: true,
        syncIntervalHours: 24,
        keepRemovedTracks: false,
      },
    });
    await fs.mkdir(weeklyFlowRoot, { recursive: true });
    const finalPath = path.join(weeklyFlowRoot, "serialized-retention.flac");
    await fs.writeFile(finalPath, "audio");
    const jobId = downloadTracker.addJob(track, playlist.id);
    downloadTracker.setDone(jobId, finalPath, track.albumName);

    spotifyClient.listPlaylistTracks = async () => [];
    fs.rm = async (...args) => {
      resolveRemovalStarted();
      await removalBlocked;
      return originalRm(...args);
    };
    const syncPromise = syncSharedPlaylistImport({
      playlistId: playlist.id,
      user: { id: 7 },
      force: true,
    });
    await removalStarted;

    let retentionUpdated = false;
    const retentionPromise = updateSharedPlaylist({
      playlistId: playlist.id,
      hasImportSourceUpdate: true,
      importSource: {
        ...playlist.importSource,
        keepRemovedTracks: true,
      },
    }).then(() => {
      retentionUpdated = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retentionUpdated, false);

    releaseRemoval();
    await syncPromise;
    await retentionPromise;
    assert.equal(
      flowPlaylistConfig.getSharedPlaylist(playlist.id).importSource.keepRemovedTracks,
      true,
    );
    await assert.rejects(fs.access(finalPath));
  } finally {
    fs.rm = originalRm;
    spotifyClient.listPlaylistTracks = originalListPlaylistTracks;
    weeklyFlowWorker.start = originalStart;
    weeklyFlowWorker.stop();
  }
});

async function enableSlskdForFlows() {
  await dbOps.updateSettings({
    ...dbOps.getSettings(),
    integrations: {
      lastfm: { apiKey: "test" },
      slskd: { enabled: true, url: "http://slskd", apiKey: "test" },
    },
  });
}

async function createOwnedFlow(ownerName, flowName) {
  const owner = await userOps.createUser(ownerName, "unused", "user");
  const flow = await flowPlaylistConfig.createFlow({
    name: flowName,
    mix: { discover: 100, mix: 0, trending: 0, focus: 0 },
    size: 1,
    scheduleDays: [1],
    ownerUserId: owner.id,
  });
  return { owner, flow };
}

test("a scheduled flow run is skipped for an owner who is already suspended", async () => {
  const originalReset = playlistManager.weeklyReset;
  let resets = 0;
  try {
    await enableSlskdForFlows();
    const { owner, flow } = await createOwnedFlow("suspended-flow-owner", "Suspended Owner Flow");
    await flowPlaylistConfig.setEnabled(flow.id, true);
    await userOps.updateUser(owner.id, { status: "suspended" });
    playlistManager.weeklyReset = async () => {
      resets += 1;
    };

    const result = await processWeeklyFlowOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });

    assert.deepEqual(result, { skipped: true, inactiveOwner: true });
    assert.equal(resets, 0);
  } finally {
    playlistManager.weeklyReset = originalReset;
    weeklyFlowWorker.stop();
  }
});

test("a queued flow stops before mutation when its owner becomes suspended", async () => {
  const originalReset = playlistManager.weeklyReset;
  const originalWaitForIdle = weeklyFlowWorker.waitForPlaylistIdle;
  let resets = 0;
  try {
    await enableSlskdForFlows();
    const { owner, flow } = await createOwnedFlow("queued-flow-owner", "Queued Before Suspension");
    await flowPlaylistConfig.setEnabled(flow.id, true);
    // The owner is suspended while the run waits for the playlist to go idle.
    weeklyFlowWorker.waitForPlaylistIdle = async () => {
      await userOps.updateUser(owner.id, { status: "suspended" });
    };
    playlistManager.weeklyReset = async () => {
      resets += 1;
    };

    const result = await processWeeklyFlowOperation({
      kind: "scheduled-flow-refresh",
      flowId: flow.id,
    });

    assert.deepEqual(result, { skipped: true, inactiveOwner: true });
    assert.equal(resets, 0);
  } finally {
    playlistManager.weeklyReset = originalReset;
    weeklyFlowWorker.waitForPlaylistIdle = originalWaitForIdle;
    weeklyFlowWorker.stop();
  }
});

test("a queued discovery adoption cannot seed downloads for a suspended owner", async () => {
  const originalSeed = weeklyFlowWorker.seedFlowRunWithTracks;
  let seedCalls = 0;
  try {
    const { owner, flow } = await createOwnedFlow(
      "suspended-adoption-owner",
      "Adopted Before Suspension",
    );
    weeklyFlowWorker.seedFlowRunWithTracks = async () => {
      seedCalls += 1;
      return { tracksQueued: 1 };
    };
    await userOps.updateUser(owner.id, { status: "suspended" });

    const result = await processWeeklyFlowOperation({
      kind: "adopt-flow-seed",
      flowId: flow.id,
      tracks: [{ artistName: "Artist", trackName: "Track" }],
    });

    assert.deepEqual(result, { skipped: true, inactiveOwner: true });
    assert.equal(seedCalls, 0);
  } finally {
    weeklyFlowWorker.seedFlowRunWithTracks = originalSeed;
    weeklyFlowWorker.stop();
  }
});

test("download pipeline work is deferred while its playlist owner is suspended", async () => {
  const { owner, flow } = await createOwnedFlow("suspended-pipeline-owner", "Suspended Pipeline");
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, flow.id);
  await userOps.updateUser(owner.id, { status: "suspended" });
  const { processPipelinePayload } = await importFromRepo(
    "backend/services/slskdOrchestrator.js",
  );
  const { isPlaylistOwnerActive } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowOwnerStatus.js",
  );

  const payload = { phase: "search", source: "slskd", jobId };
  assert.deepEqual(await processPipelinePayload(payload), {
    ...payload,
    delaySeconds: 30,
  });
  assert.equal(await isPlaylistOwnerActive(flow.id), false);

  await userOps.updateUser(owner.id, { status: "active" });
  assert.equal(await isPlaylistOwnerActive(flow.id), true);
});

test("the download worker's owner mirror skips an inactive owner's jobs only after a refresh", async () => {
  const { refreshOwnerStatus, isPlaylistOwnerActiveSync } = await importFromRepo(
    "backend/services/weeklyFlow/weeklyFlowOwnerStatus.js",
  );
  const { owner, flow } = await createOwnedFlow("mirrored-owner", "Mirrored Owner Flow");
  const jobId = downloadTracker.addJob({ artistName: "Artist", trackName: "Track" }, flow.id);
  await refreshOwnerStatus();
  assert.equal(weeklyFlowWorker._getNextReadyPendingJob()?.id, jobId);

  await userOps.updateUser(owner.id, { status: "disabled" });
  assert.equal(isPlaylistOwnerActiveSync(flow.id), true, "the mirror only changes on refresh");
  await refreshOwnerStatus();
  assert.equal(isPlaylistOwnerActiveSync(flow.id), false);
  assert.equal(weeklyFlowWorker._getNextReadyPendingJob(), null);
  assert.throws(
    () =>
      weeklyFlowWorker._assertJobCanContinue(
        downloadTracker.getJob(jobId),
        weeklyFlowWorker.runGeneration,
      ),
    { message: "Playlist owner is inactive" },
  );

  await userOps.updateUser(owner.id, { status: "active" });
  await refreshOwnerStatus();
  assert.equal(weeklyFlowWorker._getNextReadyPendingJob()?.id, jobId);

  await userOps.updateUser(owner.id, { status: "suspended" });
  await refreshOwnerStatus();
  await userOps.deleteUser(owner.id);
  await refreshOwnerStatus();
  assert.equal(
    isPlaylistOwnerActiveSync(flow.id),
    true,
    "a deleted owner is not an inactive account",
  );
});
