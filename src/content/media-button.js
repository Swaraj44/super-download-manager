(() => {
  if (globalThis.__sdmMediaButton) return;
  globalThis.__sdmMediaButton = true;

  
  const MARGIN = 8;
  const HIDE_DELAY = 2500;
  const ICON = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 3h2v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6V3zM4 19h16v2H4z"/></svg>';
  const STYLE = `
    .btn { position: fixed; display: none; align-items: center; gap: 4px; padding: 4px 9px; margin: 0;
      font: 600 12px/1.4 system-ui, sans-serif; color: #fff; background: #1a73e8; border: 0; border-radius: 4px;
      box-shadow: 0 2px 6px rgba(0,0,0,.35); cursor: pointer; opacity: .92; }
    .btn:hover { opacity: 1; background: #1765cc; }
    .menu { position: fixed; display: none; box-sizing: border-box; min-width: 260px; max-width: 420px; max-height: 320px;
      overflow: auto; padding: 4px 0; background: #fff; color: #222; border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,.3); font: 12px/1.4 system-ui, sans-serif; }
    .item { display: block; width: 100%; box-sizing: border-box; margin: 0; padding: 6px 10px; text-align: left;
      border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
    .item:hover { background: #eef3fd; }
    .item[disabled] { color: #999; cursor: default; background: none; }
    .n { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .l { display: block; color: #666; font-size: 11px; }
    .note { padding: 6px 10px; color: #555; }
    .h { padding: 4px 10px 2px; color: #1a4fa0; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  `;

  let enabled = false;
  let current = null;
  let menuOpen = false;
  let hideTimer = 0;
  let frame = 0;
  let lastPoint = [0, 0];

  const host = document.createElement("div");
  host.id = "sdm-media-host";
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><button class="btn" type="button" title="Download with SDM">${ICON}<span>Download</span></button><div class="menu" role="menu"></div>`;
  const btn = root.querySelector(".btn");
  const menu = root.querySelector(".menu");

  function alive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function setEnabled(on) {
    enabled = Boolean(on) && alive();
    if (enabled) {
      if (!host.isConnected) document.documentElement.appendChild(host);
    } else {
      closeMenu();
      hide();
      host.remove();
    }
  }

  async function send(msg) {
    if (!alive()) {
      setEnabled(false);
      throw new Error("SDM was updated. Reload the page.");
    }
    const res = await chrome.runtime.sendMessage(msg);
    if (!res?.ok) throw new Error(res?.error || "Request failed");
    return res.result;
  }

  function isCandidate(el) {
    if (!(el instanceof HTMLMediaElement) || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const video = el instanceof HTMLVideoElement;
    if (r.width < (video ? 120 : 60) || r.height < (video ? 40 : 20)) return false;
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function mediaAt(x, y) {
    let best = null;
    let bestArea = Infinity;
    for (const el of document.querySelectorAll("video, audio")) {
      if (!isCandidate(el)) continue;
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function show(el) {
    if (current !== el) {
      closeMenu();
      current = el;
    }
    clearTimeout(hideTimer);
    btn.style.display = "flex";
    position();
  }

  function hide() {
    if (menuOpen) return;
    btn.style.display = "none";
    current = null;
  }

  function scheduleHide(delay = HIDE_DELAY) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, delay);
  }

  function position() {
    if (!current) return;
    if (!isCandidate(current)) {
      closeMenu();
      hide();
      return;
    }
    const r = current.getBoundingClientRect();
    const w = btn.offsetWidth || 100;
    const top = Math.max(r.top + MARGIN, MARGIN);
    const left = Math.max(Math.min(r.right - w - MARGIN, innerWidth - w - MARGIN), r.left + MARGIN);
    btn.style.top = `${Math.round(top)}px`;
    btn.style.left = `${Math.round(left)}px`;
    if (menuOpen) positionMenu();
  }

  function positionMenu() {
    const b = btn.getBoundingClientRect();
    const w = menu.offsetWidth || 280;
    const h = menu.offsetHeight || 0;
    menu.style.top = `${Math.round(Math.max(4, Math.min(b.bottom + 4, innerHeight - h - 4)))}px`;
    menu.style.left = `${Math.round(Math.max(4, Math.min(b.right - w, innerWidth - w - 4)))}px`;
  }

  function note(text) {
    const div = document.createElement("div");
    div.className = "note";
    div.textContent = text;
    return div;
  }

  function sourcesOf(el) {
    const urls = [el.currentSrc, el.src, ...[...el.querySelectorAll("source[src]")].map((s) => s.src)];
    return [...new Set(urls.filter(Boolean))];
  }

  function renderItem(item) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item";
    b.title = item.url;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = item.name || item.url;
    const l = document.createElement("span");
    l.className = "l";
    l.textContent = item.label;
    b.append(n, l);
    if (item.kind === "stream") b.disabled = true;
    else b.addEventListener("click", () => download(item));
    return b;
  }

  function heading(text) {
    const div = document.createElement("div");
    div.className = "h";
    div.textContent = text;
    return div;
  }

  function renderPreset(p) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = p.name;
    const l = document.createElement("span");
    l.className = "l";
    l.textContent = p.label;
    b.append(n, l);
    b.addEventListener("click", () => downloadPreset(p));
    return b;
  }

  async function ytPresets() {
    const host = location.hostname.replace(/^www\.|^m\./, "");
    if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(host)) return [];
    const res = await send({ type: "sdm:ytPresets" }).catch(() => null);
    return res?.available ? res.presets : [];
  }

  async function downloadPreset(p) {
    try {
      await send({ type: "sdm:ytDownload", mode: p.mode, quality: p.quality, container: p.container, audioFormat: p.audioFormat, title: document.title });
      menu.replaceChildren(note(`yt-dlp started: ${p.name}. Progress shows in the SDM popup.`));
      setTimeout(() => {
        closeMenu();
        scheduleHide(1000);
      }, 1500);
    } catch (err) {
      menu.replaceChildren(note(err.message));
    }
    positionMenu();
  }

  async function refreshMenu() {
    if (!menuOpen || !current) return;
    const el = current;
    let items;
    let presets;
    try {
      [items, presets] = await Promise.all([send({ type: "sdm:getMedia", elementUrls: sourcesOf(el) }), ytPresets()]);
    } catch (err) {
      menu.replaceChildren(note(err.message));
      positionMenu();
      return;
    }
    if (!menuOpen || current !== el) return;
    if (presets.length) {
      const sniffed = items.length ? [heading("Captured streams (separate files)"), ...items.map(renderItem)] : [];
      menu.replaceChildren(heading("yt-dlp + FFmpeg"), ...presets.map(renderPreset), ...sniffed);
      positionMenu();
      return;
    }
    const body = items.length ? items.map(renderItem) : [note(await emptyReason(el))];
    if (!menuOpen || current !== el) return;
    menu.replaceChildren(...body);
    positionMenu();
  }

  async function emptyReason(el) {
    const host = location.hostname.replace(/^www\.|^m\./, "");
    if (/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(host)) {
      const status = await send({ type: "sdm:mediaStatus" }).catch(() => null);
      if (status?.sabr) {
        return "This video is streamed with YouTube's SABR protocol: the player POSTs for data and never requests a downloadable stream URL. SDM can't download it.";
      }
      return "No YouTube streams seen yet. Play the video for a few seconds, then try again.";
    }
    const src = el.currentSrc || el.src || "";
    if (src.startsWith("blob:") || src.startsWith("mediastream:")) {
      return "This player streams media in segments (no direct file). SDM can only download direct video and audio files.";
    }
    return "No downloadable source found yet. Start playback, then try again.";
  }

  async function download(item) {
    try {
      const res = await send({ type: "sdm:downloadMedia", url: item.url, title: document.title });
      const extra = res?.urls?.length > 1 ? " (video and audio as separate files)" : "";
      menu.replaceChildren(note(`Added to SDM: ${item.name}${extra}`));
      setTimeout(() => {
        closeMenu();
        scheduleHide(1000);
      }, 1200);
    } catch (err) {
      menu.replaceChildren(note(err.message));
    }
    positionMenu();
  }

  function openMenu() {
    menuOpen = true;
    clearTimeout(hideTimer);
    menu.replaceChildren(note("Looking for media sources…"));
    menu.style.display = "block";
    positionMenu();
    refreshMenu();
  }

  function closeMenu() {
    menuOpen = false;
    menu.style.display = "none";
    menu.replaceChildren();
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (menuOpen) closeMenu();
    else openMenu();
  });

  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  document.addEventListener("pointermove", (e) => {
    if (!enabled) return;
    if (e.composedPath().includes(host)) {
      clearTimeout(hideTimer);
      return;
    }
    lastPoint = [e.clientX, e.clientY];
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const el = mediaAt(...lastPoint);
      if (el) show(el);
      else if (current && !menuOpen) scheduleHide();
    });
  }, true);

  document.addEventListener("pointerdown", (e) => {
    if (menuOpen && !e.composedPath().includes(host)) closeMenu();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menuOpen) closeMenu();
  }, true);

  document.addEventListener("play", (e) => {
    if (!enabled || !isCandidate(e.target)) return;
    show(e.target);
    if (!menuOpen) scheduleHide(4000);
  }, true);

  const reposition = () => current && position();
  addEventListener("scroll", reposition, { capture: true, passive: true });
  addEventListener("resize", reposition, { passive: true });

  document.addEventListener("fullscreenchange", () => {
    if (!enabled) return;
    const fs = document.fullscreenElement;
    const parent = fs && !(fs instanceof HTMLMediaElement) ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    reposition();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "sdm:mediaFound" && menuOpen) refreshMenu();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) setEnabled(changes.settings.newValue?.mediaButton !== false);
  });

  send({ type: "sdm:mediaConfig" })
    .then((c) => setEnabled(c?.enabled))
    .catch(() => {});
})();