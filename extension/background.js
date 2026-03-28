const STORAGE_KEY = "videosumState";

const defaultState = () => ({
  baseUrl: "http://127.0.0.1:3847",
  targetMinutes: "",
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

let pollTimer = null;
let submitChain = Promise.resolve();

function scheduleSubmitQueued() {
  submitChain = submitChain
    .catch(() => {})
    .then(() => submitQueued());
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
        item.videoUrl = data.videoUrl || `/api/jobs/${item.serverJobId}/summary-video.mp4`;
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
        const res = await fetch(`${baseUrl}/api/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: item.url,
            targetMinutes: state.targetMinutes !== "" ? state.targetMinutes : undefined,
            mode: item.mode || "key_moments",
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

async function addToQueue({ url, title, mode }) {
  const state = await loadState();
  const canonical = String(url).trim();
  if (!canonical) {
    return { ok: false, error: "Missing URL" };
  }
  if (state.queue.some((q) => q.url === canonical)) {
    return { ok: true, duplicate: true };
  }
  const id = crypto.randomUUID();
  state.queue.push({
    id,
    url: canonical,
    title: String(title || "Video").slice(0, 500),
    mode: mode || "key_moments",
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
      if (msg.targetMinutes != null) {
        const raw = String(msg.targetMinutes).trim();
        state.targetMinutes = raw === "" ? "" : (Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : state.targetMinutes);
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
