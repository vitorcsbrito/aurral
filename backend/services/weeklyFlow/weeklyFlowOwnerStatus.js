import { db } from "../../config/database.js";
import { userOps } from "../../db/helpers/index.js";
import { flowPlaylistConfig } from "./weeklyFlowPlaylistConfig.js";

// Playlist work stops while the owning account is suspended or disabled.
// An owner is inactive only when their account exists with a non-active
// status; flows without an owner, or whose owner was deleted, keep running.
//
// The download worker checks owners synchronously (its dequeue predicate runs
// for every pending job), so it reads this mirror of the inactive account ids.
// The worker refreshes it at the start of every loop tick and routes/users.js
// refreshes it after a status change. Async callers read the database.
let inactiveOwnerIds = new Set();
let refreshSequence = 0;
let appliedSequence = 0;

export async function refreshOwnerStatus() {
  const sequence = ++refreshSequence;
  const rows = await db.all("SELECT id FROM users WHERE status <> 'active'");
  // A refresh that started later saw newer data; never overwrite it.
  if (sequence > appliedSequence) {
    appliedSequence = sequence;
    inactiveOwnerIds = new Set(rows.map((row) => Number(row.id)));
  }
  return inactiveOwnerIds.size;
}

function resolvePlaylistOwnerId(playlistType) {
  const key = String(playlistType || "").trim();
  if (!key) return null;
  const entity = flowPlaylistConfig.getFlow(key) || flowPlaylistConfig.getSharedPlaylist(key);
  if (!entity || entity.ownerUserId == null) return null;
  const ownerId = Number(entity.ownerUserId);
  return Number.isSafeInteger(ownerId) && ownerId > 0 ? ownerId : null;
}

export function isPlaylistOwnerActiveSync(playlistType) {
  if (inactiveOwnerIds.size === 0) return true;
  const ownerId = resolvePlaylistOwnerId(playlistType);
  return ownerId == null || !inactiveOwnerIds.has(ownerId);
}

export async function isPlaylistOwnerActive(playlistType) {
  const ownerId = resolvePlaylistOwnerId(playlistType);
  if (ownerId == null) return true;
  const owner = await userOps.getUserAuthById(ownerId);
  return !owner || owner.status === "active";
}

// Pipeline payloads of an inactive owner's job are re-queued with a delay
// instead of finishing, until the owner is active again.
export async function deferForInactiveOwner(payload, job) {
  if (await isPlaylistOwnerActive(job?.playlistId || job?.playlistType)) return null;
  return { ...payload, delaySeconds: 30 };
}
