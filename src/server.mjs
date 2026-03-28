import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  runSummaryPipeline,
  DEFAULT_TARGET_MINUTES,
  DEFAULT_SUMMARY_MODE,
  SUMMARY_MODES,
} from "./pipeline.mjs";

function normalizeSummaryMode(raw) {
  if (raw == null || String(raw).trim() === "") {
    return DEFAULT_SUMMARY_MODE;
  }
  const id = String(raw).trim();
  return Object.prototype.hasOwnProperty.call(SUMMARY_MODES, id)
    ? id
    : DEFAULT_SUMMARY_MODE;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const jobsRoot = path.join(root, "output", "jobs");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_JOBS || 3),
);

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
      },
    }),
    limits: { fileSize: 1024 * 1024 * 1024 },
  });
}

const jobStore = new Map();

let slotInUse = 0;
const slotWaiters = [];

async function acquireSlot() {
  if (slotInUse < MAX_CONCURRENT_JOBS) {
    slotInUse += 1;
    return;
  }
  await new Promise((resolve) => {
    slotWaiters.push(resolve);
  });
  slotInUse += 1;
}

function releaseSlot() {
  slotInUse -= 1;
  const next = slotWaiters.shift();
  if (next) {
    next();
  }
}

function setJob(jobId, patch) {
  const prev = jobStore.get(jobId) || {};
  jobStore.set(jobId, { ...prev, ...patch });
}

function buildSuccessPayload(jobId, result) {
  return {
    jobId,
    fullText: result.transcript.text ?? "",
    language: result.transcript.language ?? null,
    duration: result.transcript.duration ?? null,
    segments: result.segments,
    summary: result.summary.summary,
    clips: result.summary.clips,
    normalizedClips: result.clips,
    videoUrl: `/api/jobs/${jobId}/summary-video.mp4`,
  };
}

function parseAllowedVideoUrl(urlString) {
  let u;
  try {
    u = new URL(String(urlString).trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\//, "").split("/")[0];
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      return null;
    }
    return {
      canonical: `https://www.youtube.com/watch?v=${id}`,
      videoId: id,
    };
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
        return {
          canonical: `https://www.youtube.com/watch?v=${id}`,
          videoId: id,
        };
      }
      return null;
    }
    const shorts = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shorts) {
      const id = shorts[1];
      return {
        canonical: `https://www.youtube.com/watch?v=${id}`,
        videoId: id,
      };
    }
    return null;
  }
  return null;
}

async function runYtDlp(url, outDir) {
  await mkdir(outDir, { recursive: true });
  const template = path.join(outDir, "input.%(ext)s");
  console.log(`[videosum] yt-dlp downloading…`);
  await new Promise((resolve, reject) => {
    const child = spawn(
      "yt-dlp",
      [
        "-o",
        template,
        "--no-playlist",
        "--no-warnings",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      reject(
        new Error(
          err.code === "ENOENT"
            ? "yt-dlp is not installed or not in PATH."
            : err.message,
        ),
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`[videosum] yt-dlp finished`);
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() || `yt-dlp exited with code ${code}.`,
        ),
      );
    });
  });
}

async function findDownloadedInputFile(outDir) {
  const files = await readdir(outDir);
  const name = files.find((f) => f.startsWith("input.") && !f.endsWith(".part"));
  if (!name) {
    throw new Error("Download finished but input file was not found.");
  }
  return path.join(outDir, name);
}

async function startJobPipeline({
  jobId,
  inputPath,
  targetMinutes,
  mode,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    setJob(jobId, {
      status: "failed",
      error: "OPENAI_API_KEY is not configured.",
    });
    return;
  }
  await acquireSlot();
  setJob(jobId, { status: "running" });
  console.log(`[videosum] job ${jobId} pipeline starting (mode: ${mode || DEFAULT_SUMMARY_MODE})`);
  try {
    const outputDir = path.join(jobsRoot, jobId);
    const result = await runSummaryPipeline({
      apiKey,
      inputPath,
      outputDir,
      targetMinutes: targetMinutes ?? null,
      mode: mode || DEFAULT_SUMMARY_MODE,
      stitch: true,
    });
    setJob(jobId, {
      status: "done",
      result: buildSuccessPayload(jobId, result),
      error: null,
    });
    console.log(`[videosum] job ${jobId} done`);
  } catch (e) {
    setJob(jobId, {
      status: "failed",
      error: e.message || "Processing failed.",
      result: null,
    });
    console.log(`[videosum] job ${jobId} failed: ${e.message || e}`);
  } finally {
    releaseSlot();
  }
}

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.static(path.join(root, "public")));

