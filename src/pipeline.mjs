import { mkdir, readFile, writeFile, access, stat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import https from "node:https";

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: () => raw, json: () => JSON.parse(raw) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

export const DEFAULT_TARGET_MINUTES = 2;
export const DEFAULT_TRANSCRIBE_MODEL = "whisper-1";
export const DEFAULT_SUMMARY_MODEL = "gpt-5-mini";
export const DURATION_MAX_OVERSHOOT_SEC = 20;
export const DURATION_MAX_UNDERSHOOT_SEC = 15;

export const SUMMARY_MODES = {
  key_moments: {
    label: "Key moments",
    description: "Most important parts of the video",
    defaultMinutes: 2,
    instruction:
      "Select the most important and informative moments that preserve the key story and main points of this video.",
  },
  short_highlights: {
    label: "Short highlights",
    description: "Fast, engaging clips for social-style watching",
    defaultMinutes: 1,
    instruction:
      "Select the most exciting, surprising, or entertaining moments. Prefer short punchy clips. Cut anything slow, repetitive, or low-energy. Optimise for engagement.",
  },
  action_items: {
    label: "Action items",
    description: "Decisions, tasks, promises and deadlines",
    defaultMinutes: 1.5,
    instruction:
      "Select only the segments where decisions, tasks, commitments, promises, or deadlines are explicitly stated. Ignore background context, discussion, and filler. Each clip should capture a concrete action or decision.",
  },
  topic_chapters: {
    label: "Topic chapters",
    description: "One clip per major topic section",
    defaultMinutes: 3,
    instruction:
      "Identify the major topic sections of the video. For each distinct topic or chapter, select the opening segment where that topic is first introduced. Cover all significant topics in order.",
  },
  tutorial_essentials: {
    label: "Tutorial essentials",
    description: "Only steps, instructions and demonstrations",
    defaultMinutes: 2,
    instruction:
      "Keep only the segments containing actual steps, commands, on-screen demonstrations, or instructions. Cut all intro, outro, filler, opinion, and off-topic discussion. Every clip must contain a concrete instruction or demonstration.",
  },
  trailer: {
    label: "Trailer",
    description: "Dramatic hook + conflict + climax like a movie trailer",
    defaultMinutes: 0.75,
    instruction:
      "Build a dramatic trailer: open with the most compelling hook (first 1-2 clips), include a conflict or challenge moment (middle clips), and end on a climax or cliffhanger (final clip). Prefer short fast-paced cuts of 5-10 seconds each. Make the viewer desperate to watch the full video. Prioritise drama, intrigue, and emotional impact over information.",
  },
};

export const DEFAULT_SUMMARY_MODE = "key_moments";

export async function ensureFileExists(filePath) {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(`Input file not found or not readable: ${filePath}`);
  }
}

export async function ensureFfmpegExists() {
  await runCommand("ffmpeg", ["-version"], { quiet: true });
}

function mimeForAudioPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  return "audio/mpeg";
}

const FFMPEG_INPUT_ROBUST = [
  "-fflags",
  "+genpts+discardcorrupt",
  "-err_detect",
  "ignore_err",
];

const MIN_WAV_BYTES = 512_000;

