import { getDiscoveryFeedback, addDiscoveryFeedback, removeDiscoveryFeedback, resetDiscoveryFeedback } from "../../../services/discovery/index.js";

export function registerFeedback(router) {
  router.get("/feedback", requireAuth, (req, res) => {
    res.json({
      feedback: getDiscoveryFeedback(req.user?.id || "global"),
    });
  });

  router.post("/feedback", requireAuth, async (req, res) => {
    try {
      const feedback = await addDiscoveryFeedback(
        req.user?.id || "global",
        req.body || {},
      );
      res.json({
        success: true,
        feedback,
        feedbackList: getDiscoveryFeedback(req.user?.id || "global"),
      });
    } catch (error) {
      res.status(400).json({
        error: "Failed to save discovery feedback",
        message: error.message,
      });
    }
  });

  router.delete("/feedback/:id", requireAuth, async (req, res) => {
    const feedbackList = await removeDiscoveryFeedback(
      req.user?.id || "global",
      req.params.id,
    );
    res.json({
      success: true,
      feedbackList,
    });
  });

  router.post("/feedback/reset", requireAuth, async (req, res) => {
    const feedbackList = await resetDiscoveryFeedback(req.user?.id || "global");
    res.json({
      success: true,
      feedbackList,
    });
  });
}

import { requireAuth } from "../../../middleware/requirePermission.js";
