import { decideCapture, detectExtension, validateDownloadUrl } from "./lib/rules.js";
import { buildTargetPath, categoryFor } from "./lib/categories.js";
import { SETTINGS_KEY, normalizeSettings, saveSettings } from "./lib/settings.js";
import { DownloadQueue, QUEUE_KEY } from "./lib/queue.js";
import { baseName, metaKey } from "./lib/format.js";
import { normalizeConvertRequest } from "./lib/convert.js";
import { describeYtRequest, isYtdlpSite, normalizeYtRequest, YT_PRESETS } from "./lib/ytdlp.js";
import { createNativeClient, NATIVE_HOST } from "./lib/native.js";
import {
  addMedia, bestYouTubeAudio, buildMediaMenu, classifyMediaResponse, cleanMediaUrl, isYouTubeSabr, youtubeFilename,
} from "./lib/media.js";
import { extFromFilename, extFromUrl, STREAM_EXTENSIONS } from "./lib/mime.js";

const MENU_ID = "sdm-download";
const EXTENSION_ONLY = new Set([
  "sdm:add", "sdm:getState", "sdm:setSettings", "sdm:removeJob", "sdm:converterStatus", "sdm:convert", "sdm:cancelConvert", "sdm:ytProbe",
]);
const YT_STATUS_TTL = 60000;
const MAX_FINISHED_CONVERTS = 10;
const SNIFF_TYPES = ["main_frame", "sub_frame", "media", "xmlhttprequest", "object", "other"];

let settings = normalizeSettings(null);
let queue = new DownloadQueue(null, settings.maxConcurrent);
let pumping = false;
const pendingNames = new Map();

async function persistQueue() {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.toJSON() });
  await chrome.action.setBadgeText({ text: queue.active.length ? String(queue.active.length) : "" });
}

async function init() {
  const [storedSettings, storedQueue] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get(QUEUE_KEY),
  ]);
  settings = normalizeSettings(storedSettings[SETTINGS_KEY]);
  queue = new DownloadQueue(storedQueue[QUEUE_KEY], settings.maxConcurrent);

  const live = await chrome.downloads.search({ state: "in_progress" });
  queue.retainActive(live.map((d) => d.id));
  await persistQueue();
  await pump();
}

const ready = init();

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    queue.maxConcurrent = settings.maxConcurrent;
    let job;
    while ((job = queue.takeNext())) {
      if (job.filename) pendingNames.set(job.url, job.filename);
      try {
        const id = await chrome.downloads.download({ url: job.url, conflictAction: "uniquify" });
        queue.markActive(id);
      } catch {
        pendingNames.delete(job.url);
        // Failed URL: drop the job so the queue keeps moving.
      }
      await persistQueue();
    }
  } finally {
    pumping = false;
  }
}

async function enqueueUrl(url, extra) {
  const href = validateDownloadUrl(url);
  await ready;
  queue.enqueue(href, extra);
  await persistQueue();
  await pump();
  return href;
}

const tabMedia = new Map();
const mediaKey = (tabId) => `media:${tabId}`;

function getTabMedia(tabId) {
  if (!tabMedia.has(tabId)) {
    tabMedia.set(tabId, chrome.storage.session.get(mediaKey(tabId))
      .then((r) => (Array.isArray(r[mediaKey(tabId)]) ? r[mediaKey(tabId)] : []))
      .catch(() => []));
  }
  return tabMedia.get(tabId);
}

const sabrKey = (tabId) => `sabr:${tabId}`;
const sabrTabs = new Set();

function clearTabMedia(tabId) {
  tabMedia.set(tabId, Promise.resolve([]));
  sabrTabs.delete(tabId);
  return chrome.storage.session.remove([mediaKey(tabId), sabrKey(tabId)]).catch(() => {});
}

