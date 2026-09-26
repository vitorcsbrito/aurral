import { db } from "../../config/database.js";
import { dbOps, userOps, userIdentityOps } from "../../db/helpers/index.js";
import {
  isRecentlyAuthenticated,
  requireAuth,
  requireAdmin,
  requireRecentAuth,
} from "../../middleware/requirePermission.js";
import { plexConnectionStore } from "../../services/plex/plexConnectionStore.js";
import { playlistManager } from "../../services/weeklyFlow/weeklyFlowPlaylistManager.js";
import { logger } from "../../services/logger.js";

function getGlobalPlexConfig() {
  return dbOps.getSettings()?.integrations?.plex || {};
}

export function isPlexLoginEnabled() {
  const plex = getGlobalPlexConfig();
  return plex.loginEnabled === true && !!plex.url && !!plex.token;
}

async function cleanupUserPlexPlaylistsSafely(userId, context, connection = null) {
  try {
    await playlistManager.cleanupUserPlexPlaylists(userId, connection);
  } catch (cleanupError) {
    logger.warn("users", `Plex playlist cleanup ${context} failed:`, cleanupError.message);
  }
}

const LAST_SIGN_IN_METHOD_RESULT = Object.freeze({
  disconnected: false,
  requiresForce: true,
  error: "last_auth_method",
  message: "Removing Plex will leave this account without a usable sign-in method.",
});

// Removes the user's Plex connection and Plex login identity. Refuses, unless
// forced, when that identity is the account's last usable sign-in method.
export async function disconnectUserPlex(userId, { force = false, context = "on unlink" } = {}) {
  const plexIdentity = (await userIdentityOps.getForUser(userId)).find(
    (identity) => identity.providerType === "plex",
  );
  if (plexIdentity && !force && (await userIdentityOps.isLastSignInMethod(userId))) {
    return { ...LAST_SIGN_IN_METHOD_RESULT };
  }

  // Deleting the user's Plex playlists needs their connection, so it runs
  // before the connection is cleared and outside the transaction (it calls Plex).
  await cleanupUserPlexPlaylistsSafely(userId, context);
  if (plexIdentity) {
    const result = await userIdentityOps.unlinkUnlessLastSignIn(userId, plexIdentity.id, {
      force,
      afterUnlink: () => plexConnectionStore.clearConnection(userId),
    });
    if (result.reason === "last_auth_method") return { ...LAST_SIGN_IN_METHOD_RESULT };
    if (result.unlinked) return { disconnected: true, forced: !!force };
  }
  await plexConnectionStore.clearConnection(userId);
  return { disconnected: true, forced: !!force };
}

async function cleanupPlexPlaylistsIfIdentityChanged(
  userId,
  previous,
  linkType,
  plexAccountId,
) {
  const identityChanged =
    previous &&
    (previous.linkType !== linkType ||
      String(previous.plexAccountId ?? "") !== String(plexAccountId ?? ""));
  if (!identityChanged) return;
  await cleanupUserPlexPlaylistsSafely(userId, "after relink", previous);
}

// Saves a self-linked Plex connection and its login identity together. The
// identity is written first: a subject already linked to another account
// fails with 23505 before the connection (and the settings mirror) changes.
export async function persistSelfPlexLink(userId, connection, identity) {
  return db.transaction(async () => {
    await userIdentityOps.replaceForUser(userId, identity);
    return plexConnectionStore.saveConnection(userId, connection);
  });
}

// Resolves the token Plex actually accepts for the configured server: the
// account-level token if there's no server pin, otherwise the server-scoped
// access token from the matching resource. Skips the lookup entirely when no
// server is configured yet, since there is nothing to match against.
async function resolveServerAccessToken(
  token,
  clientId,
  machineIdentifier,
  { mismatchErrorMessage, tolerateLookupFailure = false, warnContext = "" } = {},
) {
  if (!machineIdentifier) return { serverToken: token };
  const { PlexClient } = await import("../../services/plex.js");
  try {
    const { servers } = await PlexClient.getResources(token, clientId);
    const match = (servers || []).find((s) => s.clientIdentifier === machineIdentifier);
    if (!match) return { error: mismatchErrorMessage };
    return { serverToken: match.accessToken || token };
  } catch (resourceError) {
    if (!tolerateLookupFailure) throw resourceError;
    logger.warn(
      "users",
      `Plex resource lookup failed${warnContext ? ` for ${warnContext}` : ""}:`,
      resourceError?.message,
    );
    return { serverToken: token };
  }
}

