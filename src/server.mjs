import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  runSummaryPipeline,
  DEFAULT_TARGET_MINUTES,
  DEFAULT_SUMMARY_MODE,
  DEFAULT_SUMMARY_MODEL,
  SUMMARY_MODES,
  summarizeTranscript,
  buildClipsFromSummary,
  enforceClipsMaxDuration,
  clipsTotalDuration,
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const fullText =
    result.transcript.text ??
    (Array.isArray(result.segments)
      ? result.segments
          .map((segment) => segment.text)
          .filter(Boolean)
          .join(" ")
      : "");

  return {
    jobId,
    sourceType: result.sourceType || "upload",
    fullText,
    language: result.transcript.language ?? null,
    duration: result.transcript.duration ?? null,
    segments: result.segments,
    summary: result.summary.summary,
    clips: result.summary.clips,
    normalizedClips: result.clips,
    videoUrl: result.paths?.video
      ? `/api/jobs/${jobId}/summary-video.mp4`
      : null,
    youtubeVideoId: result.youtubeVideoId ?? null,
    youtubeWatchUrl: result.youtubeWatchUrl ?? null,
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

let ytDlpCookiesCachedPath = null;

function getYtDlpCookieArgs() {
  const out = [];
  const cookiesB64 = String(process.env.YTDLP_COOKIES_TEXT_B64 || "").trim();
  const cookiesText = String(process.env.YTDLP_COOKIES_TEXT || "");
  const cookiesFile = String(process.env.YTDLP_COOKIES || "").trim();
  const cookiesBrowser = String(
    process.env.YTDLP_COOKIES_FROM_BROWSER || "",
  ).trim();
  let filePath = "";
  if (cookiesB64) {
    if (!ytDlpCookiesCachedPath) {
      try {
        const decoded = Buffer.from(cookiesB64, "base64").toString("utf8");
        ytDlpCookiesCachedPath = path.join(
          tmpdir(),
          "videosum-youtube-cookies.txt",
        );
        writeFileSync(ytDlpCookiesCachedPath, decoded, "utf8");
      } catch {
        ytDlpCookiesCachedPath = null;
      }
    }
    if (ytDlpCookiesCachedPath) {
      filePath = ytDlpCookiesCachedPath;
    }
  } else if (cookiesText.trim()) {
    if (!ytDlpCookiesCachedPath) {
      ytDlpCookiesCachedPath = path.join(
        tmpdir(),
        "videosum-youtube-cookies.txt",
      );
      writeFileSync(ytDlpCookiesCachedPath, cookiesText, "utf8");
    }
    filePath = ytDlpCookiesCachedPath;
  } else if (cookiesFile && existsSync(cookiesFile)) {
    filePath = cookiesFile;
  }
  if (filePath) {
    out.push("--cookies", filePath);
  } else if (cookiesBrowser) {
    out.push("--cookies-from-browser", cookiesBrowser);
  }
  return out;
}

function logYtDlpCookieStatus() {
  const hasFile = String(process.env.YTDLP_COOKIES || "").trim();
  const args = getYtDlpCookieArgs();
  if (args.length === 0) {
    if (hasFile && !existsSync(hasFile)) {
      console.warn(
        `[videosum] yt-dlp: YTDLP_COOKIES file not found: ${hasFile}`,
      );
    } else {
      console.warn(
        "[videosum] yt-dlp: no cookies configured — YouTube often returns “Sign in to confirm you’re not a bot”. Set YTDLP_COOKIES_TEXT_B64, YTDLP_COOKIES_TEXT, YTDLP_COOKIES, or YTDLP_COOKIES_FROM_BROWSER.",
      );
    }
    return;
  }
  if (args[0] === "--cookies") {
    console.log("[videosum] yt-dlp: --cookies enabled");
  } else {
    console.log("[videosum] yt-dlp: --cookies-from-browser enabled");
  }
}

async function runYtDlp(url, outDir) {
  await mkdir(outDir, { recursive: true });
  const template = path.join(outDir, "input.%(ext)s");
  console.log(`[videosum] yt-dlp downloading…`);
  await new Promise((resolve, reject) => {
    const child = spawn(
      "yt-dlp",
      [
        ...getYtDlpCookieArgs(),
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
      reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}.`));
    });
  });
}

async function runYtDlpJson(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "yt-dlp",
      [
        ...getYtDlpCookieArgs(),
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        url,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
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
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse yt-dlp metadata: ${error.message}`));
      }
    });
  });
}