async function markSabr(tabId) {
  if (sabrTabs.has(tabId)) return;
  sabrTabs.add(tabId);
  await chrome.storage.session.set({ [sabrKey(tabId)]: true });
  chrome.tabs.sendMessage(tabId, { type: "sdm:mediaFound", count: 0 }).catch(() => {});
}

async function tabUsesSabr(tabId) {
  if (sabrTabs.has(tabId)) return true;
  const r = await chrome.storage.session.get(sabrKey(tabId)).catch(() => ({}));
  return r[sabrKey(tabId)] === true;
}

async function recordMedia(tabId, entry) {
  const list = await getTabMedia(tabId);
  addMedia(list, entry);
  await chrome.storage.session.set({ [mediaKey(tabId)]: list });
  chrome.tabs.sendMessage(tabId, { type: "sdm:mediaFound", count: list.length }).catch(() => {});
}

function validateMediaUrl(url) {
  const href = validateDownloadUrl(url);
  if (!/^https?:/.test(href)) throw new Error("Only http and https media can be downloaded");
  if (STREAM_EXTENSIONS.has(extFromUrl(href))) throw new Error("Streaming playlists are not supported yet");
  return href;
}

async function downloadMedia(msg, sender) {
  const href = validateMediaUrl(msg.url);
  const tabId = sender?.tab?.id;
  const list = Number.isInteger(tabId) && tabId >= 0 ? await getTabMedia(tabId) : [];
  const key = cleanMediaUrl(href);
  const entry = list.find((e) => cleanMediaUrl(e.url) === key);
  if (!entry?.youtube) return { url: await enqueueUrl(href), urls: [href] };

  const title = typeof msg.title === "string" && msg.title ? msg.title : sender?.tab?.title;
  const urls = [await enqueueUrl(entry.url, { filename: youtubeFilename(title, entry.youtube, entry.ext) })];
  if (entry.youtube.track === "video") {
    const audio = bestYouTubeAudio(list, entry.youtube.id);
    if (audio) urls.push(await enqueueUrl(audio.url, { filename: youtubeFilename(title, audio.youtube, audio.ext) }));
  }
  return { url: urls[0], urls };
}

const native = createNativeClient(
  () => chrome.runtime.connectNative(NATIVE_HOST),
  () => chrome.runtime.lastError?.message || "",
);
const converts = new Map();
let convertSeq = 0;

function helperHint(err) {
  const text = String(err?.message || err);
  if (/not found|forbidden|not allowed/i.test(text)) {
    return `FFmpeg helper is not installed. Run: node native/install.mjs --extension-id ${chrome.runtime.id}`;
  }
  return text;
}

let ytStatusCache = null;

async function converterStatus() {
  let status;
  try {
    const res = await native.request({ type: "ping" }, { timeout: 20000 });
    const yt = res.ytdlp ? { ytdlp: res.ytdlp } : { ytdlpError: res.ytdlpError || "yt-dlp not found. Reinstall the helper with --ytdlp /path/to/yt-dlp" };
    status = res.ffmpeg
      ? { available: true, version: res.version, ffmpeg: res.ffmpeg, ...yt }
      : { available: false, version: res.version, error: res.error || "FFmpeg not found", ...yt };
  } catch (err) {
    status = { available: false, error: helperHint(err), ytdlpError: helperHint(err) };
  }
  ytStatusCache = { at: Date.now(), ok: Boolean(status.ytdlp) };
  return status;
}

async function ytAvailable() {
  if (!ytStatusCache || Date.now() - ytStatusCache.at > YT_STATUS_TTL) await converterStatus();
  return ytStatusCache.ok;
}

function ytUrl(msg, sender) {
  const page = fromExtensionPage(sender);
  const raw = page ? msg.url : sender?.tab?.url;
  if (!page && !isYtdlpSite(raw)) throw new Error("yt-dlp downloads from the page button work on YouTube videos only");
  const href = validateDownloadUrl(raw);
  if (!/^https?:/.test(href)) throw new Error("Only http and https pages can be downloaded with yt-dlp");
  return href;
}

