import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import {
  getLibraryNews,
  disableNewsFeed,
  getNewsPreferences,
  updateNewsPreferences,
} from "../services/newsService.js";

const router = express.Router();

router.get("/preferences", requireAuth, (req, res) => {
  return res.json(getNewsPreferences(req.user.id));
});

router.patch("/preferences", requireAuth, async (req, res) => {
  if (!Array.isArray(req.body?.blockedPublishers)) {
    return res.status(400).json({ error: "blockedPublishers must be an array" });
  }
  try {
    return res.json(await updateNewsPreferences(req.user.id, req.body));
  } catch (error) {
    return res.status(500).json({ error: "Failed to update news preferences", message: error.message });
  }
});

router.post("/feeds/disable", requireAuth, async (req, res) => {
  const sourceUrl = String(req.body?.sourceUrl || "").trim();
  const sourceName = String(req.body?.sourceName || "").trim();
  if (!sourceUrl && !sourceName) {
    return res.status(400).json({ error: "sourceUrl or sourceName is required" });
  }
  try {
    return res.json(await disableNewsFeed(sourceUrl, sourceName));
  } catch (error) {
    return res.status(500).json({ error: "Failed to disable news feed", message: error.message });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 60));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const mode = req.query.mode === "top" ? "top" : "matched";
    const result = await getLibraryNews({ limit, offset, userId: req.user.id, mode });
    res.set("Cache-Control", "private, no-cache, no-store, must-revalidate");
    return res.json(result);
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ error: "Failed to load artist news", message: error.message });
  }
});

export default router;
