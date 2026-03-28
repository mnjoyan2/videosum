const MARK_WATCH = "data-videosum-watch";
const NS = "http://www.w3.org/2000/svg";

const MODES = [
  { id: "key_moments",         icon: "⭐", label: "Key moments",         desc: "Most important parts" },
  { id: "short_highlights",    icon: "⚡", label: "Short highlights",     desc: "Fast, engaging clips" },
  { id: "action_items",        icon: "✅", label: "Action items",         desc: "Tasks, decisions, deadlines" },
  { id: "topic_chapters",      icon: "📚", label: "Topic chapters",       desc: "One clip per topic" },
  { id: "tutorial_essentials", icon: "🎓", label: "Tutorial essentials",  desc: "Steps & demos only" },
  { id: "trailer",             icon: "🎬", label: "Trailer",              desc: "Dramatic hook to climax" },
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

function sendEnqueue(url, title, mode) {
  chrome.runtime.sendMessage(
    { type: "ADD_TO_QUEUE", payload: { url, title, mode } },
    () => { void chrome.runtime.lastError; },
  );
}

// ─── MODE PICKER POPOVER ──────────────────────────────────────────────────────

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
let popoverCloseTimer = null;

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
    icon.style.cssText = "font-size:18px;width:24px;text-align:center;flex-shrink:0;";
    icon.textContent = mode.icon;

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
      hidePopover();
      if (url) {
        sendEnqueue(url, title || "Video", mode.id);
      }
    });
    popover.appendChild(row);
  }
}

function showPopover(anchorEl, url, title) {
  clearTimeout(popoverCloseTimer);
  popoverPendingUrl = url;
  popoverPendingTitle = title;
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
}

document.addEventListener("click", (e) => {
  if (!popover.contains(e.target)) {
    hidePopover();
  }
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
    showPopover(btn, canonicalWatchUrl(id), watchTitle());
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
  showPopover(floatingBtn, canonicalWatchUrl(currentVid), tileTitle(currentTile));
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
    floatingBtn.style.display = "none";
    currentVid = null;
    currentTile = null;
    scheduleScan();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