function ytSubdir(mode) {
  const category = settings.useCategoryFolders ? (mode === "audio" ? "Music" : "Video") : "";
  return buildTargetPath("x", category, { baseFolder: settings.baseFolder, useCategoryFolders: settings.useCategoryFolders })
    .split("/").slice(0, -1).join("/");
}

async function ytProbe(msg, sender) {
  const url = ytUrl(msg, sender);
  const res = await native.request({ type: "ytProbe", url }, { timeout: 100000 }).catch((err) => {
    throw new Error(helperHint(err));
  });
  return res.info;
}

async function startYtDownload(msg, sender) {
  const url = ytUrl(msg, sender);
  const req = normalizeYtRequest(msg);
  const id = `y${Date.now().toString(36)}${++convertSeq}`;
  const title = typeof msg.title === "string" && msg.title.trim() ? msg.title.trim().slice(0, 200) : sender?.tab?.title || url;
  const job = { id, op: "download", name: title, preset: describeYtRequest(req), state: "running", progress: 0, stage: "Starting" };
  converts.set(id, job);
  native.request({ id, type: "ytDownload", url, subdir: ytSubdir(req.mode), ...req }, {
    onEvent: (e) => Object.assign(job, { progress: e.progress, stage: e.stage || job.stage }),
  })
    .then((r) => Object.assign(job, { state: "done", progress: 1, output: r.output, plan: r.plan }))
    .catch((err) => Object.assign(job, { state: job.cancelled ? "cancelled" : "error", error: helperHint(err) }))
    .finally(pruneConverts);
  return { ...job };
}

async function completedFile(id) {
  const [d] = await chrome.downloads.search({ id });
  if (!d || d.state !== "complete" || d.exists === false || !d.filename) throw new Error("That download is not a finished file");
  return d.filename;
}

function pruneConverts() {
  const finished = [...converts.values()].filter((j) => j.state !== "running");
  for (const j of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_CONVERTS))) converts.delete(j.id);
}

async function startConvert(msg) {
  const req = normalizeConvertRequest(msg);
  const id = `c${Date.now().toString(36)}${++convertSeq}`;
  let hostMsg;
  let name;
  if (req.op === "merge") {
    const [video, audio] = await Promise.all([completedFile(req.videoId), completedFile(req.audioId)]);
    hostMsg = { id, type: "merge", video, audio, container: req.container };
    name = baseName(video);
  } else {
    const input = await completedFile(req.inputId);
    hostMsg = { id, type: "extract", input, format: req.format };
    name = baseName(input);
  }
  const job = { id, op: req.op, name, state: "running", progress: 0 };
  converts.set(id, job);
  native.request(hostMsg, { onEvent: (e) => { job.progress = e.progress; } })
    .then((r) => Object.assign(job, { state: "done", progress: 1, output: r.output, plan: r.plan }))
    .catch((err) => Object.assign(job, { state: job.cancelled ? "cancelled" : "error", error: helperHint(err) }))
    .finally(pruneConverts);
  return { ...job };
}

async function cancelConvert(id) {
  const job = converts.get(id);
  if (!job || job.state !== "running") return { cancelled: false };
  job.cancelled = true;
  await native.request({ type: "cancel", target: id }, { timeout: 5000 }).catch(() => {});
  return { cancelled: true };
}