function pickCaptionTrack(info) {
  const subtitles = info?.subtitles || {};
  const automatic = info?.automatic_captions || {};
  const originalLanguage = String(
    info?.language || info?.requested_subtitles || "",
  )
    .trim()
    .toLowerCase();

  const candidates = [];
  const pushTracks = (source, table, sourceWeight) => {
    for (const [language, tracks] of Object.entries(table)) {
      if (!Array.isArray(tracks)) {
        continue;
      }
      for (const track of tracks) {
        const ext = String(track?.ext || "").toLowerCase();
        const url = String(track?.url || "").trim();
        if (!url) {
          continue;
        }
        const lang = String(language || "").toLowerCase();
        let score = sourceWeight;
        if (ext === "json3" || ext === "srv3") {
          score += 40;
        } else if (ext === "vtt") {
          score += 25;
        }
        if (lang === originalLanguage && originalLanguage) {
          score += 35;
        }
        if (lang === "en" || lang.startsWith("en-")) {
          score += 20;
        }
        if (lang.includes("orig")) {
          score += 10;
        }
        candidates.push({
          source,
          language,
          ext,
          url,
          score,
        });
      }
    }
  };

  pushTracks("subtitles", subtitles, 100);
  pushTracks("automatic_captions", automatic, 70);
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] || null;
}

