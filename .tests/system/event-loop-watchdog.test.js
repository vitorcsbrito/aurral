import assert from "node:assert/strict";
import test from "node:test";
import { startEventLoopWatchdog } from "../../backend/services/eventLoopWatchdog.js";

test("the event loop watchdog reports a stalled main thread from its own thread", async () => {
  const warnings = [];
  const watchdog = startEventLoopWatchdog({
    heartbeatMs: 50,
    stallMs: 1000,
    logger: { warn: (category, message, data) => warnings.push({ category, message, data }) },
  });
  try {
    const stalled = new Promise((resolve) => watchdog.events.once("stall", resolve));
    const resumed = new Promise((resolve) => watchdog.events.once("resume", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Block the main thread synchronously for longer than the stall threshold.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
    const [stall, resume] = await Promise.all([stalled, resumed]);
    assert.ok(stall.stalledAt > 0);
    assert.ok(resume.blockedMs >= 2000, `blocked ${resume.blockedMs}ms`);
    assert.equal(warnings.some((entry) => entry.message === "Event loop was blocked"), true);
    assert.equal(watchdog.reportDirectory, null, "no report directory configured");
  } finally {
    watchdog.stop();
  }
});