app.get("/api/summary-modes", (_req, res) => {
  const modes = Object.entries(SUMMARY_MODES).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    description: cfg.description,
    defaultMinutes: cfg.defaultMinutes,
  }));
  res.json({ modes, defaultMode: DEFAULT_SUMMARY_MODE });
});

function jsonBody(req, res, next) {
  express.json()(req, res, next);
}

app.post("/api/jobs", (req, res, next) => {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    const jobId = randomUUID();
    req.jobId = jobId;
    makeUpload(jobId).single("video")(req, res, next);
  } else {
    jsonBody(req, res, next);
  }
}, async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "OPENAI_API_KEY is not configured." });
      return;
    }

    const rawTarget = req.body?.targetMinutes;
    const targetMinutes =
      rawTarget != null && String(rawTarget).trim() !== ""
        ? Number(rawTarget)
        : null;
    const mode = normalizeSummaryMode(req.body?.mode);

    if (req.file) {
      const jobId = req.jobId;
      setJob(jobId, { status: "pending", result: null, error: null });
      console.log(`[videosum] job ${jobId} created (upload)`);
      void startJobPipeline({
        jobId,
        inputPath: req.file.path,
        targetMinutes,
        mode,
      });
      res.status(201).json({ jobId });
      return;
    }

    const url = req.body?.url;
    if (url == null || String(url).trim() === "") {
      res.status(400).json({ error: "Provide url (JSON) or multipart video field." });
      return;
    }

    const parsed = parseAllowedVideoUrl(url);
    if (!parsed) {
      res.status(400).json({ error: "URL must be a supported YouTube watch or Shorts link." });
      return;
    }

    const jobId = randomUUID();
    const outputDir = path.join(jobsRoot, jobId);
    await mkdir(outputDir, { recursive: true });

    setJob(jobId, { status: "pending", result: null, error: null });
    console.log(`[videosum] job ${jobId} created (url) ${parsed.canonical}`);

    void (async () => {
      try {
        await runYtDlp(parsed.canonical, outputDir);
        const inputPath = await findDownloadedInputFile(outputDir);
        await startJobPipeline({
          jobId,
          inputPath,
          targetMinutes,
          mode,
        });
      } catch (e) {
        setJob(jobId, {
          status: "failed",
          error: e.message || "Download or processing failed.",
          result: null,
        });
      }
    })();

    res.status(201).json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to create job." });
  }
});

app.get("/api/jobs/:jobId", (req, res) => {
  const { jobId } = req.params;
  if (!UUID_RE.test(jobId)) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }
  const job = jobStore.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const body = {
    jobId,
    status: job.status,
  };
  if (job.status === "done" && job.result) {
    Object.assign(body, job.result);
  }
  if (job.status === "failed" && job.error) {
    body.error = job.error;
  }
  res.json(body);
});

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
        : null;
    const mode = normalizeSummaryMode(req.body?.mode);

    const result = await runSummaryPipeline({
      apiKey,
      inputPath: req.file.path,
      outputDir,
      targetMinutes,
      mode,
      stitch: true,
    });

    res.json(buildSuccessPayload(jobId, result));
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

process.on("uncaughtException", (err) => {
  console.error("[videosum] uncaught exception:", err.message || err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[videosum] unhandled rejection:", reason);
  process.exit(1);
});

const PORT = Number(process.env.PORT || 3847);
const server = app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[videosum] Port ${PORT} is already in use.\n  Run: lsof -ti :${PORT} | xargs kill -9\n  Then restart with: npm run ui`,
    );
  } else {
    console.error("[videosum] server error:", err.message || err);
  }
  process.exit(1);
});

server.requestTimeout = 60 * 60 * 1000;
server.headersTimeout = 65 * 60 * 1000;