function parseYouTubeJson3Transcript(raw) {
  const payload = JSON.parse(raw);
  const segments = [];

  for (const event of payload?.events || []) {
    const parts = Array.isArray(event?.segs) ? event.segs : [];
    const text = parts
      .map((part) => String(part?.utf8 || ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    const start = Number(event?.tStartMs) / 1000;
    const duration = Number(event?.dDurationMs) / 1000;
    const end = start + duration;

    if (
      !text ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      continue;
    }

    segments.push({
      start,
      end,
      text,
    });
  }

  return segments;
}

function parseTimestampToSeconds(value) {
  const match = String(value)
    .trim()
    .match(/^(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number((match[4] || "0").padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function parseWebVttTranscript(raw) {
  const blocks = String(raw)
    .replace(/\r/g, "")
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean);

  const segments = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const cueIndex = lines.findIndex((line) => line.includes("-->"));
    if (cueIndex === -1) {
      continue;
    }
    const timing = lines[cueIndex].split("-->").map((part) => part.trim());
    if (timing.length !== 2) {
      continue;
    }
    const start = parseTimestampToSeconds(timing[0]);
    const end = parseTimestampToSeconds(timing[1].split(" ")[0]);
    const text = lines
      .slice(cueIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (
      !text ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      continue;
    }

    segments.push({ start, end, text });
  }

  return segments;
}

async function fetchYouTubeTranscript(parsed) {
  const info = await runYtDlpJson(parsed.canonical);
  const track = pickCaptionTrack(info);
  if (!track) {
    throw new Error(
      "This YouTube video does not expose captions that can be summarized instantly.",
    );
  }

  const response = await fetch(track.url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch YouTube captions: ${await response.text()}`,
    );
  }

  const raw = await response.text();
  let baseSegments = [];
  if (track.ext === "json3" || track.ext === "srv3") {
    baseSegments = parseYouTubeJson3Transcript(raw);
  } else {
    baseSegments = parseWebVttTranscript(raw);
  }

  const segments = baseSegments.map((segment, index) => ({
    index,
    start: segment.start,
    end: segment.end,
    text: segment.text,
  }));

  if (!segments.length) {
    throw new Error(
      "Captions were found, but no transcript segments could be parsed.",
    );
  }

  return {
    transcript: {
      text: segments.map((segment) => segment.text).join(" "),
      language: track.language || info?.language || null,
      duration: Number(info?.duration) || null,
    },
    segments,
    youtubeVideoId: parsed.videoId,
    youtubeWatchUrl: parsed.canonical,
  };
}

async function runYouTubeSummaryPipeline({
  apiKey,
  parsed,
  targetMinutes,
  mode,
}) {
  const transcriptBundle = await fetchYouTubeTranscript(parsed);
  const modeConfig = SUMMARY_MODES[mode] || SUMMARY_MODES[DEFAULT_SUMMARY_MODE];
  const resolvedMinutes =
    targetMinutes != null &&
    Number.isFinite(Number(targetMinutes)) &&
    Number(targetMinutes) > 0
      ? Number(targetMinutes)
      : modeConfig.defaultMinutes;

  const summary = await summarizeTranscript({
    apiKey,
    model: DEFAULT_SUMMARY_MODEL,
    segments: transcriptBundle.segments,
    targetMinutes: resolvedMinutes,
    mode,
  });

  const targetSeconds = Math.max(20, Math.round(resolvedMinutes * 60));
  let clips = buildClipsFromSummary(summary, transcriptBundle.segments);
  clips = enforceClipsMaxDuration(clips, targetSeconds);
  if (!clips.length) {
    throw new Error(
      "No valid summary clips were selected from the YouTube transcript.",
    );
  }

  console.log(
    `[videosum] YouTube instant summary duration ${clipsTotalDuration(clips).toFixed(1)}s`,
  );

  return {
    sourceType: "youtube",
    transcript: transcriptBundle.transcript,
    segments: transcriptBundle.segments,
    summary,
    clips,
    youtubeVideoId: transcriptBundle.youtubeVideoId,
    youtubeWatchUrl: transcriptBundle.youtubeWatchUrl,
    paths: {
      video: null,
    },
  };
}

async function findDownloadedInputFile(outDir) {
  const files = await readdir(outDir);
  const name = files.find(
    (f) => f.startsWith("input.") && !f.endsWith(".part"),
  );
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
  apiKey,
}) {
  const resolvedKey = apiKey || process.env.OPENAI_API_KEY;
  if (!resolvedKey) {
    setJob(jobId, {
      status: "failed",
      error:
        "No OpenAI API key provided. Set one in the extension/app settings.",
    });
    return;
  }
  await acquireSlot();
  setJob(jobId, { status: "running" });
  console.log(
    `[videosum] job ${jobId} pipeline starting (mode: ${mode || DEFAULT_SUMMARY_MODE})`,
  );
  try {
    const outputDir = path.join(jobsRoot, jobId);
    const result = await runSummaryPipeline({
      apiKey: resolvedKey,
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

async function startYouTubeJobPipeline({
  jobId,
  parsed,
  targetMinutes,
  mode,
  apiKey,
}) {
  const resolvedKey = apiKey || process.env.OPENAI_API_KEY;
  if (!resolvedKey) {
    setJob(jobId, {
      status: "failed",
      error:
        "No OpenAI API key provided. Set one in the extension/app settings.",
    });
    return;
  }
  await acquireSlot();
  setJob(jobId, { status: "running" });
  console.log(
    `[videosum] job ${jobId} instant youtube summary starting (mode: ${mode || DEFAULT_SUMMARY_MODE})`,
  );
  try {
    const result = await runYouTubeSummaryPipeline({
      apiKey: resolvedKey,
      parsed,
      targetMinutes: targetMinutes ?? null,
      mode: mode || DEFAULT_SUMMARY_MODE,
    });
    setJob(jobId, {
      status: "done",
      result: buildSuccessPayload(jobId, result),
      error: null,
    });
  } catch (e) {
    setJob(jobId, {
      status: "failed",
      error: e.message || "Processing failed.",
      result: null,
    });
  } finally {
    releaseSlot();
  }
}

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");
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

app.get("/api/health", (_req, res) => {
  const args = getYtDlpCookieArgs();
  res.json({
    ok: true,
    ytDlpCookiesConfigured: args.length > 0,
  });
});

function jsonBody(req, res, next) {
  express.json()(req, res, next);
}

app.post(
  "/api/jobs",
  (req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      const jobId = randomUUID();
      req.jobId = jobId;
      makeUpload(jobId).single("video")(req, res, next);
    } else {
      jsonBody(req, res, next);
    }
  },
  async (req, res) => {
    try {
      const apiKey =
        String(req.body?.apiKey || req.headers["x-api-key"] || "").trim() ||
        null;

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
          apiKey,
        });
        res.status(201).json({ jobId });
        return;
      }

      const url = req.body?.url;
      if (url == null || String(url).trim() === "") {
        res
          .status(400)
          .json({ error: "Provide url (JSON) or multipart video field." });
        return;
      }

      const parsed = parseAllowedVideoUrl(url);
      if (!parsed) {
        res
          .status(400)
          .json({
            error: "URL must be a supported YouTube watch or Shorts link.",
          });
        return;
      }

      const jobId = randomUUID();
      setJob(jobId, { status: "pending", result: null, error: null });
      console.log(`[videosum] job ${jobId} created (url) ${parsed.canonical}`);

      void startYouTubeJobPipeline({
        jobId,
        parsed,
        targetMinutes,
        mode,
        apiKey,
      });

      res.status(201).json({ jobId });
    } catch (e) {
      res.status(500).json({ error: e.message || "Failed to create job." });
    }
  },
);

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

app.post(
  "/api/summarize",
  (req, res, next) => {
    const jobId = randomUUID();
    req.jobId = jobId;
    makeUpload(jobId).single("video")(req, res, next);
  },
  async (req, res) => {
    try {
      const apiKey =
        String(req.body?.apiKey || req.headers["x-api-key"] || "").trim() ||
        process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res
          .status(400)
          .json({
            error: "No OpenAI API key provided. Set one in the app settings.",
          });
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
  },
);

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
  logYtDlpCookieStatus();
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
