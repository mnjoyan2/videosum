const MARK_WATCH = "data-videosum-watch";
const MARK_TRIGGER = "data-videosum-trigger";
const NS = "http://www.w3.org/2000/svg";

const MODES = [
  {
    id: "key_moments",
    label: "Key moments",
    desc: "Most important parts",
    paths: [
      "M12 2l2.2 6.8h7.1l-5.7 4.1 2.2 6.9-6-4.4-6 4.4 2.2-6.9-5.7-4.1h7.1z",
    ],
  },
  {
    id: "short_highlights",
    label: "Short highlights",
    desc: "Fast, engaging clips",
    paths: [
      "M13 2L3 14h8l-1 8 10-12h-8l1-8z",
    ],
  },
  {
    id: "action_items",
    label: "Action items",
    desc: "Tasks, decisions, deadlines",
    paths: [
      "M9 11l3 3L22 4",
      "M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11",
    ],
  },
  {
    id: "topic_chapters",
    label: "Topic chapters",
    desc: "One clip per topic",
    paths: [
      "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    ],
  },
  {
    id: "tutorial_essentials",
    label: "Tutorial essentials",
    desc: "Steps & demos only",
    paths: [
      "M22 10v6M2 10l10-5 10 5-10 5z",
      "M6 12v5a3 3 0 003 3h6a3 3 0 003-3v-5",
    ],
  },
  {
    id: "trailer",
    label: "Trailer",
    desc: "Dramatic hook to climax",
    paths: [
      "M4 4h16v16H4zM4 9h16M9 4v16",
    ],
  },
];

function makeSvgIcon(size, color) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "display:block;flex-shrink:0;";
  const p = document.createElementNS(NS, "path");
  p.setAttribute("fill", color || "currentColor");
  p.setAttribute("d", "M4 5h16v2H4V5zm0 5h10v2H4v-2zm0 5h14v2H4v-2z");
  svg.appendChild(p);
  return svg;
}

function makeModeIcon(paths) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "display:block;flex-shrink:0;color:#a8a8a8;";
  for (const d of paths) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.5");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

const toastEl = (() => {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "left:50%",
    "bottom:24px",
    "transform:translateX(-50%) translateY(120%)",
    "max-width:min(92vw, 420px)",
    "padding:12px 16px",
    "border-radius:8px",
    "font-family:Roboto,Arial,sans-serif",
    "font-size:13px",
    "line-height:1.4",
    "box-shadow:0 4px 16px rgba(0,0,0,0.45)",
    "pointer-events:none",
    "opacity:0",
    "transition:opacity 0.2s, transform 0.2s",
  ].join(";");
  document.body.appendChild(el);
  return el;
})();

let toastTimer = null;

function showToast(text, kind) {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  const bg =
    kind === "success"
      ? "rgba(15,15,15,0.92)"
      : kind === "error"
        ? "rgba(40,0,0,0.92)"
        : "rgba(15,15,15,0.92)";
  const border =
    kind === "success"
      ? "1px solid rgba(62,166,255,0.45)"
      : kind === "error"
        ? "1px solid rgba(255,107,107,0.5)"
        : "1px solid rgba(255,255,255,0.12)";
  toastEl.style.background = bg;
  toastEl.style.border = border;
  toastEl.style.color = "#f1f1f1";
  toastEl.style.opacity = "1";
  toastEl.style.transform = "translateX(-50%) translateY(0)";
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = "0";
    toastEl.style.transform = "translateX(-50%) translateY(120%)";
  }, 4200);
}

function getVideoIdFromHref(href) {
  try {
    const u = new URL(href, location.origin);
    if (u.pathname === "/watch") {
      const v = u.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    }
    const m = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
  } catch { return null; }
  return null;
}

function watchPageVideoId() {
  const u = new URL(location.href);
  if (u.pathname === "/watch") {
    const v = u.searchParams.get("v");
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
  }
  const m = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function canonicalWatchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function watchTitle() {
  const h =
    document.querySelector("ytd-watch-metadata h1 yt-formatted-string") ||
    document.querySelector("h1 yt-formatted-string");
  return h?.textContent?.trim() || "YouTube video";
}

function tileTitle(tile) {
  const t = tile.querySelector("#video-title") || tile.querySelector("a#video-title");
  if (t?.textContent?.trim()) return t.textContent.trim();
  const a = tile.querySelector('a[href*="/watch?v="]');
  return a?.textContent?.trim() || "YouTube video";
}

function tileVideoId(tile) {
  const a =
    tile.querySelector('a#thumbnail[href*="watch?v="]') ||
    tile.querySelector('a[href*="/watch?v="]') ||
    tile.querySelector('a[href*="/shorts/"]');
  return a?.href ? getVideoIdFromHref(a.href) : null;
}

function sendEnqueue(url, title, mode, transcriptSource) {
  chrome.runtime.sendMessage(
    {
      type: "ADD_TO_QUEUE",
      payload: {
        url,
        title,
        mode,
        transcriptSource: transcriptSource || "captions",
      },
    },
    (response) => {
      if (chrome.runtime.lastError) {
        showToast("Could not reach the extension. Try reloading the page.", "error");
        return;
      }
        if (response?.ok) {
        if (response.duplicate) {
          showToast("This video is already being summarized.", "success");
        } else {
          showToast("Added. Summarization will start shortly.", "success");
        }
      } else {
        showToast(response?.error || "Something went wrong.", "error");
      }
    },
  );
}

const popover = (() => {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "display:none",
    "flex-direction:column",
    "background:#1a1d26",
    "border:1px solid #2c3140",
    "border-radius:10px",
    "padding:6px",
    "gap:2px",
    "box-shadow:0 8px 24px rgba(0,0,0,0.55)",
    "min-width:210px",
  ].join(";");
  document.body.appendChild(el);
  return el;
})();

