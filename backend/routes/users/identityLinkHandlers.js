import { userOps, userIdentityOps } from "../../db/helpers/index.js";
import { requireAuth, requireRecentAuth } from "../../middleware/requirePermission.js";
import { disconnectUserPlex } from "./plexLinkHandlers.js";

const LAST_AUTH_METHOD_MESSAGE =
  "This is your only way to sign in. Set a local password or link another account before removing it.";

export function registerIdentityLink(router) {
  router.get("/me/identities", requireAuth, async (req, res) => {
    try {
      const user = await userOps.getUserById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      const identities = await userIdentityOps.getForUser(req.user.id);
      res.json({
        hasLocalPassword: user.hasLocalPassword,
        identities: identities.map((identity) => ({
          id: identity.id,
          providerType: identity.providerType,
          providerKey: identity.providerKey,
          displayName: identity.displayName,
          linkedAt: identity.linkedAt,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: "Failed to list linked accounts", message: e.message });
    }
  });

  router.delete("/me/identities/:id", requireAuth, requireRecentAuth(), async (req, res) => {
    try {
      const identityId = parseInt(req.params.id, 10);
      const identity = Number.isSafeInteger(identityId)
        ? await userIdentityOps.getById(identityId)
        : null;
      if (!identity || identity.userId !== req.user.id) {
        return res.status(404).json({ error: "Identity not found" });
      }

      if (await userIdentityOps.isLastSignInMethod(req.user.id)) {
        return res.status(400).json({ error: "last_auth_method", message: LAST_AUTH_METHOD_MESSAGE });
      }

      if (identity.providerType === "plex") {
        const result = await disconnectUserPlex(req.user.id, {
          context: "from connected accounts",
        });
        if (!result.disconnected) {
          return res.status(400).json({ error: result.error, message: result.message });
        }
        return res.json({ success: true });
      }

      const result = await userIdentityOps.unlinkUnlessLastSignIn(req.user.id, identityId);
      if (result.reason === "not_found") {
        return res.status(404).json({ error: "Identity not found" });
      }
      if (result.reason === "last_auth_method") {
        return res.status(400).json({ error: "last_auth_method", message: LAST_AUTH_METHOD_MESSAGE });
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to remove linked account", message: e.message });
    }
  });
}
