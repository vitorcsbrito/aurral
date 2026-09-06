import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

// Checker thread writes stderr directly: worker console is proxied via main.
// SIGUSR2 makes Node dump the main thread's JS stack (report-on-signal).
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_STALL_MS = 10000;
const REPORT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const REPORT_SIGNAL = "SIGUSR2";

const nowSeconds = () => Math.floor(Date.now() / 1000);

function runChecker() {
  const { buffer, heartbeatMs, stallMs, signal } = workerData;
  const beat = new Int32Array(buffer);
  let stalledSince = 0;
  let lastReportAt = 0;
  setInterval(() => {
    const ageMs = Date.now() - Atomics.load(beat, 0) * 1000;
    if (ageMs < stallMs) {
      stalledSince = 0;
      return;
    }
    if (!stalledSince) {
      stalledSince = Date.now() - ageMs;
      fs.writeSync(2, `${new Date().toISOString()} [warn] [system] Event loop stalled for ${Math.round(ageMs / 1000)}s\n`);
      if (signal && Date.now() - lastReportAt >= REPORT_MIN_INTERVAL_MS) {
        lastReportAt = Date.now();
        try {
          process.kill(process.pid, signal);
          fs.writeSync(2, `${new Date().toISOString()} [warn] [system] Diagnostic report requested (${signal})\n`);
        } catch {}
      }
      parentPort.postMessage({ type: "stall", stalledAt: stalledSince });
    }
  }, heartbeatMs);
  // The interval keeps this thread alive; the main thread unrefs the Worker.
}

if (!isMainThread && workerData?.eventLoopWatchdog === true) runChecker();

let watchdog = null;

export function startEventLoopWatchdog({
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  stallMs = DEFAULT_STALL_MS,
  reportDirectory = null,
  logger = console,
} = {}) {
  if (watchdog) return watchdog;
  const events = new EventEmitter();
  let signal = null;
  if (reportDirectory && process.report) {
    try {
      fs.mkdirSync(reportDirectory, { recursive: true });
      process.report.directory = reportDirectory;
      process.report.signal = REPORT_SIGNAL;
      process.report.reportOnSignal = true;
      signal = REPORT_SIGNAL;
    } catch (error) {
      logger.warn?.("system", "Diagnostic reports disabled", { error: error?.message || String(error) });
    }
  }
  const buffer = new SharedArrayBuffer(4);
  const beat = new Int32Array(buffer);
  Atomics.store(beat, 0, nowSeconds());
  let lastBeatMs = Date.now();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    // Gap measured after resume; only the main thread knows its length.
    if (now - lastBeatMs >= stallMs) {
      logger.warn?.("system", "Event loop was blocked", { seconds: Math.round((now - lastBeatMs) / 1000) });
      events.emit("resume", { blockedMs: now - lastBeatMs });
    }
    lastBeatMs = now;
    Atomics.store(beat, 0, nowSeconds());
  }, heartbeatMs);
  heartbeat.unref();
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { eventLoopWatchdog: true, buffer, heartbeatMs, stallMs, signal },
  });
  worker.unref();
  worker.on("message", (message) => {
    if (message?.type === "stall") events.emit("stall", message);
  });
  worker.on("error", (error) => {
    logger.warn?.("system", "Event loop watchdog stopped", { error: error?.message || String(error) });
  });
  watchdog = {
    events,
    reportDirectory: signal ? reportDirectory : null,
    stop() {
      clearInterval(heartbeat);
      worker.terminate().catch(() => {});
      watchdog = null;
    },
  };
  return watchdog;
}

export function stopEventLoopWatchdog() {
  watchdog?.stop();
}

export const defaultReportDirectory = (dataDir) => path.join(dataDir, "reports");