let popoverPendingUrl = null;
let popoverPendingTitle = null;
let popoverPendingVideoId = null;

function buildPopover() {
  popover.innerHTML = "";
  const header = document.createElement("div");
  header.style.cssText = "font-size:10px;color:#8b919d;padding:4px 8px 6px;font-family:system-ui,sans-serif;letter-spacing:0.04em;text-transform:uppercase;";
  header.textContent = "Choose summarization type";
  popover.appendChild(header);

  for (const mode of MODES) {
    const row = document.createElement("button");
    row.type = "button";
    row.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:10px",
      "width:100%",
      "background:transparent",
      "border:none",
      "border-radius:7px",
      "padding:8px 10px",
      "cursor:pointer",
      "text-align:left",
      "color:#e8eaef",
      "font-family:system-ui,sans-serif",
      "transition:background 0.1s",
    ].join(";");
    row.addEventListener("mouseenter", () => { row.style.background = "#2c3140"; });
    row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });

    const icon = document.createElement("span");
    icon.style.cssText =
      "width:24px;height:24px;display:flex;align-items:center;justify-content:center;flex-shrink:0;";
    icon.appendChild(makeModeIcon(mode.paths));

    const text = document.createElement("span");
    text.style.cssText = "display:flex;flex-direction:column;gap:1px;";
    const lbl = document.createElement("span");
    lbl.style.cssText = "font-size:13px;font-weight:500;line-height:1.2;";
    lbl.textContent = mode.label;
    const desc = document.createElement("span");
    desc.style.cssText = "font-size:11px;color:#8b919d;line-height:1.2;";
    desc.textContent = mode.desc;
    text.appendChild(lbl);
    text.appendChild(desc);

    row.appendChild(icon);
    row.appendChild(text);
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = popoverPendingUrl;
      const title = popoverPendingTitle;
      const vid = popoverPendingVideoId;
      hidePopover();
      if (!url || !vid) return;
      chrome.storage.local.get("videosumState", (raw) => {
        const st = raw.videosumState || {};
        const ts = st.transcriptSource === "whisper" ? "whisper" : "captions";
        sendEnqueue(url, title || "Video", mode.id, ts);
        if (typeof window.showVideosumSidebar === "function") {
          window.showVideosumSidebar({
            videoId: vid,
            watchUrl: url,
            title: title || "Video",
          });
        }
      });
    });
    popover.appendChild(row);
  }
}

