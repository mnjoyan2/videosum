import { useEffect, useMemo, useRef, useState } from "react";
import { Search, UploadCloud, Play, SkipForward, LoaderCircle, Mic, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { cn, formatSeconds, truncate } from "@/lib/utils";

type SummaryMode = {
  id: string;
  label: string;
  description: string;
  defaultMinutes: number;
};

type Segment = {
  index: number;
  start: number;
  end: number;
  text: string;
};

type Clip = {
  start: number;
  end: number;
  reason: string;
  segmentIndex: number;
};

type RawClip = {
  start_segment: number;
  end_segment: number;
  reason: string;
};

type JobResult = {
  jobId: string;
  sourceType: "upload" | "youtube";
  fullText: string;
  language: string | null;
  duration: number | null;
  segments: Segment[];
  summary: string;
  clips: RawClip[];
  normalizedClips: Clip[];
  videoUrl: string | null;
  youtubeVideoId: string | null;
  youtubeWatchUrl: string | null;
};

type QueueState = "queued" | "starting" | "pending" | "done" | "failed";

type QueueItem = {
  id: string;
  label: string;
  status: QueueState;
  error?: string;
  result?: JobResult;
};

type TimelineClip = Clip & {
  summaryStart: number;
  summaryEnd: number;
};

const STORED_API_KEY = "videosum_api_key";
const DEFAULT_BASE = "";

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function clipThumb(result: JobResult) {
  if (result.sourceType === "youtube" && result.youtubeVideoId) {
    return `https://i.ytimg.com/vi/${result.youtubeVideoId}/hqdefault.jpg`;
  }
  return "";
}

function buildTranscriptText(result: JobResult) {
  return result.segments
    .map(
      (segment) =>
        `#${segment.index} ${formatSeconds(segment.start)} - ${formatSeconds(segment.end)}\n${segment.text}`,
    )
    .join("\n\n");
}

async function loadYouTubeApi() {
  if (window.YT?.Player) {
    return window.YT;
  }
  await new Promise<void>((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return window.YT!;
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORED_API_KEY) || "");
  const [showApiKey, setShowApiKey] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [summaryModes, setSummaryModes] = useState<SummaryMode[]>([]);
  const [selectedMode, setSelectedMode] = useState("key_moments");
  const [transcriptSource, setTranscriptSource] = useState<"captions" | "whisper">("captions");
  const [targetMinutes, setTargetMinutes] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeResult, setActiveResult] = useState<JobResult | null>(null);
  const [transcriptView, setTranscriptView] = useState<"full" | "summary">("full");
  const [youtubeClipIndex, setYoutubeClipIndex] = useState(0);
  const [youtubeStatus, setYoutubeStatus] = useState("");
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceText, setVoiceText] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [currentPlaybackTime, setCurrentPlaybackTime] = useState<number | null>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const playerHostRef = useRef<HTMLDivElement | null>(null);
  const monitorRef = useRef<number | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localMonitorRef = useRef<number | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const transcriptItemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const clipItemRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  useEffect(() => {
    localStorage.setItem(STORED_API_KEY, apiKey);
  }, [apiKey]);

  useEffect(() => {
    void fetch("/api/summary-modes")
      .then((res) => res.json())
      .then((body) => {
        const modes = Array.isArray(body?.modes) ? (body.modes as SummaryMode[]) : [];
        setSummaryModes(modes);
        if (body?.defaultMode) {
          setSelectedMode(body.defaultMode);
        }
      })
      .catch(() => undefined);
  }, []);

  const summarizedSegments = useMemo(() => {
    if (!activeResult) {
      return [];
    }
    return activeResult.segments.filter((segment) =>
      activeResult.normalizedClips.some(
        (clip) => segment.start < clip.end && segment.end > clip.start,
      ),
    );
  }, [activeResult]);

  const timelineClips = useMemo<TimelineClip[]>(() => {
    if (!activeResult) {
      return [];
    }
    let elapsed = 0;
    return activeResult.normalizedClips.map((clip) => {
      const duration = Math.max(0, clip.end - clip.start);
      const timelineClip = {
        ...clip,
        summaryStart: elapsed,
        summaryEnd: elapsed + duration,
      };
      elapsed += duration;
      return timelineClip;
    });
  }, [activeResult]);

  const activeClip = activeResult?.normalizedClips?.[youtubeClipIndex] ?? null;
  const activePlaybackClipIndex = useMemo(() => {
    if (currentPlaybackTime == null) {
      return youtubeClipIndex;
    }
    const index = timelineClips.findIndex(
      (clip) => currentPlaybackTime >= clip.start && currentPlaybackTime < clip.end,
    );
    return index >= 0 ? index : youtubeClipIndex;
  }, [currentPlaybackTime, timelineClips, youtubeClipIndex]);
  const activeSegmentIndex = useMemo(() => {
    if (!activeResult || currentPlaybackTime == null) {
      return null;
    }
    const segment = activeResult.segments.find(
      (item) => currentPlaybackTime >= item.start && currentPlaybackTime < item.end,
    );
    return segment?.index ?? null;
  }, [activeResult, currentPlaybackTime]);

  useEffect(() => {
    if (!activeResult || activeResult.sourceType !== "youtube" || !activeResult.youtubeVideoId) {
      if (monitorRef.current) {
        window.clearInterval(monitorRef.current);
        monitorRef.current = null;
      }
      return;
    }

    let cancelled = false;
    void loadYouTubeApi().then((YT) => {
      if (cancelled || !playerHostRef.current) {
        return;
      }
      const firstClip = activeResult.normalizedClips[0];
      if (!playerRef.current) {
        playerRef.current = new YT.Player("youtube-summary-player", {
          videoId: activeResult.youtubeVideoId!,
          playerVars: {
            controls: 0,
            rel: 0,
            modestbranding: 1,
            iv_load_policy: 3,
          },
          events: {
            onReady: () => {
              playerRef.current?.cueVideoById({
                videoId: activeResult.youtubeVideoId!,
                startSeconds: firstClip?.start ?? 0,
              });
            },
            onStateChange: (event) => {
              if (!window.YT) {
                return;
              }
              if (event.data === window.YT.PlayerState.PLAYING) {
                if (monitorRef.current) {
                  window.clearInterval(monitorRef.current);
                }
                monitorRef.current = window.setInterval(() => {
                  const currentClip = activeResult.normalizedClips[youtubeClipIndex];
                  const currentTime = playerRef.current?.getCurrentTime() ?? 0;
                  setCurrentPlaybackTime(currentTime);
                  if (!currentClip) {
                    return;
                  }
                  if (currentTime >= currentClip.end) {
                    if (youtubeClipIndex < activeResult.normalizedClips.length - 1) {
                      const nextIndex = youtubeClipIndex + 1;
                      setYoutubeClipIndex(nextIndex);
                      const nextClip = activeResult.normalizedClips[nextIndex];
                      setCurrentPlaybackTime(nextClip.start);
                      playerRef.current?.seekTo(nextClip.start, true);
                      playerRef.current?.playVideo();
                      setYoutubeStatus(
                        `Clip ${nextIndex + 1} of ${activeResult.normalizedClips.length} • ${formatSeconds(nextClip.start)} - ${formatSeconds(nextClip.end)}`,
                      );
                    } else {
                      playerRef.current?.pauseVideo();
                      setCurrentPlaybackTime(currentClip.end);
                      setYoutubeStatus("Summary finished.");
                    }
                  }
                }, 250);
              }
              if (
                event.data === window.YT.PlayerState.PAUSED ||
                event.data === window.YT.PlayerState.ENDED
              ) {
                if (monitorRef.current) {
                  window.clearInterval(monitorRef.current);
                  monitorRef.current = null;
                }
              }
            },
          },
        });
      } else {
        playerRef.current.cueVideoById({
          videoId: activeResult.youtubeVideoId!,
          startSeconds: firstClip?.start ?? 0,
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeResult, youtubeClipIndex]);

  useEffect(() => {
    return () => {
      if (monitorRef.current) {
        window.clearInterval(monitorRef.current);
      }
      if (localMonitorRef.current) {
        window.clearInterval(localMonitorRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!activeResult) {
      return;
    }
    setYoutubeClipIndex(0);
    setCurrentPlaybackTime(activeResult.normalizedClips[0]?.start ?? activeResult.segments[0]?.start ?? null);
    if (activeResult.normalizedClips.length > 0) {
      const first = activeResult.normalizedClips[0];
      setYoutubeStatus(
        `Ready to play ${activeResult.normalizedClips.length} summarized clips.`,
      );
      if (activeResult.sourceType === "youtube" && activeResult.youtubeVideoId) {
        playerRef.current?.cueVideoById({
          videoId: activeResult.youtubeVideoId,
          startSeconds: first.start,
        });
      }
      return;
    }
    setYoutubeStatus("");
  }, [activeResult?.jobId]);

  useEffect(() => {
    if (activeSegmentIndex == null) {
      return;
    }
    const key = `${transcriptView}-${activeSegmentIndex}`;
    transcriptItemRefs.current[key]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeSegmentIndex, transcriptView]);

  useEffect(() => {
    clipItemRefs.current[activePlaybackClipIndex]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  }, [activePlaybackClipIndex]);

  function updateQueue(id: string, patch: Partial<QueueItem>) {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function pollJob(jobId: string) {
    while (true) {
      if (cancelRequestedRef.current) {
        throw new Error("Summary canceled.");
      }
      const res = await fetch(`/api/jobs/${jobId}`, {
        signal: submitAbortRef.current?.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || res.statusText || "Polling failed");
      }
      if (body.status === "done" || body.status === "failed") {
        return body as JobResult & { status: "done" | "failed"; error?: string };
      }
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(resolve, 1500);
        submitAbortRef.current?.signal.addEventListener(
          "abort",
          () => {
            window.clearTimeout(timeout);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
  }

  async function runUpload(file: File, queueId: string) {
    updateQueue(queueId, { status: "starting" });
    const data = new FormData();
    data.append("video", file);
    data.append("mode", selectedMode);
    data.append("apiKey", apiKey.trim());
    if (targetMinutes.trim()) {
      data.append("targetMinutes", targetMinutes.trim());
    }
    const res = await fetch(`${DEFAULT_BASE}/api/jobs`, {
      method: "POST",
      body: data,
      signal: submitAbortRef.current?.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || "Upload failed");
    }
    updateQueue(queueId, { status: "pending" });
    const final = await pollJob(body.jobId);
    if (final.status === "failed") {
      updateQueue(queueId, { status: "failed", error: final.error || "Unknown error" });
      return;
    }
    updateQueue(queueId, { status: "done", result: final });
    setActiveResult((current) => current ?? final);
  }

  async function runYoutube(queueId: string, url: string) {
    updateQueue(queueId, { status: "starting" });
    const payload: Record<string, string> = {
      url,
      mode: selectedMode,
      apiKey: apiKey.trim(),
      transcriptSource,
    };
    if (targetMinutes.trim()) {
      payload.targetMinutes = targetMinutes.trim();
    }
    const res = await fetch(`${DEFAULT_BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: submitAbortRef.current?.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || "URL submission failed");
    }
    updateQueue(queueId, { status: "pending" });
    const final = await pollJob(body.jobId);
    if (final.status === "failed") {
      updateQueue(queueId, { status: "failed", error: final.error || "Unknown error" });
      return;
    }
    updateQueue(queueId, { status: "done", result: final });
    setActiveResult((current) => current ?? final);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    cancelRequestedRef.current = false;
    submitAbortRef.current?.abort();
    submitAbortRef.current = new AbortController();

    if (!selectedFiles.length && !youtubeUrl.trim()) {
      setError("Choose at least one video file or paste a YouTube URL.");
      return;
    }
    if (selectedFiles.length && youtubeUrl.trim()) {
      setError("Use either uploaded files or a YouTube URL, not both.");
      return;
    }
    if (!apiKey.trim()) {
      setShowApiKeyModal(true);
      return;
    }

    setIsSubmitting(true);
    setActiveResult(null);
    const nextQueue: QueueItem[] = selectedFiles.length
      ? selectedFiles.map((file) => ({
          id: makeId(),
          label: file.name,
          status: "queued",
        }))
      : [
          {
            id: makeId(),
            label: youtubeUrl.trim(),
            status: "queued",
          },
        ];

    setQueue(nextQueue);

    try {
      if (selectedFiles.length) {
        await Promise.all(
          selectedFiles.map((file, index) =>
            runUpload(file, nextQueue[index].id).catch((err: Error) => {
              if (cancelRequestedRef.current || err.name === "AbortError") {
                updateQueue(nextQueue[index].id, {
                  status: "failed",
                  error: "Canceled",
                });
                return;
              }
              updateQueue(nextQueue[index].id, {
                status: "failed",
                error: err.message,
              });
            }),
          ),
        );
      } else {
        await runYoutube(nextQueue[0].id, youtubeUrl.trim()).catch((err: Error) => {
          if (cancelRequestedRef.current || err.name === "AbortError") {
            updateQueue(nextQueue[0].id, { status: "failed", error: "Canceled" });
            return;
          }
          updateQueue(nextQueue[0].id, { status: "failed", error: err.message });
        });
      }
    } finally {
      submitAbortRef.current = null;
      setIsSubmitting(false);
    }
  }

  function cancelSummary() {
    cancelRequestedRef.current = true;
    submitAbortRef.current?.abort();
    if (monitorRef.current) {
      window.clearInterval(monitorRef.current);
      monitorRef.current = null;
    }
    if (localMonitorRef.current) {
      window.clearInterval(localMonitorRef.current);
      localMonitorRef.current = null;
    }
    setIsSubmitting(false);
    setQueue((prev) =>
      prev.map((item) =>
        item.status === "queued" || item.status === "starting" || item.status === "pending"
          ? { ...item, status: "failed", error: "Canceled" }
          : item,
      ),
    );
  }

  function resetForNewSummary() {
    setActiveResult(null);
    setQueue([]);
    setError("");
    setYoutubeClipIndex(0);
    setYoutubeStatus("");
    setSelectedFiles([]);
    setYoutubeUrl("");
  }

  function downloadTranscript() {
    if (!activeResult) {
      return;
    }
    const blob = new Blob([`${buildTranscriptText(activeResult)}\n`], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "transcription.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function findClipIndexForTime(time: number) {
    if (!timelineClips.length) {
      return -1;
    }
    return timelineClips.findIndex(
      (clip) => time >= clip.start && time < clip.end,
    );
  }

  function sourceTimeToSummaryTime(sourceTime: number) {
    const clipIndex = findClipIndexForTime(sourceTime);
    if (clipIndex < 0) {
      return null;
    }
    const clip = timelineClips[clipIndex];
    return clip.summaryStart + Math.max(0, sourceTime - clip.start);
  }

  function summaryTimeToSourceTime(summaryTime: number) {
    const clip = timelineClips.find(
      (item) => summaryTime >= item.summaryStart && summaryTime < item.summaryEnd,
    );
    if (!clip) {
      const lastClip = timelineClips.at(-1);
      return lastClip ? lastClip.end : summaryTime;
    }
    return clip.start + Math.max(0, summaryTime - clip.summaryStart);
  }

  function playYoutubeSummary(index = youtubeClipIndex, startTime?: number) {
    if (!activeResult || activeResult.sourceType !== "youtube") {
      return;
    }
    const clip = activeResult.normalizedClips[index];
    if (!clip) {
      return;
    }
    const seekTime = startTime ?? clip.start;
    setYoutubeClipIndex(index);
    setCurrentPlaybackTime(seekTime);
    playerRef.current?.seekTo(seekTime, true);
    playerRef.current?.playVideo();
    setYoutubeStatus(
      `Clip ${index + 1} of ${activeResult.normalizedClips.length} • ${formatSeconds(clip.start)} - ${formatSeconds(clip.end)}`,
    );
  }

  function playLocalSummary(index = youtubeClipIndex, startTime?: number) {
    if (!activeResult || activeResult.sourceType === "youtube") {
      return;
    }
    const clip = timelineClips[index];
    const video = localVideoRef.current;
    if (!clip || !video) {
      return;
    }
    if (localMonitorRef.current) {
      window.clearInterval(localMonitorRef.current);
      localMonitorRef.current = null;
    }
    setYoutubeClipIndex(index);
    const sourceSeekTime = startTime ?? clip.start;
    const summarySeekTime = sourceTimeToSummaryTime(sourceSeekTime) ?? clip.summaryStart;
    setCurrentPlaybackTime(sourceSeekTime);
    video.currentTime = summarySeekTime;
    void video.play();
    setYoutubeStatus(
      `Clip ${index + 1} of ${activeResult.normalizedClips.length} • ${formatSeconds(clip.start)} - ${formatSeconds(clip.end)}`,
    );
    localMonitorRef.current = window.setInterval(() => {
      const sourceTime = summaryTimeToSourceTime(video.currentTime);
      setCurrentPlaybackTime(sourceTime);
      if (video.currentTime >= clip.summaryEnd) {
        if (localMonitorRef.current) {
          window.clearInterval(localMonitorRef.current);
          localMonitorRef.current = null;
        }
        setCurrentPlaybackTime(clip.end);
        video.pause();
      }
    }, 200);
  }

  function playSummaryClip(index = youtubeClipIndex, startTime?: number) {
    if (!activeResult) {
      return;
    }
    if (activeResult.sourceType === "youtube") {
      playYoutubeSummary(index, startTime);
      return;
    }
    playLocalSummary(index, startTime);
  }

  function jumpToTranscriptSegment(segment: Segment) {
    if (!activeResult) {
      return;
    }
    const clipIndex = findClipIndexForTime(segment.start);
    if (clipIndex >= 0) {
      playSummaryClip(clipIndex, segment.start);
      return;
    }

    setCurrentPlaybackTime(segment.start);
    if (activeResult.sourceType === "youtube") {
      playerRef.current?.seekTo(segment.start, true);
      playerRef.current?.playVideo();
    } else if (localVideoRef.current) {
      if (localMonitorRef.current) {
        window.clearInterval(localMonitorRef.current);
        localMonitorRef.current = null;
      }
      const summarySeekTime = sourceTimeToSummaryTime(segment.start);
      if (summarySeekTime == null) {
        return;
      }
      localVideoRef.current.currentTime = summarySeekTime;
      void localVideoRef.current.play();
    }
    setYoutubeStatus(`Transcript jump • ${formatSeconds(segment.start)} - ${formatSeconds(segment.end)}`);
  }

  function handleSlider(value: number) {
    if (!activeResult || activeResult.normalizedClips.length < 2) {
      return;
    }
    const index = Math.round((value / 100) * (activeResult.normalizedClips.length - 1));
    setYoutubeClipIndex(index);
  }

  const sliderValue = activeResult?.normalizedClips?.length
    ? activeResult.normalizedClips.length === 1
      ? 100
      : Math.round((youtubeClipIndex / (activeResult.normalizedClips.length - 1)) * 100)
    : 0;
  const isYoutubeMode = !selectedFiles.length && youtubeUrl.trim().length > 0;

  function pickVoiceMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const t of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return "";
  }

  async function startVoiceRecord() {
    setVoiceError("");
    setVoiceText("");
    if (!apiKey.trim()) {
      setShowApiKeyModal(true);
      setVoiceError("Enter your OpenAI API key in the dialog, then Save Key.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;
      const mime = pickVoiceMimeType();
      const mr = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      voiceRecorderRef.current = mr;
      voiceChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size) {
          voiceChunksRef.current.push(e.data);
        }
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        voiceStreamRef.current = null;
        voiceRecorderRef.current = null;
        const blob = new Blob(voiceChunksRef.current, { type: mr.mimeType || "audio/webm" });
        voiceChunksRef.current = [];
        void (async () => {
          setVoiceBusy(true);
          setVoiceError("");
          try {
            const ext = blob.type.includes("webm")
              ? ".webm"
              : blob.type.includes("mp4")
                ? ".mp4"
                : ".webm";
            const fd = new FormData();
            fd.append("audio", blob, `rec${ext}`);
            const res = await fetch("/api/voice-transcribe", {
              method: "POST",
              headers: { "X-Api-Key": apiKey.trim() },
              body: fd,
            });
            const body = (await res.json()) as { text?: string; error?: string };
            if (!res.ok) {
              throw new Error(body.error || "Transcription failed");
            }
            setVoiceText(body.text || "");
          } catch (err) {
            setVoiceError(err instanceof Error ? err.message : "Failed");
          } finally {
            setVoiceBusy(false);
          }
        })();
      };
      mr.start();
      setVoiceRecording(true);
    } catch (err) {
      setVoiceError(err instanceof Error ? err.message : "Microphone error");
    }
  }

  function stopVoiceRecord() {
    const mr = voiceRecorderRef.current;
    if (mr && voiceRecording) {
      mr.stop();
      setVoiceRecording(false);
    }
  }

  function renderTranscriptSegment(segment: Segment, view: "full" | "summary") {
    const isActive = activeSegmentIndex === segment.index;
    return (
      <button
        key={`${view}-${segment.index}`}
        ref={(element) => {
          transcriptItemRefs.current[`${view}-${segment.index}`] = element;
        }}
        type="button"
        onClick={() => jumpToTranscriptSegment(segment)}
        className={cn(
          "w-full rounded-[16px] border px-4 py-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition",
          isActive
            ? "border-[#5f9cff] bg-[linear-gradient(180deg,rgba(40,55,84,0.98),rgba(28,37,55,0.96))] shadow-[0_0_0_1px_rgba(92,157,255,0.45),0_16px_36px_rgba(27,75,167,0.2)]"
            : "border-white/8 bg-[linear-gradient(180deg,rgba(34,40,52,0.96),rgba(24,29,38,0.95))] hover:border-[#4b80d9]/45 hover:bg-[linear-gradient(180deg,rgba(36,43,58,0.98),rgba(27,32,42,0.96))]",
        )}
      >
        <div className={cn("text-[14px]", isActive ? "text-[#8cbbff]" : "text-[#6da6ff]")}>
          #{segment.index} • {formatSeconds(segment.start)} - {formatSeconds(segment.end)}
        </div>
        <div className="mt-1 text-[16px] leading-snug text-slate-100">{segment.text}</div>
      </button>
    );
  }

  return (
    <div className="app-shell">
      <div className="mesh-bg" />
      <header className="topbar">
        <div className="mx-auto flex max-w-[1520px] flex-wrap items-center justify-between gap-3 px-8 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-[14px] bg-[linear-gradient(180deg,#559eff_0%,#2f6ff0_100%)] text-[23px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.24),0_10px_22px_rgba(34,95,226,0.28)]">
              V
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-[34px] leading-none tracking-[-0.05em] text-white">
                VideoSum
              </h1>
              <p className="mt-0.5 max-w-[980px] text-[14px] leading-snug text-slate-300">
                AI video summarizer — key moments, trailers, highlights, action items, chapters and more.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="shrink-0 gap-2"
            onClick={() => setShowApiKeyModal(true)}
          >
            <KeyRound className="size-4" />
            OpenAI API key
          </Button>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1520px] flex-col gap-4 px-8 pb-12 pt-5">
        {!activeResult && (
          <>
          <Card>
            <CardHeader>
              <h2 className="font-display text-[32px] leading-none tracking-[-0.05em] text-white">
                Upload &amp; Run
              </h2>
            </CardHeader>
            <CardContent>
              <form className="space-y-8" onSubmit={onSubmit}>
                <div className="grid gap-5 lg:grid-cols-[1.05fr_1fr]">
                  <label className="relative flex min-h-[180px] cursor-pointer flex-col items-center justify-center rounded-[24px] border border-dashed border-[#5290f5] bg-[linear-gradient(180deg,rgba(31,46,80,0.65),rgba(28,41,65,0.58))] px-7 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_0_0_1px_rgba(82,144,245,0.12)]">
                    <input
                      type="file"
                      accept="video/*"
                      multiple
                      className="absolute inset-0 opacity-0"
                      onChange={(event) => {
                        const files = Array.from(event.target.files || []);
                        setSelectedFiles(files);
                        if (files.length) {
                          setYoutubeUrl("");
                        }
                      }}
                    />
                    <UploadCloud className="mb-4 size-11 text-slate-200" strokeWidth={1.7} />
                    <p className="max-w-[420px] text-[23px] leading-snug text-slate-100">
                      Drop videos here or click to browse — select several files to queue them
                    </p>
                    <p className="mt-4 text-[18px] text-[#5da0ff]">
                      {selectedFiles.length
                        ? selectedFiles.length === 1
                          ? selectedFiles[0].name
                          : `${selectedFiles.length} files selected`
                        : "No files selected"}
                    </p>
                  </label>

                  <div className="space-y-3 rounded-[24px] border border-white/6 bg-black/10 px-5 py-5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-300">
                      YouTube URL
                    </p>
                    <Input
                      value={youtubeUrl}
                      onChange={(event) => {
                        setYoutubeUrl(event.target.value);
                        if (event.target.value.trim()) {
                          setSelectedFiles([]);
                        }
                      }}
                      placeholder="https://www.youtube.com/watch?v=..."
                      className="h-11 text-[15px]"
                    />
                    <p className="max-w-[460px] text-[16px] leading-relaxed text-slate-300">
                      Paste a YouTube watch or Shorts link to summarize without uploading a local file.
                    </p>
                  </div>
                </div>

                <div className="grid gap-5 lg:grid-cols-[1.85fr_0.9fr_auto] lg:items-start">
                  {isYoutubeMode ? (
                    <div className="space-y-3 lg:col-span-3">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">
                        Transcript Source
                      </label>
                      <div className="rounded-[22px] border border-white/8 bg-black/10 px-5 py-4">
                        <label className="flex cursor-pointer items-start gap-3 py-1 text-slate-100">
                          <input
                            type="radio"
                            name="transcriptSource"
                            value="captions"
                            checked={transcriptSource === "captions"}
                            onChange={() => setTranscriptSource("captions")}
                            className="mt-1 size-5 accent-[#2f75ff]"
                          />
                          <span className="text-[15px] leading-snug">
                            YouTube captions (fast, uses site subtitles)
                          </span>
                        </label>
                        <label className="mt-3 flex cursor-pointer items-start gap-3 py-1 text-slate-100">
                          <input
                            type="radio"
                            name="transcriptSource"
                            value="whisper"
                            checked={transcriptSource === "whisper"}
                            onChange={() => setTranscriptSource("whisper")}
                            className="mt-1 size-5 accent-[#2f75ff]"
                          />
                          <span className="text-[15px] leading-snug">
                            Whisper (download + transcribe; can produce a summary video)
                          </span>
                        </label>
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-3">
                    <label className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">
                      Summarization Type
                    </label>
                    <select
                      value={selectedMode}
                      onChange={(event) => setSelectedMode(event.target.value)}
                      className="h-11 w-full rounded-[18px] border border-white/10 bg-[linear-gradient(180deg,rgba(55,67,91,0.52),rgba(40,49,66,0.72))] px-4 text-[15px] text-slate-100 outline-none focus:border-[#4f93ff] focus:ring-4 focus:ring-[#2f75ff]/20"
                    >
                      {summaryModes.map((mode) => (
                        <option key={mode.id} value={mode.id}>
                          {mode.label} — {mode.description}
                        </option>
                      ))}
                    </select>
                    <p className="text-[14px] leading-relaxed text-slate-400">
                      Same list as the browser extension. Each mode has its own default length unless you set target minutes below.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <label className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">
                      Target Duration (mins)
                    </label>
                    <Input
                      type="number"
                      min="0.5"
                      max="120"
                      step="0.5"
                      value={targetMinutes}
                      onChange={(event) => setTargetMinutes(event.target.value)}
                      placeholder="Auto"
                      className="h-11 text-[15px]"
                    />
                    <p className="text-[14px] leading-relaxed text-slate-400">
                      Empty = use each mode&apos;s default.
                    </p>
                  </div>

                  <div className="flex h-full items-end">
                    <Button
                      type={isSubmitting ? "button" : "submit"}
                      variant={isSubmitting ? "secondary" : "default"}
                      className="min-w-[220px]"
                      onClick={isSubmitting ? cancelSummary : undefined}
                    >
                      {isSubmitting ? "Cancel" : "Generate Summary"}
                    </Button>
                  </div>
                </div>

                {error ? (
                  <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-[14px] text-rose-200">
                    {error}
                  </div>
                ) : null}

                {isSubmitting ? (
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3 text-[14px] text-slate-300">
                    <div className="flex items-center gap-3">
                      <LoaderCircle className="size-5 animate-spin text-[#67a7ff]" />
                      <span>Extracting audio, transcribing, summarizing, rendering... this can take several minutes.</span>
                    </div>
                    <Button type="button" variant="secondary" size="sm" onClick={cancelSummary}>
                      Cancel
                    </Button>
                  </div>
                ) : null}

                {queue.length ? (
                  <div className="space-y-3 border-t border-white/10 pt-5">
                    <h3 className="font-display text-[22px] tracking-[-0.03em] text-white">Queue</h3>
                    <div className="space-y-3">
                      {queue.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={cn(
                            "flex w-full flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-left transition",
                            item.status === "done"
                              ? "cursor-pointer border-[#4e87ef]/40 bg-[#2357b8]/10 hover:bg-[#2357b8]/16"
                              : "border-white/8 bg-white/[0.03]",
                          )}
                          onClick={() => {
                            if (item.result) {
                              setActiveResult(item.result);
                            }
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate text-[14px] text-slate-100">{item.label}</span>
                          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
                            {item.status}
                          </span>
                          {item.error ? (
                            <span className="w-full text-[13px] text-rose-300">{item.error}</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <h2 className="font-display text-[26px] leading-none tracking-[-0.05em] text-white">
                Voice → transcript (temporary)
              </h2>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-[14px] text-slate-400">
                Step 1: click <span className="text-slate-200">OpenAI API key</span> and save. Step 2:{" "}
                <span className="text-slate-200">Record</span>, then <span className="text-slate-200">Stop &amp; transcribe</span>
                . Key stays in this browser only.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full gap-2 sm:w-auto sm:min-w-[220px]"
                  onClick={() => setShowApiKeyModal(true)}
                >
                  <KeyRound className="size-4" />
                  OpenAI API key
                </Button>
                <Button
                  type="button"
                  variant={voiceRecording ? "secondary" : "default"}
                  disabled={voiceBusy || voiceRecording}
                  onClick={() => void startVoiceRecord()}
                  className="gap-2"
                >
                  <Mic className="size-4" />
                  Record
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!voiceRecording || voiceBusy}
                  onClick={stopVoiceRecord}
                >
                  Stop &amp; transcribe
                </Button>
                {voiceBusy ? (
                  <span className="flex items-center gap-2 text-[14px] text-slate-300">
                    <LoaderCircle className="size-4 animate-spin" />
                    Transcribing…
                  </span>
                ) : null}
                {voiceRecording ? (
                  <span className="text-[14px] text-rose-300">Recording…</span>
                ) : null}
              </div>
              {voiceError ? (
                <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-[14px] text-rose-200">
                  {voiceError}
                </div>
              ) : null}
              {voiceText ? (
                <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-[15px] leading-relaxed text-slate-100">
                  {voiceText}
                </div>
              ) : null}
            </CardContent>
          </Card>
          </>
        )}

        {activeResult ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <p className="text-[14px] text-slate-400">Desktop website</p>
                <h2 className="font-display text-[34px] tracking-[-0.05em] text-white">
                  VideoSum Results Redesign
                </h2>
              </div>
              <Button variant="secondary" onClick={resetForNewSummary} className="shrink-0 self-start px-6">
                Summarize New Video
              </Button>
            </div>

            <div className="flex flex-wrap gap-3">
              {[
                activeResult.language ? `Language: ${activeResult.language}` : null,
                activeResult.duration != null ? `Duration: ${formatSeconds(activeResult.duration)}` : null,
                activeResult.fullText ? `Chars: ${activeResult.fullText.length}` : null,
                activeResult.sourceType === "youtube" && activeResult.youtubeWatchUrl ? "Source: YouTube" : null,
              ]
                .filter(Boolean)
                .map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-[12px] text-slate-300"
                  >
                    {item}
                  </span>
                ))}
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.14fr)]">
              <Card className="min-w-0">
                <CardHeader className="flex items-center justify-between px-5 pt-5">
                  <h3 className="font-display text-[22px] tracking-[-0.04em] text-white">Transcript</h3>
                  <div className="flex items-center gap-3">
                    <Button variant="ghost" size="sm" onClick={downloadTranscript}>
                      Download transcript
                    </Button>
                    <div className="flex items-center gap-3 text-[14px] text-slate-200">
                    <span className={cn(transcriptView === "full" ? "text-white" : "text-slate-400")}>Full</span>
                    <Switch
                      checked={transcriptView === "summary"}
                      onCheckedChange={(checked) => setTranscriptView(checked ? "summary" : "full")}
                    />
                    <span className={cn(transcriptView === "summary" ? "text-white" : "text-slate-400")}>Summarized</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-4 pt-3">
                  <Tabs value={transcriptView} onValueChange={(value) => setTranscriptView(value as "full" | "summary")}>
                    <TabsContent value="full">
                      <ScrollArea className="h-[560px] rounded-[18px] border border-white/8 bg-black/10 pr-3">
                        <div className="space-y-3 p-3">
                          {activeResult.segments.map((segment) => renderTranscriptSegment(segment, "full"))}
                        </div>
                      </ScrollArea>
                    </TabsContent>
                    <TabsContent value="summary">
                      <ScrollArea className="h-[560px] rounded-[18px] border border-white/8 bg-black/10 pr-3">
                        <div className="space-y-3 p-3">
                          {summarizedSegments.map((segment) => renderTranscriptSegment(segment, "summary"))}
                        </div>
                      </ScrollArea>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>

              <div className="min-w-0 space-y-4">
                <Card className="min-w-0 overflow-hidden">
                  <CardHeader>
                    <h3 className="font-display text-[22px] tracking-[-0.04em] text-white">Summary</h3>
                  </CardHeader>
                  <CardContent className="min-w-0 space-y-4 pt-3">
                    <div className="relative w-full max-w-full overflow-hidden rounded-[18px] border border-white/8 bg-black">
                      <span className="absolute left-3 top-3 z-10 rounded-xl border border-white/8 bg-[#252c36]/85 px-2.5 py-1 text-[12px] text-white">
                        Summary Video
                      </span>
                      {activeResult.sourceType === "youtube" && activeResult.youtubeVideoId ? (
                        <div id="youtube-summary-player" ref={playerHostRef} className="aspect-[16/8.4] w-full max-w-full" />
                      ) : (
                        <video
                          ref={localVideoRef}
                          src={activeResult.videoUrl || undefined}
                          controls
                          onTimeUpdate={(event) =>
                            setCurrentPlaybackTime(
                              summaryTimeToSourceTime(event.currentTarget.currentTime),
                            )
                          }
                          className="aspect-[16/8.4] w-full max-w-full object-cover"
                        />
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant={activeResult.sourceType === "youtube" ? "default" : "secondary"}
                        className="min-w-[136px]"
                        onClick={() => {
                          playSummaryClip(activePlaybackClipIndex);
                        }}
                      >
                        <Play className="mr-2 size-4 fill-current" /> Play Summary
                      </Button>
                      <Button
                        variant="secondary"
                        className="min-w-[112px]"
                        onClick={() => {
                          const next = Math.min(
                            activePlaybackClipIndex + 1,
                            activeResult.normalizedClips.length - 1,
                          );
                          setYoutubeClipIndex(next);
                          playSummaryClip(next);
                        }}
                        disabled={activePlaybackClipIndex >= activeResult.normalizedClips.length - 1}
                      >
                        <SkipForward className="mr-2 size-4" /> Next Clip
                      </Button>
                      <div className="min-w-[220px] flex-1">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={sliderValue}
                          onChange={(event) => handleSlider(Number(event.target.value))}
                          className="summary-range"
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h3 className="font-display text-[22px] tracking-[-0.04em] text-white">Selected Clips</h3>
                    </div>
                    <div className="w-full max-w-full overflow-x-auto pb-2">
                      <div className="flex w-max min-w-full gap-4">
                      {activeResult.clips.map((clip, index) => {
                        const normalized = activeResult.normalizedClips[index];
                        const image = clipThumb(activeResult);
                        return (
                          <button
                            key={`${clip.start_segment}-${clip.end_segment}-${index}`}
                            ref={(element) => {
                              clipItemRefs.current[index] = element;
                            }}
                            type="button"
                            onClick={() => {
                              playSummaryClip(index);
                            }}
                            className={cn(
                              "group flex w-[252px] min-w-[252px] flex-col rounded-[16px] p-0 text-left align-top transition",
                              index === activePlaybackClipIndex ? "scale-[1.01]" : "",
                            )}
                          >
                            <div
                              className={cn(
                                "relative overflow-hidden rounded-[14px] border border-white/10",
                                index === activePlaybackClipIndex
                                  ? "shadow-[0_0_0_2px_rgba(92,157,255,0.88),0_18px_34px_rgba(31,84,181,0.28)]"
                                  : "",
                              )}
                            >
                              {image ? (
                                <img src={image} alt="" className="aspect-video w-full object-cover" />
                              ) : (
                                <div className="clip-placeholder aspect-video w-full" />
                              )}
                              <div className="absolute left-2.5 top-2.5 rounded-2xl border border-white/10 bg-[#252c36]/86 px-2.5 py-1 text-[12px] text-white">
                                Clip {index + 1}
                              </div>
                            </div>
                            <div className="mt-3 flex min-h-[124px] flex-col px-1">
                              <p className="text-[15px] font-semibold leading-snug text-slate-100">
                                {truncate(clip.reason || `Clip ${index + 1}`, 46)}
                              </p>
                              {normalized ? (
                                <p className="mt-auto pt-2 text-[13px] text-slate-400">
                                  {formatSeconds(normalized.start)} - {formatSeconds(normalized.end)}
                                </p>
                              ) : null}
                            </div>
                          </button>
                        );
                      })}
                      </div>
                    </div>

                    {youtubeStatus ? (
                      <p className="text-[13px] text-slate-400">{youtubeStatus}</p>
                    ) : null}

                    {activeResult.videoUrl ? (
                      <a
                        className="inline-flex w-fit rounded-full border border-[#67a7ff]/35 bg-[#2f75ff]/12 px-4 py-2 text-[14px] font-semibold text-[#7fb2ff]"
                        href={activeResult.videoUrl}
                        download
                      >
                        Download summary video
                      </a>
                    ) : null}

                    <p className="pt-0.5 text-[16px] leading-7 text-slate-100">{activeResult.summary}</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        ) : null}
      </main>

      {showApiKeyModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
          <div className="w-full max-w-[460px] rounded-[24px] border border-[#326ad4]/75 bg-[linear-gradient(180deg,rgba(33,42,57,0.98),rgba(21,28,39,0.99))] p-6 shadow-[0_24px_64px_rgba(0,0,0,0.5),0_0_40px_rgba(44,104,230,0.16)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-[28px] leading-none tracking-[-0.05em] text-white">
                  OpenAI API Key
                </h3>
                <p className="mt-2 text-[15px] leading-relaxed text-slate-300">
                  Enter your key to start summarizing. It stays in your browser only.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowApiKeyModal(false)}
                className="rounded-full border border-white/10 px-3 py-1.5 text-[13px] text-slate-300 hover:bg-white/[0.05]"
              >
                Close
              </button>
            </div>

            <div className="mt-6 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300">
                  API Key
                </label>
                <div className="flex items-center gap-2 text-[14px] text-slate-200">
                  <Switch checked={showApiKey} onCheckedChange={setShowApiKey} />
                  <span>Show</span>
                </div>
              </div>
              <Input
                autoFocus
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                className="h-11 text-[15px]"
              />
              <p className="text-[14px] leading-relaxed text-slate-400">
                Get one at{" "}
                <a className="text-[#67a7ff]" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
                  platform.openai.com
                </a>
                .
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <Button type="button" variant="secondary" onClick={() => setShowApiKeyModal(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!apiKey.trim()) {
                    setError("Enter your OpenAI API key.");
                    return;
                  }
                  setError("");
                  setShowApiKeyModal(false);
                }}
              >
                Save Key
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