export async function extractAudio(inputPath, audioPath) {
  try {
    await runCommand("ffmpeg", [
      "-y",
      ...FFMPEG_INPUT_ROBUST,
      "-i",
      inputPath,
      "-vn",
      "-map",
      "0:a:0?",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);
  } catch (err) {
    try {
      const s = await stat(audioPath);
      if (s.size >= MIN_WAV_BYTES) {
        console.warn(
          "[videosum] ffmpeg exited with errors but WAV output looks usable; continuing.",
        );
        return audioPath;
      }
    } catch {
      throw err;
    }
    throw err;
  }
  return audioPath;
}

function buildMultipart(fields) {
  const boundary = randomBytes(16).toString("hex");
  const chunks = [];
  for (const f of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (f.filename) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType || "application/octet-stream"}\r\n\r\n`,
        ),
      );
      chunks.push(Buffer.isBuffer(f.value) ? f.value : Buffer.from(f.value));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${f.name}"\r\n\r\n`,
        ),
      );
      chunks.push(Buffer.from(String(f.value)));
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function transcribeAudio({ apiKey, audioPath, model }) {
  const audioBuffer = await readFile(audioPath);
  const fileMime = mimeForAudioPath(audioPath);
  const { body, contentType } = buildMultipart([
    { name: "model", value: model },
    { name: "response_format", value: "verbose_json" },
    { name: "timestamp_granularities[]", value: "segment" },
    {
      name: "file",
      filename: path.basename(audioPath),
      contentType: fileMime,
      value: audioBuffer,
    },
  ]);

  const response = await httpsRequest(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": contentType,
        "Content-Length": body.length,
      },
    },
    body,
  );

  if (!response.ok) {
    throw new Error(`Transcription failed: ${response.text()}`);
  }

  return response.json();
}

export function normalizeSegments(transcript) {
  if (!Array.isArray(transcript.segments)) {
    return [];
  }

  return transcript.segments
    .map((segment, index) => ({
      index,
      start: Number(segment.start),
      end: Number(segment.end),
      text: String(segment.text || "").trim(),
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start &&
        segment.text,
    );
}

export function responsesApiOutputText(payload) {
  if (
    typeof payload?.output_text === "string" &&
    payload.output_text.length > 0
  ) {
    return payload.output_text;
  }
  const chunks = [];
  for (const item of payload?.output ?? []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      const t = part?.text;
      if (typeof t !== "string" || !t.length) {
        continue;
      }
      if (part.type === "output_text" || part.type === "text") {
        chunks.push(t);
      }
    }
  }
  return chunks.join("");
}

export async function summarizeTranscript({
  apiKey,
  model,
  segments,
  targetMinutes,
  mode = DEFAULT_SUMMARY_MODE,
}) {
  const modeConfig = SUMMARY_MODES[mode] || SUMMARY_MODES[DEFAULT_SUMMARY_MODE];
  const resolvedMinutes =
    targetMinutes != null && Number.isFinite(Number(targetMinutes)) && Number(targetMinutes) > 0
      ? Number(targetMinutes)
      : modeConfig.defaultMinutes;

  const targetSeconds = Math.max(20, Math.round(resolvedMinutes * 60));
  const maxTotalSeconds = targetSeconds + DURATION_MAX_OVERSHOOT_SEC;
  const transcriptText = segments
    .map((segment) => {
      const segDur = (segment.end - segment.start).toFixed(1);
      return `[${segment.index}] ${formatSeconds(segment.start)} -> ${formatSeconds(segment.end)} (${segDur}s) | ${segment.text}`;
    })
    .join("\n");

  const prompt = [
    `You are editing a video. Mode: ${modeConfig.label}.`,
    `Goal: ${modeConfig.instruction}`,
    "",
    `Target total duration: about ${targetSeconds} seconds.`,
    `Hard limit: the sum of all clip durations must be at most ${maxTotalSeconds} seconds. Shorter is fine.`,
    "Each clip is a contiguous range of segments defined by a start segment index and an end segment index (inclusive).",
    "Return strict JSON with this shape:",
    '{ "summary": "short paragraph describing what was selected and why", "clips": [ { "start_segment": 0, "end_segment": 4, "reason": "why this clip was chosen" } ] }',
    "Rules:",
    "- Use only segment indices from the transcript below.",
    "- Each clip's duration equals the time from the start of start_segment to the end of end_segment.",
    "- Clips must not overlap in segment ranges.",
    "- Prefer complete thoughts, not cut-off phrases.",
    `- Prefer total duration between ${Math.max(10, targetSeconds - DURATION_MAX_UNDERSHOOT_SEC)} and ${maxTotalSeconds} seconds.`,
    "- Keep clips ordered by time.",
    "",
    "Transcript:",
    transcriptText,
  ].join("\n");

  const jsonBody = Buffer.from(JSON.stringify({
    model,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "video_summary",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            clips: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  start_segment: { type: "integer" },
                  end_segment: { type: "integer" },
                  reason: { type: "string" },
                },
                required: ["start_segment", "end_segment", "reason"],
              },
            },
          },
          required: ["summary", "clips"],
        },
      },
    },
  }));

  const response = await httpsRequest(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": jsonBody.length,
      },
    },
    jsonBody,
  );

  if (!response.ok) {
    throw new Error(`Summary request failed: ${response.text()}`);
  }

  const payload = response.json();
  const outputText = responsesApiOutputText(payload);

  if (!outputText) {
    throw new Error("Summary response had no assistant text in output.");
  }

  return JSON.parse(outputText);
}

