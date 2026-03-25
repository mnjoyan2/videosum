import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

export const DEFAULT_TARGET_MINUTES = 2;
export const DEFAULT_TRANSCRIBE_MODEL = "whisper-1";
export const DEFAULT_SUMMARY_MODEL = "gpt-5-mini";
export const DURATION_MAX_OVERSHOOT_SEC = 20;
export const DURATION_MAX_UNDERSHOOT_SEC = 15;

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

export async function extractAudio(inputPath, audioPath) {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "mp3",
    audioPath,
  ]);
}

export async function transcribeAudio({ apiKey, audioPath, model }) {
  const audioBuffer = await readFile(audioPath);
  const formData = new FormData();
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");
  formData.append(
    "file",
    new Blob([audioBuffer], { type: "audio/mpeg" }),
    path.basename(audioPath),
  );

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    },
  );

  if (!response.ok) {
    throw new Error(`Transcription failed: ${await response.text()}`);
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
}) {
  const targetSeconds = Math.max(30, Math.round(targetMinutes * 60));
  const maxTotalSeconds = targetSeconds + DURATION_MAX_OVERSHOOT_SEC;
  const transcriptText = segments
    .map((segment) => {
      const segDur = (segment.end - segment.start).toFixed(1);
      return `[${segment.index}] ${formatSeconds(segment.start)} -> ${formatSeconds(segment.end)} (${segDur}s) | ${segment.text}`;
    })
    .join("\n");

  const prompt = [
    "You are creating a short highlight cut from a video's transcript.",
    `Target total duration: about ${targetSeconds} seconds.`,
    `Hard limit: the sum of all clip durations must be at most ${maxTotalSeconds} seconds (target + ${DURATION_MAX_OVERSHOOT_SEC}s). Shorter is fine.`,
    "Choose the most important non-overlapping ranges of transcript segments that preserve the key story.",
    "Each clip is a contiguous range of segments defined by a start segment index and an end segment index (inclusive).",
    "Return strict JSON with this shape:",
    '{ "summary": "short paragraph", "clips": [ { "start_segment": 0, "end_segment": 4, "reason": "why" } ] }',
    "Rules:",
    "- Use only segment indices from the transcript below.",
    "- Each clip's duration equals the time from the start of start_segment to the end of end_segment.",
    "- Clips must not overlap in segment ranges.",
    "- Prefer complete thoughts, not cut-off phrases.",
    `- Prefer total duration between ${targetSeconds - DURATION_MAX_UNDERSHOOT_SEC} and ${maxTotalSeconds} seconds.`,
    "- Keep clips ordered by time.",
    "",
    "Transcript:",
    transcriptText,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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
    }),
  });

  if (!response.ok) {
    throw new Error(`Summary request failed: ${await response.text()}`);
  }

  const payload = await response.json();
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
  outputDir,
  targetMinutes = DEFAULT_TARGET_MINUTES,
  transcribeModel = DEFAULT_TRANSCRIBE_MODEL,
  summaryModel = DEFAULT_SUMMARY_MODEL,
  stitch = true,
}) {
  await ensureFileExists(inputPath);
  await ensureFfmpegExists();

  const tempDir = path.join(outputDir, "tmp");
  await mkdir(tempDir, { recursive: true });

  const audioPath = path.join(tempDir, "audio.mp3");
  const transcriptPath = path.join(outputDir, "transcript.json");
  const summaryPath = path.join(outputDir, "summary.json");
  const summaryTextPath = path.join(outputDir, "summary.txt");
  const videoPath = path.join(outputDir, "summary-video.mp4");

  console.log("1/4 Extracting audio.---..");
  await extractAudio(inputPath, audioPath);

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
    targetMinutes: Number(targetMinutes),
  });
  await writeJson(summaryPath, summary);
  await writeFile(summaryTextPath, `${summary.summary}\n`, "utf8");

  const targetSeconds = Math.max(30, Math.round(Number(targetMinutes) * 60));
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