function showPopover(anchorEl, url, title, videoId) {
  popoverPendingUrl = url;
  popoverPendingTitle = title;
  popoverPendingVideoId = videoId;
  buildPopover();

  const rect = anchorEl.getBoundingClientRect();
  popover.style.display = "flex";

  const pWidth = popover.offsetWidth || 220;
  const pHeight = popover.offsetHeight || 320;

  let left = rect.left;
  let top = rect.bottom + 6;

  if (left + pWidth > window.innerWidth - 8) {
    left = window.innerWidth - pWidth - 8;
  }
  if (top + pHeight > window.innerHeight - 8) {
    top = rect.top - pHeight - 6;
  }

  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${Math.max(8, top)}px`;
}

function hidePopover() {
  popover.style.display = "none";
  popoverPendingUrl = null;
  popoverPendingTitle = null;
  popoverPendingVideoId = null;
}

document.addEventListener("click", (e) => {
  if (popover.style.display === "none") return;
  if (popover.contains(e.target)) return;
  if (e.target.closest(`[${MARK_TRIGGER}]`)) return;
  hidePopover();
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hidePopover();
});

// ─── WATCH PAGE ───────────────────────────────────────────────────────────────

function injectWatchButton() {
  const id = watchPageVideoId();
  if (!id) return;
  if (document.querySelector(`[${MARK_WATCH}]`)) return;

  const meta = document.querySelector("ytd-watch-metadata");
  if (!meta) return;

  const sr = meta.shadowRoot;
  const actions = sr?.querySelector("#actions") || meta.querySelector("#actions");
  if (!(actions instanceof HTMLElement)) return;

  const wrap = document.createElement("span");
  wrap.setAttribute(MARK_WATCH, "1");
  wrap.setAttribute(MARK_TRIGGER, "1");
  wrap.style.cssText =
    "display:inline-flex;align-items:center;align-self:center;" +
    "margin-inline-start:8px;vertical-align:middle;flex-shrink:0;position:relative;";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "Summarize with Videosum";
  btn.style.cssText = [
    "font-family:Roboto,Arial,sans-serif",
    "font-size:14px",
    "font-weight:500",
    "min-height:36px",
    "padding:0 16px 0 12px",
    "border-radius:18px",
    "border:none",
    "cursor:pointer",
    "color:#0f0f0f",
    "background:#f2f2f2",
    "display:inline-flex",
    "align-items:center",
    "gap:8px",
    "box-sizing:border-box",
    "white-space:nowrap",
  ].join(";");

  const lbl = document.createElement("span");
  lbl.textContent = "Summarize";
  btn.appendChild(makeSvgIcon(18, "#0f0f0f"));
  btn.appendChild(lbl);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (popover.style.display !== "none") {
      hidePopover();
      return;
    }
    showPopover(btn, canonicalWatchUrl(id), watchTitle(), id);
  });

  wrap.appendChild(btn);
  actions.appendChild(wrap);
}

// ─── GRID: single floating button in document.body ────────────────────────────

const floatingBtn = (() => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "Summarize with Videosum";
  btn.style.cssText = [
    "position:fixed",
    "z-index:2147483646",
    "display:none",
    "align-items:center",
    "justify-content:center",
    "width:34px",
    "height:34px",
    "border-radius:50%",
    "border:none",
    "cursor:pointer",
    "background:rgba(0,0,0,0.82)",
    "color:#fff",
    "padding:0",
    "pointer-events:auto",
    "box-shadow:0 2px 6px rgba(0,0,0,0.4)",
    "transition:background 0.15s,transform 0.1s",
  ].join(";");
  btn.appendChild(makeSvgIcon(18, "#fff"));
  btn.setAttribute(MARK_TRIGGER, "1");
  document.body.appendChild(btn);
  return btn;
})();

let hideTimer = null;
let currentVid = null;
let currentTile = null;

function showFloatingBtn(tile, vid) {
  clearTimeout(hideTimer);
  const thumbEl = tile.querySelector("ytd-thumbnail") || tile;
  const rect = thumbEl.getBoundingClientRect();
  floatingBtn.style.top = `${rect.top + 80}px`;
  floatingBtn.style.left = `${rect.right - 42}px`;
  floatingBtn.style.display = "flex";
  currentVid = vid;
  currentTile = tile;
}

function scheduleHide() {
  hideTimer = setTimeout(() => {
    if (popover.style.display !== "none") return;
    const side = document.querySelector("[data-videosum-sidebar]");
    if (side && side.classList.contains("vsm-open")) return;
    floatingBtn.style.display = "none";
    currentVid = null;
    currentTile = null;
  }, 120);
}

floatingBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
floatingBtn.addEventListener("mouseleave", scheduleHide);
floatingBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!currentVid || !currentTile) return;
  if (popover.style.display !== "none") {
    hidePopover();
    return;
  }
  showPopover(
    floatingBtn,
    canonicalWatchUrl(currentVid),
    tileTitle(currentTile),
    currentVid,
  );
});

window.addEventListener("scroll", () => {
  if (popover.style.display === "none") {
    scheduleHide();
  }
}, { passive: true });

const tilesWithListeners = new WeakSet();

function attachTileListeners(tile, vid) {
  if (tilesWithListeners.has(tile)) return;
  tilesWithListeners.add(tile);
  tile.addEventListener("mouseenter", () => showFloatingBtn(tile, vid));
  tile.addEventListener("mouseleave", (e) => {
    if (e.relatedTarget === floatingBtn || floatingBtn.contains(e.relatedTarget)) return;
    if (popover.style.display !== "none") return;
    const side = document.querySelector("[data-videosum-sidebar]");
    if (side && side.classList.contains("vsm-open")) return;
    scheduleHide();
  });
}

function scanGrid() {
  const tiles = document.querySelectorAll(
    "ytd-rich-grid-media,ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer",
  );
  for (const tile of tiles) {
    const vid = tileVideoId(tile);
    if (vid) attachTileListeners(tile, vid);
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

let scanTimer = null;
function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    injectWatchButton();
    scanGrid();
  }, 300);
}

const observer = new MutationObserver(scheduleScan);

function boot() {
  scheduleScan();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("yt-navigate-finish", () => {
    hidePopover();
    const side = document.querySelector("[data-videosum-sidebar]");
    if (side) side.classList.remove("vsm-open");
    floatingBtn.style.display = "none";
    currentVid = null;
    currentTile = null;
    scheduleScan();
  });
}

window.__videosum = {
  MODES,
  makeModeIcon,
  makeSvgIcon,
  sendEnqueue,
  showToast,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "VIDEOSUM_OPEN_SIDEBAR") {
    const id = watchPageVideoId();
    if (typeof window.showVideosumSidebar === "function") {
      if (id) {
        window.showVideosumSidebar({
          videoId: id,
          watchUrl: canonicalWatchUrl(id),
          title: watchTitle(),
        });
      } else {
        window.showVideosumSidebar({
          watchUrl: "",
          title: "YouTube",
        });
      }
    }
    sendResponse({ ok: true });
    return true;
  }
  return undefined;
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