export async function resolveGlobalPlexAccount() {
  const globalPlex = getGlobalPlexConfig();
  const configuredByUserId = globalPlex.configuredByUserId ?? null;
  const configured = Boolean(globalPlex.url && globalPlex.token);
  if (!configured) return { configured: false, plexUsername: null, configuredByUserId };
  if (globalPlex.plexUsername) {
    return { configured: true, plexUsername: globalPlex.plexUsername, configuredByUserId };
  }
  try {
    const { PlexClient } = await import("../../services/plex.js");
    const identity = await PlexClient.validateToken(globalPlex.token, globalPlex.clientId);
    const plexUsername = identity?.username || identity?.title || null;
    if (plexUsername) {
      const settings = dbOps.getSettings();
      await dbOps.updateSettings({
        ...settings,
        integrations: {
          ...settings.integrations,
          plex: { ...settings.integrations.plex, plexUsername },
        },
      });
    }
    return { configured: true, plexUsername, configuredByUserId };
  } catch {
    return { configured: true, plexUsername: null, configuredByUserId };
  }
}

export function registerPlexLink(router) {
  router.get("/me/plex-link/status", requireAuth, async (req, res) => {
    try {
      const status = await plexConnectionStore.getPublicStatus(req.user.id);
      const globalAccount = await resolveGlobalPlexAccount();
      const isGlobalAccountOwner =
        req.user.role === "admin" &&
        (globalAccount.configuredByUserId == null ||
          Number(globalAccount.configuredByUserId) === Number(req.user.id));
      res.json({ ...status, globalAccount, isGlobalAccountOwner });
    } catch (e) {
      res.status(500).json({ error: "Failed to get Plex link status", message: e.message });
    }
  });

  router.post("/me/plex-link/oauth/pin", requireAuth, async (req, res) => {
    try {
      const { PlexClient } = await import("../../services/plex.js");
      const clientId = PlexClient.generateClientId();
      const { id, code } = await PlexClient.generatePin(clientId);
      const forwardUrl = req.body?.forwardUrl;
      res.json({
        pinId: id,
        code,
        clientId,
        authUrl: PlexClient.buildAuthUrl(clientId, code, forwardUrl),
      });
    } catch (error) {
      logger.error("users", "Plex self-link PIN generation failed:", error.message);
      res.status(500).json({
        error: "Failed to start Plex authentication",
        message: error.message,
      });
    }
  });

  router.post("/me/plex-link/oauth/complete", requireAuth, requireRecentAuth(), async (req, res) => {
    try {
      const { PlexClient } = await import("../../services/plex.js");
      const { pinId, code, clientId } = req.body || {};
      if (!pinId || !code || !clientId) {
        return res.status(400).json({ error: "pinId, code and clientId are required" });
      }
      const token = await PlexClient.checkPin(pinId, code, clientId);
      if (!token) return res.json({ pending: true });

      const identity = await PlexClient.validateToken(token, clientId);
      if (!identity) {
        return res.status(400).json({ error: "Could not verify the Plex account" });
      }

      const globalPlex = getGlobalPlexConfig();
      if (!globalPlex.machineIdentifier) {
        return res.status(400).json({
          error: "Connect and test Plex in Settings before linking your own account",
        });
      }
      const tokenResult = await resolveServerAccessToken(token, clientId, globalPlex.machineIdentifier, {
        mismatchErrorMessage: "This Plex account does not have access to the configured Plex server",
      });
      if (tokenResult.error) {
        return res.status(400).json({ error: tokenResult.error });
      }
      const serverToken = tokenResult.serverToken;

      const subject = identity.id != null ? String(identity.id) : null;
      if (!subject) {
        return res.status(400).json({ error: "Plex did not return a stable account identifier" });
      }
      const alreadyLinked = () =>
        res.status(409).json({
          error: "This Plex account is already linked to another Aurral account",
        });
      const existingIdentity = await userIdentityOps.findByProvider("plex", "plex", subject);
      if (existingIdentity && existingIdentity.userId !== req.user.id) {
        return alreadyLinked();
      }

      const previousConnection = await plexConnectionStore.getConnection(req.user.id);
      let saved;
      try {
        saved = await persistSelfPlexLink(
          req.user.id,
          {
            linkType: "self",
            token: serverToken,
            accountToken: token,
            clientId,
            plexAccountId: identity.id ?? null,
            plexUuid: identity.uuid || null,
            plexUsername: identity.username || identity.title || null,
          },
          {
            providerType: "plex",
            providerKey: "plex",
            subject,
            displayName: identity.username || identity.title || null,
          },
        );
      } catch (error) {
        if (error?.code === "23505") return alreadyLinked();
        throw error;
      }

      await cleanupPlexPlaylistsIfIdentityChanged(
        req.user.id,
        previousConnection,
        "self",
        identity.id,
      );

      res.json({
        connected: true,
        linkType: saved.linkType,
        plexUsername: saved.plexUsername,
        connectedAt: saved.connectedAt,
      });
    } catch (error) {
      logger.error("users", "Plex self-link completion failed:", error.message);
      res.status(500).json({
        error: "Failed to complete Plex connection",
        message: error.message,
      });
    }
  });

  router.delete("/me/plex-link", requireAuth, requireRecentAuth(), async (req, res) => {
    try {
      const result = await disconnectUserPlex(req.user.id);
      if (!result.disconnected) {
        return res.status(400).json({ error: result.error, message: result.message });
      }
      res.json({ connected: false });
    } catch (e) {
      res.status(500).json({ error: "Failed to disconnect Plex", message: e.message });
    }
  });

  router.get("/plex-link/home-users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { PlexClient } = await import("../../services/plex.js");
      const globalPlex = getGlobalPlexConfig();
      if (!globalPlex.token || !globalPlex.clientId) {
        return res.status(400).json({ error: "Connect the global Plex account first" });
      }
      const homeUsers = await PlexClient.getHomeUsers(globalPlex.token, globalPlex.clientId);
      const linkedIds = await plexConnectionStore.getAllLinkedPlexAccountIds();
      res.json({
        users: homeUsers.map((u) => ({
          ...u,
          alreadyLinked: linkedIds.has(String(u.id)),
        })),
      });
    } catch (error) {
      const status = error.response?.status;
      logger.error(
        "users",
        "Listing Plex Home users failed:",
        status ? `${status} ${JSON.stringify(error.response?.data)}` : error.message,
      );
      res.status(status === 401 ? 401 : 500).json({
        error: "Failed to list Plex Home users",
        message:
          status === 401
            ? "Plex rejected the admin token (401). Reconnect Plex in Settings."
            : error.message,
      });
    }
  });

  router.post("/:id/plex-link/managed", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const target = await userOps.getUserById(id);
      if (!target) return res.status(404).json({ error: "User not found" });

      const { plexUserId, plexUsername, plexUuid, pin } = req.body || {};
      if (plexUserId == null) {
        return res.status(400).json({ error: "plexUserId is required" });
      }

      const globalPlex = getGlobalPlexConfig();
      if (!globalPlex.token || !globalPlex.clientId) {
        return res.status(400).json({ error: "Connect the global Plex account first" });
      }

      const { PlexClient } = await import("../../services/plex.js");
      const existingManaged = await plexConnectionStore.getConnection(id);
      const targetClientId =
        existingManaged?.linkType === "managed" &&
        existingManaged.clientId &&
        existingManaged.clientId !== globalPlex.clientId
          ? existingManaged.clientId
          : PlexClient.generateClientId();
      const token = await PlexClient.switchHomeUser(
        plexUserId,
        globalPlex.token,
        globalPlex.clientId,
        targetClientId,
        pin || undefined,
      );
      if (!token) {
        return res.status(502).json({ error: "Plex did not return a token for that user" });
      }

      const tokenResult = await resolveServerAccessToken(
        token,
        targetClientId,
        globalPlex.machineIdentifier,
        {
          mismatchErrorMessage:
            "This Plex Home user does not have access to the configured Plex server",
          tolerateLookupFailure: true,
          warnContext: `managed user ${plexUserId}`,
        },
      );
      if (tokenResult.error) {
        return res.status(400).json({ error: tokenResult.error });
      }
      const serverToken = tokenResult.serverToken;

      const previousConnection = await plexConnectionStore.getConnection(id);

      const saved = await plexConnectionStore.saveConnection(id, {
        linkType: "managed",
        token: serverToken,
        clientId: targetClientId,
        plexAccountId: plexUserId,
        plexUuid: plexUuid || null,
        plexUsername: plexUsername || null,
        linkedByAdminId: req.user.id,
      });
      await cleanupPlexPlaylistsIfIdentityChanged(
        id,
        previousConnection,
        "managed",
        plexUserId,
      );
      res.json({
        connected: true,
        linkType: saved.linkType,
        plexUsername: saved.plexUsername,
        connectedAt: saved.connectedAt,
      });
    } catch (error) {
      const status = error.response?.status;
      logger.error(
        "users",
        "Managed Plex user link failed:",
        status ? `${status} ${JSON.stringify(error.response?.data)}` : error.message,
      );
      res.status(status === 401 ? 401 : 500).json({
        error: "Failed to link managed Plex user",
        message: error.message,
      });
    }
  });

  router.delete("/:id/plex-link", requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const target = await userOps.getUserById(id);
      if (!target) return res.status(404).json({ error: "User not found" });
      const force = String(req.query?.force || "").toLowerCase() === "true";
      if (force && !(await isRecentlyAuthenticated(req))) {
        return res.status(401).json({
          error: "reauth_required",
          message: "Please confirm your credentials to continue",
        });
      }
      const result = await disconnectUserPlex(id, { force, context: "on admin unlink" });
      if (!result.disconnected) {
        return res.status(409).json({
          error: result.error,
          message: result.message,
          requiresForce: true,
          username: target.username,
        });
      }
      if (result.forced) {
        logger.warn("security-audit", "Administrator forcibly removed a user's final sign-in method", {
          administratorUserId: req.user.id,
          targetUserId: id,
          targetUsername: target.username,
          provider: "plex",
        });
      }
      res.json({ connected: false, forced: result.forced });
    } catch (e) {
      res.status(500).json({ error: "Failed to unlink Plex", message: e.message });
    }
  });
}
