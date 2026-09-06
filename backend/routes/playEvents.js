import express from "express";
import { requireAuth } from "../middleware/requirePermission.js";
import { getPlayHistory, recordPlayEvent } from "../services/playEventService.js";

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    res.json({ events: await getPlayHistory(req.user.id, req.query) });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res) => {
  try {
    res.status(201).json({ event: await recordPlayEvent(req.user.id, req.body) });
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not record play event" });
  }
});

export default router;
