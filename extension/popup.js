const baseUrlEl = document.getElementById("baseUrl");
const targetMinutesEl = document.getElementById("targetMinutes");
const apiKeyEl = document.getElementById("apiKey");
const retryBtn = document.getElementById("retryBtn");
const clearDoneBtn = document.getElementById("clearDone");
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const queueBadgeEl = document.getElementById("queueBadge");

const STATUS_LABEL = {
  queued: "Queued",
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

const MODE_LABELS = {
  key_moments:         "⭐ Key moments",
  short_highlights:    "⚡ Short highlights",
  action_items:        "✅ Action items",
  topic_chapters:      "📚 Topic chapters",
  tutorial_essentials: "🎓 Tutorial essentials",
  trailer:             "🎬 Trailer",
};

function normalizeBaseUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "http://127.0.0.1:3847";
  return u.replace(/\/+$/, "");
}

function render(state) {
  baseUrlEl.value = state.baseUrl || "http://127.0.0.1:3847";
  const tv = state.targetMinutes;
  targetMinutesEl.value = tv !== "" && tv != null ? tv : "";
  if (apiKeyEl && !apiKeyEl.matches(":focus")) {
    apiKeyEl.value = state.apiKey || "";
  }

  listEl.innerHTML = "";
  const q = state.queue || [];
  emptyEl.style.display = q.length ? "none" : "block";
  if (queueBadgeEl) {
    const n = q.length;
    queueBadgeEl.textContent = n === 1 ? "1 job" : `${n} jobs`;
    queueBadgeEl.classList.toggle("has-items", n > 0);
  }

  for (const item of q) {
    const li = document.createElement("li");
    const st = item.state || "queued";
    li.className = `card state-${st}`;

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = item.title || "Video";
    li.appendChild(t);

    const u = document.createElement("div");
    u.className = "u";
    u.textContent = item.url;
    li.appendChild(u);

    const meta = document.createElement("div");
    meta.className = "meta";
    const statusSpan = document.createElement("span");
    statusSpan.className = `status-pill ${st}`;
    statusSpan.textContent = STATUS_LABEL[st] || st;
    meta.appendChild(statusSpan);
    if (item.mode) {
      const badge = document.createElement("span");
      badge.className = "mode-badge";
      badge.textContent = MODE_LABELS[item.mode] || item.mode;
      meta.appendChild(badge);
    }
    li.appendChild(meta);

    if (item.error) {
      const err = document.createElement("div");
      err.className = "err";
      err.textContent = item.error;
      li.appendChild(err);
    }

    const actions = document.createElement("div");
    actions.className = "actions";

    if (item.state === "done" && item.serverJobId) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = "Open video";
      openBtn.addEventListener("click", () => {
        const base = normalizeBaseUrl(baseUrlEl.value);
        const url =
          item.videoUrl && item.videoUrl.startsWith("http")
            ? item.videoUrl
            : `${base}${item.videoUrl || `/api/jobs/${item.serverJobId}/summary-video.mp4`}`;
        chrome.tabs.create({ url });
      });
      actions.appendChild(openBtn);
    }

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "danger";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "REMOVE_ITEM", id: item.id }, refresh);
    });
    actions.appendChild(rm);
    li.appendChild(actions);
    listEl.appendChild(li);
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (s) => {
    if (chrome.runtime.lastError) return;
    render(s);
  });
}

baseUrlEl.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SET_SETTINGS", baseUrl: baseUrlEl.value });
});

apiKeyEl.addEventListener("change", () => {
  chrome.runtime.sendMessage({ type: "SET_SETTINGS", apiKey: apiKeyEl.value.trim() });
});

targetMinutesEl.addEventListener("change", () => {
  const raw = targetMinutesEl.value.trim();
  chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    targetMinutes: raw === "" ? "" : raw,
  });
});

retryBtn.addEventListener("click", () => {
  retryBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "START_ALL" }, () => {
    retryBtn.disabled = false;
    refresh();
  });
});

clearDoneBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_DONE" }, refresh);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.videosumState) refresh();
});

refresh();
