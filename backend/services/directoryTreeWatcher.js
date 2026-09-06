import fs from "node:fs";
import path from "node:path";

// Linux recursive fs.watch: synchronous walk, one inotify watch per file.
// 80k files blocked the event loop for minutes; this is one watch per directory.

const DEFAULT_MAX_DIRECTORIES = 100000;
const DIRECTORIES_PER_YIELD = 25;

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

export class DirectoryTreeWatcher {
  #root;
  #listener;
  #onError;
  #skipDirectory;
  #maxDirectories;
  #watchers = new Map();
  #closed = false;
  #exhausted = false;
  #walking = Promise.resolve();

  constructor(root, listener, { onError = () => {}, skipDirectory = () => false, maxDirectories = DEFAULT_MAX_DIRECTORIES } = {}) {
    this.#root = path.resolve(String(root));
    this.#listener = listener;
    this.#onError = onError;
    this.#skipDirectory = skipDirectory;
    this.#maxDirectories = Math.max(1, Number(maxDirectories) || DEFAULT_MAX_DIRECTORIES);
    // Missing root throws here, like fs.watch.
    this.#watchDirectory(this.#root);
    this.#walking = this.#walk(this.#root);
  }

  get directoryCount() {
    return this.#watchers.size;
  }

  // Settles when the current tree walk finishes.
  get ready() {
    return this.#walking;
  }

  close() {
    this.#closed = true;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }

  #watchDirectory(directory) {
    if (this.#closed || this.#exhausted || this.#watchers.has(directory)) return false;
    if (this.#watchers.size >= this.#maxDirectories) {
      this.#exhaust(new Error(`Directory watch limit of ${this.#maxDirectories} reached under ${this.#root}`));
      return false;
    }
    let watcher;
    try {
      watcher = fs.watch(directory, { persistent: true }, (eventType, filename) => {
        this.#onEvent(directory, eventType, filename);
      });
    } catch (error) {
      if (directory === this.#root) throw error;
      // ENOSPC: inotify limit reached.
      if (error?.code === "ENOSPC") this.#exhaust(error);
      return false;
    }
    watcher.on("error", () => this.#unwatchTree(directory));
    this.#watchers.set(directory, watcher);
    return true;
  }

  #exhaust(error) {
    if (this.#exhausted) return;
    this.#exhausted = true;
    this.#onError(error, this.#root);
  }

  #unwatchTree(directory) {
    const prefix = directory + path.sep;
    for (const [watched, watcher] of this.#watchers) {
      if (watched === directory || watched.startsWith(prefix)) {
        watcher.close();
        this.#watchers.delete(watched);
      }
    }
  }

  // Async reads plus periodic yields: never starves the event loop.
  async #walk(start) {
    const queue = [start];
    let sinceYield = 0;
    while (queue.length && !this.#closed && !this.#exhausted) {
      const directory = queue.shift();
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(directory, entry.name);
        if (this.#skipDirectory(child, path.relative(this.#root, child))) continue;
        if (this.#watchDirectory(child)) queue.push(child);
      }
      if ((sinceYield += 1) >= DIRECTORIES_PER_YIELD) {
        sinceYield = 0;
        await yieldLoop();
      }
    }
  }

  #onEvent(directory, eventType, filename) {
    if (this.#closed) return;
    const changed = filename ? path.join(directory, String(filename)) : directory;
    this.#listener(eventType, path.relative(this.#root, changed) || ".");
    if (eventType !== "rename" || !filename) return;
    // rename = create, delete, or move of a direct child.
    fs.promises.stat(changed).then(
      (stats) => {
        if (!stats.isDirectory() || this.#watchers.has(changed)) return;
        if (this.#skipDirectory(changed, path.relative(this.#root, changed))) return;
        if (this.#watchDirectory(changed)) this.#walking = this.#walk(changed);
      },
      () => this.#unwatchTree(changed),
    );
  }
}

// Other platforms have native recursive watchers (FSEvents, ReadDirectoryChangesW).
export function watchDirectoryTree(root, options = {}, listener) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  const { onError, skipDirectory, maxDirectories, forcePerDirectory, ...watchOptions } = options;
  if (process.platform !== "linux" && !forcePerDirectory) {
    return fs.watch(root, { ...watchOptions, recursive: true }, listener);
  }
  return new DirectoryTreeWatcher(root, listener, { onError, skipDirectory, maxDirectories });
}
