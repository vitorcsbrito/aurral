import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DirectoryTreeWatcher, watchDirectoryTree } from "../../backend/services/directoryTreeWatcher.js";

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await settle(25);
  }
  return true;
};

test("DirectoryTreeWatcher watches every directory and reports root-relative paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-tree-watch-"));
  await mkdir(path.join(root, "Artist", "Album"), { recursive: true });
  await mkdir(path.join(root, "aurral-weekly-flow", "flow"), { recursive: true });
  const events = [];
  const watcher = new DirectoryTreeWatcher(root, (eventType, filename) => events.push([eventType, filename]), {
    skipDirectory: (_directory, relative) => relative.startsWith("aurral-weekly-flow"),
  });
  try {
    await watcher.ready;
    assert.equal(watcher.directoryCount, 3, "root, Artist, Album; the excluded folder is skipped");

    await writeFile(path.join(root, "Artist", "Album", "01 track.flac"), "x");
    assert.equal(await waitFor(() => events.some(([, name]) => name === path.join("Artist", "Album", "01 track.flac"))), true);

    // A directory created later is picked up and its files reported.
    await mkdir(path.join(root, "Artist", "Second Album"));
    assert.equal(await waitFor(() => watcher.directoryCount === 4), true);
    await watcher.ready;
    await writeFile(path.join(root, "Artist", "Second Album", "02 track.flac"), "x");
    assert.equal(
      await waitFor(() => events.some(([, name]) => name === path.join("Artist", "Second Album", "02 track.flac"))),
      true,
    );

    // A removed directory drops its watch.
    await rm(path.join(root, "Artist", "Second Album"), { recursive: true, force: true });
    assert.equal(await waitFor(() => watcher.directoryCount === 3), true);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DirectoryTreeWatcher stops at the directory limit and reports it once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-tree-limit-"));
  for (const name of ["a", "b", "c", "d"]) await mkdir(path.join(root, name));
  const errors = [];
  const watcher = new DirectoryTreeWatcher(root, () => {}, {
    maxDirectories: 2,
    onError: (error) => errors.push(error.message),
  });
  try {
    await watcher.ready;
    assert.equal(watcher.directoryCount, 2);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /watch limit of 2/);
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("watchDirectoryTree throws for a missing root like fs.watch", async () => {
  assert.throws(
    () => watchDirectoryTree(path.join(tmpdir(), "aurral-missing-root-xyz"), { forcePerDirectory: true }, () => {}),
    /ENOENT/,
  );
});