export function buildClipsFromSummary(summary, segments) {
  if (!summary || !Array.isArray(summary.clips)) {
    return [];
  }

  const segByIndex = new Map(segments.map((s) => [s.index, s]));

  const clips = [];

  for (const clip of summary.clips) {
    const startIdx = Number(clip.start_segment);
    const endIdx = Number(clip.end_segment);
    const startSeg = segByIndex.get(startIdx);
    const endSeg = segByIndex.get(endIdx);

    if (!startSeg || !endSeg) continue;

    const start = startSeg.start;
    const end = endSeg.end;

    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.4) {
      continue;
    }

    clips.push({
      start,
      end,
      reason: String(clip.reason || "").trim(),
      segmentIndex: startIdx,
    });
  }

  clips.sort((left, right) => left.start - right.start);

  const deduped = [];
  for (const clip of clips) {
    const previous = deduped.at(-1);
    if (previous && clip.start < previous.end) {
      if (clip.end > previous.end) {
        previous.end = clip.end;
      }
      continue;
    }

    deduped.push({ ...clip });
  }

  return deduped;
}

export function clipsTotalDuration(clips) {
  return clips.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
}

export function enforceClipsMaxDuration(
  clips,
  targetSeconds,
  maxOvershootSec = DURATION_MAX_OVERSHOOT_SEC,
) {
  if (!clips.length) {
    return [];
  }

  const maxTotal = targetSeconds + maxOvershootSec;
  const minClip = 0.4;
  const working = clips.map((clip) => ({ ...clip }));

  function total() {
    return working.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
  }

  let t = total();
  while (t > maxTotal && working.length > 0) {
    const last = working[working.length - 1];
    const dur = last.end - last.start;
    const excess = t - maxTotal;

    if (dur - excess >= minClip) {
      last.end -= excess;
      break;
    }

    if (working.length === 1) {
      const capped = Math.min(dur, maxTotal);
      last.end = last.start + Math.max(minClip, capped);
      break;
    }

    working.pop();
    t = total();
  }

  return working.filter((clip) => clip.end - clip.start >= minClip);
}

const FADE_SECS = 0.4;

