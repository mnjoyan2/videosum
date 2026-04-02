const STORAGE_KEY = "videosumState";

const defaultState = () => ({
  baseUrl: "https://videosum-production-4f3c.up.railway.app",
  targetMinutes: "",
  apiKey: "",
  transcriptSource: "captions",
  queue: [],
});

function normalizeBaseUrl(url) {
  const u = String(url || "").trim();
  if (!u) {
    return "http://127.0.0.1:3847";
  }
  return u.replace(/\/+$/, "");
}

async function loadState() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const prev = raw[STORAGE_KEY] || {};
  return {
    ...defaultState(),
    ...prev,
    queue: Array.isArray(prev.queue) ? prev.queue : [],
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function collectYoutubeCookiesNetscape() {
  const seen = new Set();
  const merged = [];
  for (const url of [
    "https://www.youtube.com",
    "https://m.youtube.com",
    "https://www.google.com",
  ]) {
    let part;
    try {
      part = await chrome.cookies.getAll({ url });
    } catch {
      part = [];
    }
    for (const c of part) {
      const key = `${c.domain}|${c.name}|${c.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(c);
    }
  }
  if (merged.length === 0) {
    return "";
  }
  const header =
    "# Netscape HTTP Cookie File\n# https://curl.haxx.se/rfc/cookie_spec.html\n\n";
  const lines = merged.map((c) => {
    const domain = c.domain || "";
    const includeSub = !c.hostOnly ? "TRUE" : "FALSE";
    const pth = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    const val = String(c.value).replace(/\r?\n|\r/g, "");
    return `${domain}\t${includeSub}\t${pth}\t${secure}\t${exp}\t${c.name}\t${val}`;
  });
  return header + lines.join("\n");
}

let pollTimer = null;
let submitChain = Promise.resolve();

function scheduleSubmitQueued() {
  submitChain = submitChain.catch(() => {}).then(() => submitQueued());
  return submitChain;
}

async function tickPoll() {
  const state = await loadState();
  const active = state.queue.filter((q) => q.state === "processing");
  if (active.length === 0) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    return;
  }
  const baseUrl = normalizeBaseUrl(state.baseUrl);
  let changed = false;
  for (const item of active) {
    if (!item.serverJobId) {
      continue;
    }
    try {
      const res = await fetch(`${baseUrl}/api/jobs/${item.serverJobId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        continue;
      }
      if (data.status === "done") {
        item.state = "done";
        const fromApi = data.videoUrl && String(data.videoUrl).trim();
        if (fromApi) {
          item.videoUrl = data.videoUrl;
        } else if (item.transcriptSource === "whisper") {
          item.videoUrl = `/api/jobs/${item.serverJobId}/summary-video.mp4`;
        } else {
          item.videoUrl = null;
        }
        changed = true;
      } else if (data.status === "failed") {
        item.state = "failed";
        item.error = data.error || "Failed";
        changed = true;
      }
    } catch (_) {}
  }
  if (changed) {
    await saveState(state);
  }
}

function ensurePolling() {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(() => {
    void tickPoll();
  }, 2000);
  void tickPoll();
}

async function submitQueued() {
  const state = await loadState();
  const baseUrl = normalizeBaseUrl(state.baseUrl);
  const todo = state.queue.filter((q) => q.state === "queued");
  if (todo.length === 0) {
    return { started: 0 };
  }
  ensurePolling();
  await Promise.all(
    todo.map(async (item) => {
      try {
        let youtubeCookies = "";
        try {
          youtubeCookies = await collectYoutubeCookiesNetscape();
        } catch {
          youtubeCookies = "";
        }
        const res = await fetch(`${baseUrl}/api/jobs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(state.apiKey ? { "X-Api-Key": state.apiKey } : {}),
          },
          body: JSON.stringify({
            url: item.url,
            targetMinutes:
              state.targetMinutes !== "" ? state.targetMinutes : undefined,
            mode: item.mode || "key_moments",
            transcriptSource:
              item.transcriptSource || state.transcriptSource || "captions",
            ...(youtubeCookies ? { youtubeCookies } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          item.state = "failed";
          item.error = data.error || res.statusText || String(res.status);
          return;
        }
        item.serverJobId = data.jobId;
        item.state = "processing";
      } catch (e) {
        item.state = "failed";
        item.error = e.message || "Network error";
      }
    }),
  );
  await saveState(state);
  ensurePolling();
  return { started: todo.length };
}

async function addToQueue({
  url,
  title,
  mode,
  transcriptSource: transcriptSourceArg,
}) {
  const state = await loadState();
  const canonical = String(url).trim();
  if (!canonical) {
    return { ok: false, error: "Missing URL" };
  }
  if (!String(state.apiKey || "").trim()) {
    return {
      ok: false,
      error: "Please add your OpenAI API key in Videosum",
    };
  }
  const ts = String(
    transcriptSourceArg ?? state.transcriptSource ?? "captions",
  );
  const transcriptSource = ts === "whisper" ? "whisper" : "captions";
  if (
    state.queue.some(
      (q) =>
        q.url === canonical &&
        (q.transcriptSource || "captions") === transcriptSource,
    )
  ) {
    return { ok: true, duplicate: true };
  }
  const id = crypto.randomUUID();
  state.queue.push({
    id,
    url: canonical,
    title: String(title || "Video").slice(0, 500),
    mode: mode || "key_moments",
    transcriptSource,
    state: "queued",
    serverJobId: null,
    error: null,
    videoUrl: null,
  });
  await saveState(state);
  await scheduleSubmitQueued();
  return { ok: true, id };
}

async function removeFromQueue(id) {
  const state = await loadState();
  state.queue = state.queue.filter((q) => q.id !== id);
  await saveState(state);
}

async function startAll() {
  await scheduleSubmitQueued();
  return { ok: true };
}

async function openVideosumUi() {
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html"),
      type: "popup",
      width: 420,
      height: 620,
      focused: true,
    });
  } catch (_) {}
}

chrome.action.onClicked.addListener((tab) => {
  const u = tab?.url || "";
  if (/^https:\/\/(www\.|m\.)?youtube\.com\//.test(u)) {
    chrome.tabs.sendMessage(tab.id, { type: "VIDEOSUM_OPEN_SIDEBAR" }, () => {
      void chrome.runtime.lastError;
    });
    return;
  }
  void openVideosumUi();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OPEN_VIDEOSUM_UI") {
    void openVideosumUi().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "ADD_TO_QUEUE") {
    void addToQueue(msg.payload || {}).then(sendResponse);
    return true;
  }
  if (msg?.type === "START_ALL") {
    void startAll().then(sendResponse);
    return true;
  }
  if (msg?.type === "GET_STATE") {
    void loadState().then((s) => sendResponse(s));
    return true;
  }
  if (msg?.type === "REMOVE_ITEM") {
    void removeFromQueue(msg.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "SET_SETTINGS") {
    void (async () => {
      const state = await loadState();
      if (msg.baseUrl != null) {
        state.baseUrl = normalizeBaseUrl(msg.baseUrl);
      }
      if (msg.apiKey != null) {
        state.apiKey = String(msg.apiKey).trim();
      }
      if (msg.targetMinutes != null) {
        const raw = String(msg.targetMinutes).trim();
        state.targetMinutes =
          raw === ""
            ? ""
            : Number.isFinite(Number(raw)) && Number(raw) > 0
              ? Number(raw)
              : state.targetMinutes;
      }
      if (msg.transcriptSource != null) {
        const t = String(msg.transcriptSource).trim().toLowerCase();
        state.transcriptSource = t === "whisper" ? "whisper" : "captions";
      }
      await saveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === "CLEAR_DONE") {
    void (async () => {
      const state = await loadState();
      state.queue = state.queue.filter((q) => q.state !== "done");
      await saveState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }
  return undefined;
});

void loadState().then(async (s) => {
  if (s.queue.some((q) => q.state === "processing")) {
    ensurePolling();
  }
  if (s.queue.some((q) => q.state === "queued")) {
    await scheduleSubmitQueued();
  }
});
