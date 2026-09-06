import test from "node:test";
import assert from "node:assert/strict";
import { applyLidarrCommunityGuide } from "../../backend/services/lidarrCommunityGuide.js";

function createFakeClient({ existingFormats = [], createFormat }) {
  const calls = { qualityProfiles: [] };
  let nextId = 100;
  return {
    calls,
    getQualityDefinitions: async () => [
      { id: 1, title: "MP3-320", quality: { id: 1, name: "MP3-320" } },
      { id: 2, title: "FLAC", quality: { id: 2, name: "FLAC" } },
    ],
    updateQualityDefinition: async (_id, payload) => payload,
    getCustomFormats: async () => existingFormats,
    createCustomFormat: async (format) => {
      if (createFormat) return createFormat(format);
      return { id: nextId++, name: format.name };
    },
    getReleaseProfiles: async () => [],
    createReleaseProfile: async (payload) => ({ id: 1, ...payload }),
    updateReleaseProfile: async (_id, payload) => ({ id: _id, ...payload }),
    getMetadataProfiles: async () => [{ id: 1, name: "Standard", primaryAlbumTypes: [], secondaryAlbumTypes: [] }],
    createMetadataProfile: async (payload) => ({ id: 2, ...payload }),
    updateMetadataProfile: async (_id, payload) => ({ id: _id, ...payload }),
    getNamingConfig: async () => ({ id: 1 }),
    updateNamingConfig: async (payload) => payload,
    getQualityProfiles: async () => [{ id: 1, name: "Any", items: [], cutoff: 1 }],
    createQualityProfile: async (payload) => {
      calls.qualityProfiles.push(payload);
      return { id: 5, ...payload };
    },
    updateQualityProfile: async (_id, payload) => {
      calls.qualityProfiles.push(payload);
      return { id: _id, ...payload };
    },
  };
}

test("community guide requires a positive format score when positive formats exist", async () => {
  const client = createFakeClient({});
  const results = await applyLidarrCommunityGuide(client);
  const profile = client.calls.qualityProfiles.at(-1);
  assert.equal(profile.minFormatScore, 1);
  assert.equal(profile.formatItems.length, 5);
  assert.equal(results.errors.length, 0);
});

test("community guide never asks for an unsatisfiable minimum format score", async () => {
  // Only the negative-scoring format exists and the others fail to be created.
  const client = createFakeClient({
    existingFormats: [{ id: 9, name: "Vinyl" }],
    createFormat: async () => {
      throw new Error("boom");
    },
  });
  const results = await applyLidarrCommunityGuide(client);
  const profile = client.calls.qualityProfiles.at(-1);
  assert.equal(profile.minFormatScore, 0);
  assert.deepEqual(
    profile.formatItems.map((item) => item.score),
    [-5],
  );
  assert.ok(results.errors.some((message) => message.includes("No positive-scoring custom formats")));
  assert.equal(results.errors.filter((message) => message.startsWith("Failed to create custom format")).length, 4);
});