export async function stitchVideo(inputPath, outputPath, clips) {
  const filterParts = [];
  const concatInputs = [];

  clips.forEach((clip, index) => {
    const dur = clip.end - clip.start;
    const fd = Math.min(FADE_SECS, dur * 0.3);

    const fadeIn = `fade=t=in:st=0:d=${fd.toFixed(3)}`;
    const fadeOut = `fade=t=out:st=${(dur - fd).toFixed(3)}:d=${fd.toFixed(3)}`;
    const aFadeIn = `afade=t=in:st=0:d=${fd.toFixed(3)}`;
    const aFadeOut = `afade=t=out:st=${(dur - fd).toFixed(3)}:d=${fd.toFixed(3)}`;

    filterParts.push(
      `[0:v]trim=start=${clip.start}:end=${clip.end},setpts=PTS-STARTPTS,${fadeIn},${fadeOut}[v${index}]`,
      `[0:a]atrim=start=${clip.start}:end=${clip.end},asetpts=PTS-STARTPTS,${aFadeIn},${aFadeOut}[a${index}]`,
    );
    concatInputs.push(`[v${index}][a${index}]`);
  });

  filterParts.push(
    `${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[outv][outa]`,
  );

  await runCommand("ffmpeg", [
    "-y",
    ...FFMPEG_INPUT_ROBUST,
    "-i",
    inputPath,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

export function formatSeconds(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = (totalSeconds % 60).toFixed(2).padStart(5, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runSummaryPipeline({
  apiKey,
  inputPath,
  audioInputPath,
  outputDir,
  targetMinutes = null,
  mode = DEFAULT_SUMMARY_MODE,
  transcribeModel = DEFAULT_TRANSCRIBE_MODEL,
  summaryModel = DEFAULT_SUMMARY_MODEL,
  stitch = true,
}) {
  const modeConfig = SUMMARY_MODES[mode] || SUMMARY_MODES[DEFAULT_SUMMARY_MODE];
  const resolvedMinutes =
    targetMinutes != null && Number.isFinite(Number(targetMinutes)) && Number(targetMinutes) > 0
      ? Number(targetMinutes)
      : modeConfig.defaultMinutes;
  await ensureFileExists(inputPath);
  const extractSource = audioInputPath || inputPath;
  if (audioInputPath) {
    await ensureFileExists(audioInputPath);
  }
  await ensureFfmpegExists();

  const tempDir = path.join(outputDir, "tmp");
  await mkdir(tempDir, { recursive: true });

  const audioPath = path.join(tempDir, "audio.wav");
  const transcriptPath = path.join(outputDir, "transcript.json");
  const summaryPath = path.join(outputDir, "summary.json");
  const summaryTextPath = path.join(outputDir, "summary.txt");
  const videoPath = path.join(outputDir, "summary-video.mp4");

  console.log("1/4 Extracting audio.---..");
  await extractAudio(extractSource, audioPath);

  console.log("2/4 Transcribing with Whisper...");
  const transcript = await transcribeAudio({
    apiKey,
    audioPath,
    model: transcribeModel,
  });
  await writeJson(transcriptPath, transcript);

  const segments = normalizeSegments(transcript);
  if (segments.length === 0) {
    throw new Error("Whisper returned no timestamped segments.");
  }

  console.log("3/4 Asking OpenAI to summarize and choose clips...");
  const summary = await summarizeTranscript({
    apiKey,
    model: summaryModel,
    segments,
    targetMinutes: resolvedMinutes,
    mode,
  });
  await writeJson(summaryPath, summary);
  await writeFile(summaryTextPath, `${summary.summary}\n`, "utf8");

  const targetSeconds = Math.max(20, Math.round(resolvedMinutes * 60));
  let clips = buildClipsFromSummary(summary, segments);
  clips = enforceClipsMaxDuration(clips, targetSeconds);
  if (clips.length === 0) {
    throw new Error("No valid clips were selected from the transcript.");
  }

  const clipSeconds = clipsTotalDuration(clips);
  console.log(
    `Clip duration: ${clipSeconds.toFixed(1)}s (target ${targetSeconds}s, max ${targetSeconds + DURATION_MAX_OVERSHOOT_SEC}s)`,
  );

  if (stitch) {
    console.log("4/4 Rendering summarized video...");
    await stitchVideo(inputPath, videoPath, clips);
  }

  return {
    transcript,
    segments,
    summary,
    clips,
    paths: {
      transcript: transcriptPath,
      summaryJson: summaryPath,
      summaryText: summaryTextPath,
      video: stitch ? videoPath : null,
    },
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function runCommand(command, args, options = {}) {
  const quiet = Boolean(options.quiet);

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: quiet ? "ignore" : "inherit",
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}
