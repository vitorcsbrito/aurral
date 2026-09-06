import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { weeklyFlowWorker } from "./weeklyFlowWorker.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";
import { isAnyDownloadSourceConfigured } from "../downloadSourceService.js";
import { weeklyFlowOperationQueue } from "./weeklyFlowOperationQueue.js";
import {
  createWeeklyFlowOperationToken,
  markLatestWeeklyFlowOperationToken,
} from "./weeklyFlowOperations.js";

export async function runScheduledRefresh() {
  if (!isAnyDownloadSourceConfigured()) return;

  const due = flowPlaylistConfig.getDueForRefresh();
  if (due.length === 0) return;

  for (const flow of due) {
    try {
      const token = createWeeklyFlowOperationToken();
      const tokenScope = `flow:${flow.id}:scheduled`;
      await markLatestWeeklyFlowOperationToken(tokenScope, token);
      await weeklyFlowOperationQueue.enqueuePayload({
        kind: "scheduled-flow-refresh",
        label: `scheduled:${flow.id}`,
        flowId: flow.id,
        tokenScope,
        token,
      });
    } catch (error) {
      console.error(`[WeeklyFlowScheduler] Failed to refresh ${flow.id}:`, error.message);
    }
  }
}

export async function startWorkerIfPending() {
  const pending = downloadTracker.getNextPending();
  if (!pending) return;
  if (weeklyFlowWorker.running) {
    weeklyFlowWorker.wake();
    return;
  }
  await weeklyFlowWorker.start();
}