function fromExtensionPage(sender) {
  return typeof sender?.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

async function handleMessage(msg, sender) {
  if (sender?.id !== chrome.runtime.id) throw new Error("Forbidden");
  if (EXTENSION_ONLY.has(msg?.type) && !fromExtensionPage(sender)) throw new Error("Forbidden");
  await ready;
  switch (msg?.type) {
    case "sdm:add":
      return { url: await enqueueUrl(msg.url) };
    case "sdm:getState":
      return { settings, queue: queue.toJSON(), converts: [...converts.values()].map((j) => ({ ...j })) };
    case "sdm:setSettings":
      settings = await saveSettings({ ...settings, ...msg.patch });
      await persistQueue();
      await pump();
      return settings;
    case "sdm:removeJob": {
      const removed = queue.remove(msg.id);
      await persistQueue();
      return { removed };
    }
    case "sdm:mediaConfig":
      return { enabled: settings.mediaButton };
    case "sdm:getMedia": {
      const tabId = sender.tab?.id;
      const sniffed = Number.isInteger(tabId) && tabId >= 0 ? await getTabMedia(tabId) : [];
      return buildMediaMenu(msg.elementUrls, sniffed);
    }
    case "sdm:mediaStatus": {
      const tabId = sender.tab?.id;
      return { sabr: Number.isInteger(tabId) && tabId >= 0 ? await tabUsesSabr(tabId) : false };
    }
    case "sdm:downloadMedia":
      return downloadMedia(msg, sender);
    case "sdm:converterStatus":
      return converterStatus();
    case "sdm:convert":
      return startConvert(msg);
    case "sdm:cancelConvert":
      return cancelConvert(msg.id);
    case "sdm:ytAvailable":
      return { available: await ytAvailable() };
    case "sdm:ytPresets": {
      if (!isYtdlpSite(sender.tab?.url)) return { available: false, presets: [] };
      const available = await ytAvailable();
      return { available, presets: available ? YT_PRESETS.map((p) => ({ ...p })) : [] };
    }
    case "sdm:ytProbe":
      return ytProbe(msg, sender);
    case "sdm:ytDownload":
      return startYtDownload(msg, sender);
    default:
      throw new Error(`Unknown message: ${msg?.type}`);
  }
}

function targetFor(item) {
  const info = {
    url: item.url,
    finalUrl: item.finalUrl || item.url,
    filename: item.filename,
    mime: item.mime,
    referrer: item.referrer,
    fileSize: item.fileSize,
    totalBytes: item.totalBytes,
  };
  let ext;
  let name = item.filename;
  if (item.byExtensionId === chrome.runtime.id) {
    const named = pendingNames.get(item.url);
    if (named) {
      pendingNames.delete(item.url);
      name = named;
    }
    ext = extFromFilename(named) || detectExtension(info);
  } else {
    const decision = decideCapture(info, settings);
    if (!decision.capture) return null;
    ext = decision.ext;
  }
  const category = categoryFor(ext);
  const filename = buildTargetPath(name, category, {
    baseFolder: settings.baseFolder,
    useCategoryFolders: settings.useCategoryFolders,
  });
  return { category, filename };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Download with SDM",
    contexts: ["link", "image", "video", "audio"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  const url = info.linkUrl || info.srcUrl;
  if (url) enqueueUrl(url).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame") clearTabMedia(details.tabId);
    if (!settings.mediaButton) return;
    if (isYouTubeSabr(details.url, details.method)) {
      markSabr(details.tabId).catch(() => {});
      return;
    }
    const entry = classifyMediaResponse(details);
    if (entry) recordMedia(details.tabId, entry).catch(() => {});
  },
  { urls: ["http://*/*", "https://*/*"], types: SNIFF_TYPES },
  ["responseHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabMedia(tabId).then(() => tabMedia.delete(tabId));
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  ready
    .then(async () => {
      const target = targetFor(item);
      if (!target) return suggest();
      await chrome.storage.local.set({ [metaKey(item.id)]: { category: target.category, at: Date.now() } });
      suggest({ filename: target.filename, conflictAction: "uniquify" });
    })
    .catch(() => suggest());
  return true;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  await ready;
  if (queue.markDone(delta.id)) {
    await persistQueue();
    await pump();
  }
});

chrome.downloads.onErased.addListener((downloadId) => {
  chrome.storage.local.remove(metaKey(downloadId));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes[SETTINGS_KEY]) return;
  settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
  pump();
});