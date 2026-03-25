import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runSummaryPipeline, DEFAULT_TARGET_MINUTES } from "./pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const jobsRoot = path.join(root, "output", "jobs");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeUpload(jobId) {
  return multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        const dir = path.join(jobsRoot, jobId);
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || ".mp4";
        cb(null, `input${ext}`);
      }
    }),
    limits: { fileSize: 1024 * 1024 * 1024 }
  });
}

const app = express();

app.use(express.static(path.join(root, "public")));

app.post("/api/summarize", (req, res, next) => {
  const jobId = randomUUID();
  req.jobId = jobId;
  makeUpload(jobId).single("video")(req, res, next);
}, async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No video file uploaded." });
      return;
    }
    const jobId = req.jobId;
    const outputDir = path.join(jobsRoot, jobId);
    const rawTarget = req.body?.targetMinutes;
    const targetMinutes =
      rawTarget != null && String(rawTarget).trim() !== ""
        ? Number(rawTarget)
        : DEFAULT_TARGET_MINUTES;

    const result = await runSummaryPipeline({
      apiKey,
      inputPath: req.file.path,
      outputDir,
      targetMinutes,
      stitch: true
    });

    res.json({
      jobId,
      fullText: result.transcript.text ?? "",
      language: result.transcript.language ?? null,
      duration: result.transcript.duration ?? null,
      segments: result.segments,
      summary: result.summary.summary,
      clips: result.summary.clips,
      normalizedClips: result.clips,
      videoUrl: `/api/jobs/${jobId}/summary-video.mp4`
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Processing failed." });
  }
});

app.get("/api/jobs/:jobId/:filename", (req, res, next) => {
  const { jobId, filename } = req.params;
  if (!UUID_RE.test(jobId)) {
    res.status(400).send("Invalid job id");
    return;
  }
  if (filename !== "summary-video.mp4") {
    res.status(404).end();
    return;
  }
  const filePath = path.join(jobsRoot, jobId, filename);
  res.sendFile(filePath, (err) => {
    if (err) {
      next(err);
    }
  });
});

app.use((err, _req, res, _next) => {
  if (err?.code === "ENOENT") {
    res.status(404).send("File not found");
    return;
  }
  res.status(500).send(err?.message || "Server error");
});

const PORT = Number(process.env.PORT || 3847);
const server = app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
server.requestTimeout = 60 * 60 * 1000;
server.headersTimeout = 65 * 60 * 1000;
