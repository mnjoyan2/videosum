(function () {
  const STYLE_ID = "videosum-sidebar-style";
  const ROOT_ID = "videosum-sidebar-root";

  const STATUS_LABEL = {
    queued: "Queued",
    processing: "Processing",
    done: "Done",
    failed: "Failed",
  };

  const MODE_LABELS = {
    key_moments: "Key moments",
    short_highlights: "Short highlights",
    action_items: "Action items",
    topic_chapters: "Topic chapters",
    tutorial_essentials: "Tutorial essentials",
    trailer: "Trailer",
  };

  let root = null;
  let iframeEl = null;
  let queueBadgeEl = null;
  let listEl = null;
  let emptyEl = null;
  let targetMinutesEl = null;
  let apiKeyEl = null;
  let baseUrlEl = null;
  let retryBtn = null;
  let clearDoneBtn = null;
  let modesWrap = null;
  let capRadio = null;
  let whRadio = null;
  let serverDetails = null;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
#${ROOT_ID} {
  position: fixed;
  top: 0;
  right: 0;
  width: min(440px, 100vw);
  height: 100vh;
  z-index: 2147483646;
  background: #0c0e12;
  color: #eef1f6;
  font: 13px/1.45 system-ui, -apple-system, sans-serif;
  box-shadow: -8px 0 32px rgba(0,0,0,0.45);
  display: none;
  flex-direction: column;
  border-left: 1px solid #2a3344;
  box-sizing: border-box;
}
#${ROOT_ID}.vsm-open { display: flex; }
#${ROOT_ID} * { box-sizing: border-box; }
.vsm-head {
  flex-shrink: 0;
  padding: 12px 14px;
  border-bottom: 1px solid #2a3344;
  background: linear-gradient(180deg, #121826 0%, #0c0e12 100%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.vsm-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.vsm-mark {
  width: 34px; height: 34px; border-radius: 10px;
  background: linear-gradient(135deg, #4da3ff 0%, #2563eb 100%);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 14px; color: #fff; flex-shrink: 0;
}
.vsm-title { font-weight: 600; font-size: 15px; line-height: 1.2; }
.vsm-sub { font-size: 11px; color: #8b95a8; margin-top: 2px; }
.vsm-close {
  width: 36px; height: 36px; border: none; border-radius: 8px;
  background: #1a2230; color: #eef1f6; cursor: pointer; font-size: 20px;
  line-height: 1; flex-shrink: 0;
}
.vsm-close:hover { background: #222b3a; }
.vsm-badge {
  font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
  background: #141820; border: 1px solid #2a3344; color: #8b95a8;
}
.vsm-badge.on { background: rgba(77,163,255,0.14); border-color: rgba(77,163,255,0.35); color: #4da3ff; }
.vsm-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 14px 16px;
  min-height: 0;
}
.vsm-panel {
  background: #141820;
  border: 1px solid #2a3344;
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 10px;
}
.vsm-pt { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #8b95a8; margin-bottom: 8px; }
.vsm-player-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 10px;
}
.vsm-player-wrap iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}
.vsm-field label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 6px; }
.vsm-hint { font-size: 11px; color: #8b95a8; margin-top: 6px; line-height: 1.35; }
.vsm-input {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid #2a3344;
  background: #0c0e12;
  color: #eef1f6;
  font: 13px system-ui, sans-serif;
  outline: none;
}
.vsm-input:focus { border-color: #4da3ff; box-shadow: 0 0 0 3px rgba(77,163,255,0.14); }
.vsm-num { width: 88px; }
.vsm-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.vsm-btn {
  font: 12px/1 system-ui, sans-serif;
  font-weight: 600;
  cursor: pointer;
  border-radius: 8px;
  border: 1px solid #2a3344;
  background: #1a2230;
  color: #eef1f6;
  padding: 8px 14px;
}
.vsm-btn:hover { background: #222b3a; }
.vsm-btn-primary {
  background: linear-gradient(180deg, #5eb0ff 0%, #4da3ff 100%);
  border-color: transparent;
  color: #061018;
}
.vsm-btn-ghost { background: transparent; color: #8b95a8; }
.vsm-radio-row { display: flex; flex-direction: column; gap: 8px; }
.vsm-radio-row label { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 12px; line-height: 1.35; }
.vsm-radio-row input { margin-top: 2px; }
.vsm-mode-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: #0c0e12;
  color: #eef1f6;
  cursor: pointer;
  margin-bottom: 6px;
  font: inherit;
}
.vsm-mode-btn:hover { background: #1a2230; border-color: #2a3344; }
.vsm-mode-btn .d { font-size: 11px; color: #8b95a8; display: block; margin-top: 2px; }
.vsm-ul { list-style: none; margin: 0; padding: 0; max-height: 200px; overflow-y: auto; }
.vsm-li {
  border: 1px solid #2a3344;
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 8px;
  background: #0c0e12;
  font-size: 12px;
}
.vsm-li .t { font-weight: 600; margin-bottom: 4px; }
.vsm-li .u { font-size: 11px; color: #8b95a8; word-break: break-all; }
.vsm-li .err { color: #ff6b7a; margin-top: 6px; font-size: 11px; }
.vsm-empty { text-align: center; padding: 20px 12px; border: 1px dashed #2a3344; border-radius: 8px; color: #8b95a8; font-size: 12px; }
.vsm-foot { flex-shrink: 0; border-top: 1px solid #2a3344; padding: 8px 12px; background: #0c0e12; }
.vsm-details summary { cursor: pointer; font-size: 12px; font-weight: 600; color: #8b95a8; padding: 8px 4px; list-style: none; }
.vsm-details summary::-webkit-details-marker { display: none; }
.vsm-details[open] summary { color: #eef1f6; }
.vsm-details-inner { padding: 8px 4px 12px; }
`;
    document.documentElement.appendChild(s);
  }

  function buildShell() {
    if (root) return;
    injectStyle();
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("data-videosum-sidebar", "1");
    root.innerHTML = `
<div class="vsm-head">
  <div class="vsm-brand">
    <div class="vsm-mark">V</div>
    <div style="min-width:0">
      <div class="vsm-title">Videosum</div>
      <div class="vsm-sub">AI summaries from YouTube</div>
    </div>
  </div>
  <span class="vsm-badge" id="vsm-queue-badge">0 jobs</span>
  <button type="button" class="vsm-close" id="vsm-close" aria-label="Close">×</button>
</div>
<div class="vsm-scroll">
  <div class="vsm-panel">
    <div class="vsm-pt">Player</div>
    <div class="vsm-player-wrap"><iframe id="vsm-iframe" title="YouTube" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>
  </div>
  <div class="vsm-panel">
    <div class="vsm-pt">Output length</div>
    <div class="vsm-field">
      <label for="vsm-target">Target minutes</label>
      <input type="number" id="vsm-target" class="vsm-input vsm-num" min="0.5" max="120" step="0.5" placeholder="Auto" />
    </div>
    <p class="vsm-hint">Leave empty for per-style defaults, or set a cap for all jobs.</p>
    <div class="vsm-row">
      <button type="button" class="vsm-btn vsm-btn-primary" id="vsm-retry">Retry failed / queued</button>
      <button type="button" class="vsm-btn vsm-btn-ghost" id="vsm-clear">Clear completed</button>
    </div>
  </div>
  <div class="vsm-panel">
    <div class="vsm-pt">Transcript source</div>
    <div class="vsm-radio-row">
      <label><input type="radio" name="vsm-ts" id="vsm-ts-cap" value="captions" checked /> YouTube captions (fast, uses site subtitles)</label>
      <label><input type="radio" name="vsm-ts" id="vsm-ts-whisper" value="whisper" /> Whisper (download + transcribe; can produce a summary video)</label>
    </div>
  </div>
  <div class="vsm-panel">
    <div class="vsm-pt">OpenAI API key</div>
    <div class="vsm-field">
      <label for="vsm-api">Your API key</label>
      <input type="password" id="vsm-api" class="vsm-input" placeholder="sk-..." autocomplete="off" spellcheck="false" />
    </div>
    <p class="vsm-hint">Stored locally. Sent only to your configured server.</p>
  </div>
  <div class="vsm-panel">
    <div class="vsm-pt">Summarization style</div>
    <div id="vsm-modes"></div>
  </div>
  <div class="vsm-panel">
    <div class="vsm-pt">Jobs</div>
    <ul class="vsm-ul" id="vsm-list"></ul>
    <div class="vsm-empty" id="vsm-empty">Nothing queued yet. Pick a style below.</div>
  </div>
</div>
<div class="vsm-foot">
  <details class="vsm-details" id="vsm-server-details">
    <summary>Server connection</summary>
    <div class="vsm-details-inner">
      <div class="vsm-field">
        <label for="vsm-base">Base URL</label>
        <input type="url" id="vsm-base" class="vsm-input" placeholder="https://…" autocomplete="off" />
      </div>
    </div>
  </details>
</div>`;
    document.body.appendChild(root);

    iframeEl = root.querySelector("#vsm-iframe");
    queueBadgeEl = root.querySelector("#vsm-queue-badge");
    listEl = root.querySelector("#vsm-list");
    emptyEl = root.querySelector("#vsm-empty");
    targetMinutesEl = root.querySelector("#vsm-target");
    apiKeyEl = root.querySelector("#vsm-api");
    baseUrlEl = root.querySelector("#vsm-base");
    retryBtn = root.querySelector("#vsm-retry");
    clearDoneBtn = root.querySelector("#vsm-clear");
    modesWrap = root.querySelector("#vsm-modes");
    capRadio = root.querySelector("#vsm-ts-cap");
    whRadio = root.querySelector("#vsm-ts-whisper");
    serverDetails = root.querySelector("#vsm-server-details");

    root.querySelector("#vsm-close").addEventListener("click", () => {
      root.classList.remove("vsm-open");
    });

    targetMinutesEl.addEventListener("change", () => {
      const raw = targetMinutesEl.value.trim();
      chrome.runtime.sendMessage({
        type: "SET_SETTINGS",
        targetMinutes: raw === "" ? "" : raw,
      });
    });
    apiKeyEl.addEventListener("change", () => {
      chrome.runtime.sendMessage({
        type: "SET_SETTINGS",
        apiKey: apiKeyEl.value.trim(),
      });
    });
    baseUrlEl.addEventListener("change", () => {
      chrome.runtime.sendMessage({ type: "SET_SETTINGS", baseUrl: baseUrlEl.value });
    });
    capRadio.addEventListener("change", () => {
      if (capRadio.checked) {
        chrome.runtime.sendMessage({ type: "SET_SETTINGS", transcriptSource: "captions" });
      }
    });
    whRadio.addEventListener("change", () => {
      if (whRadio.checked) {
        chrome.runtime.sendMessage({ type: "SET_SETTINGS", transcriptSource: "whisper" });
      }
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

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && root.classList.contains("vsm-open")) {
        root.classList.remove("vsm-open");
      }
    });
  }

  function buildModes() {
    const vs = window.__videosum;
    if (!vs || !modesWrap) return;
    modesWrap.innerHTML = "";
    for (const mode of vs.MODES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vsm-mode-btn";
      const icon = document.createElement("span");
      icon.appendChild(vs.makeModeIcon(mode.paths));
      const tx = document.createElement("span");
      tx.innerHTML = `<span>${mode.label}</span><span class="d">${mode.desc}</span>`;
      b.appendChild(icon);
      b.appendChild(tx);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        const url = b.dataset.watchUrl;
        const title = b.dataset.title || "Video";
        if (!url) return;
        const ts = whRadio.checked ? "whisper" : "captions";
        vs.sendEnqueue(url, title, mode.id, ts);
      });
      modesWrap.appendChild(b);
    }
  }

  function setModeButtonUrls(watchUrl, title) {
    if (!modesWrap) return;
    const buttons = modesWrap.querySelectorAll(".vsm-mode-btn");
    buttons.forEach((b) => {
      b.dataset.watchUrl = watchUrl;
      b.dataset.title = title;
    });
  }

  function render(state) {
    if (!root) return;
    baseUrlEl.value = state.baseUrl || "https://videosum-production-4f3c.up.railway.app";
    const tv = state.targetMinutes;
    targetMinutesEl.value = tv !== "" && tv != null ? tv : "";
    if (apiKeyEl && !apiKeyEl.matches(":focus")) {
      apiKeyEl.value = state.apiKey || "";
    }
    const ts = state.transcriptSource === "whisper" ? "whisper" : "captions";
    if (ts === "whisper") {
      whRadio.checked = true;
    } else {
      capRadio.checked = true;
    }

    const q = state.queue || [];
    listEl.innerHTML = "";
    emptyEl.style.display = q.length ? "none" : "block";
    const n = q.length;
    queueBadgeEl.textContent = n === 1 ? "1 job" : `${n} jobs`;
    queueBadgeEl.classList.toggle("on", n > 0);

    for (const item of q) {
      const li = document.createElement("li");
      li.className = "vsm-li";
      const st = item.state || "queued";
      li.innerHTML = `<div class="t"></div><div class="u"></div>`;
      li.querySelector(".t").textContent = item.title || "Video";
      li.querySelector(".u").textContent = item.url;
      const meta = document.createElement("div");
      meta.style.cssText = "margin-top:6px;font-size:10px;text-transform:uppercase;color:#8b95a8;";
      meta.textContent = `${STATUS_LABEL[st] || st} · ${MODE_LABELS[item.mode] || item.mode} · ${item.transcriptSource === "whisper" ? "Whisper" : "Captions"}`;
      li.appendChild(meta);
      if (item.error) {
        const er = document.createElement("div");
        er.className = "err";
        er.textContent = item.error;
        li.appendChild(er);
      }
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "Remove";
      rm.className = "vsm-btn";
      rm.style.marginTop = "8px";
      rm.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "REMOVE_ITEM", id: item.id }, refresh);
      });
      li.appendChild(rm);
      listEl.appendChild(li);
    }
  }

  function refresh() {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (s) => {
      if (chrome.runtime.lastError) return;
      render(s);
    });
  }

  function showVideosumSidebar(opts) {
    const vs = window.__videosum;
    if (!vs) return;
    if (!root) {
      buildShell();
      buildModes();
    }
    const videoId = opts && opts.videoId;
    const watchUrl = (opts && opts.watchUrl) || "";
    const title = (opts && opts.title) || "YouTube video";
    if (videoId && iframeEl) {
      iframeEl.src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?rel=0`;
    }
    setModeButtonUrls(watchUrl, title);
    root.classList.add("vsm-open");
    refresh();
  }

  window.showVideosumSidebar = showVideosumSidebar;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.videosumState && root && root.classList.contains("vsm-open")) {
      refresh();
    }
  });

  function boot() {
    if (!window.__videosum) {
      setTimeout(boot, 50);
      return;
    }
    buildShell();
    buildModes();
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
