import { sanitizeSegment } from "./categories.js";

export const SETTINGS_KEY = "settings";

export const DEFAULT_FILE_TYPES = Object.freeze([
  "3gp", "7z", "aac", "apk", "avi", "bz2", "deb", "dmg", "doc", "docx", "epub", "exe", "flac", "flv",
  "gz", "iso", "m4a", "m4v", "mkv", "mov", "mp3", "mp4", "mpeg", "mpg", "msi", "ogg", "ogv", "opus",
  "pdf", "ppt", "pptx", "rar", "rpm", "tar", "tgz", "wav", "webm", "wma", "wmv", "xls", "xlsx", "xz", "zip",
]);

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  useCategoryFolders: true,
  baseFolder: "SDM",
  minSizeKB: 0,
  maxConcurrent: 3,
  mediaButton: true,
  fileTypes: DEFAULT_FILE_TYPES,
  excludedSites: Object.freeze([]),
});

export const LIMITS = Object.freeze({ maxConcurrent: [1, 10], minSizeKB: [0, 10485760] });

const EXT_RE = /^[a-z0-9]{1,10}$/;

export function parseList(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[\s,;]+/);
  return [...new Set(items.map((s) => String(s).trim()).filter(Boolean))];
}

export function parseFileTypes(value) {
  const types = parseList(value).map((s) => s.replace(/^\*?\./, "").toLowerCase());
  return [...new Set(types.filter((s) => EXT_RE.test(s)))];
}

export function normalizeBaseFolder(value) {
  return String(value ?? "")
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => sanitizeSegment(s))
    .join("/");
}

function clampInt(value, [min, max], fallback) {
  if (value === null || value === "" || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_SETTINGS;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    useCategoryFolders: typeof r.useCategoryFolders === "boolean" ? r.useCategoryFolders : d.useCategoryFolders,
    baseFolder: r.baseFolder === undefined ? d.baseFolder : normalizeBaseFolder(r.baseFolder),
    minSizeKB: clampInt(r.minSizeKB, LIMITS.minSizeKB, d.minSizeKB),
    maxConcurrent: clampInt(r.maxConcurrent, LIMITS.maxConcurrent, d.maxConcurrent),
    mediaButton: typeof r.mediaButton === "boolean" ? r.mediaButton : d.mediaButton,
    fileTypes: r.fileTypes === undefined ? [...d.fileTypes] : parseFileTypes(r.fileTypes),
    excludedSites: r.excludedSites === undefined ? [...d.excludedSites] : parseList(r.excludedSites),
  };
}

export async function loadSettings(area = chrome.storage.sync) {
  const { [SETTINGS_KEY]: raw } = await area.get(SETTINGS_KEY);
  return normalizeSettings(raw);
}

export async function saveSettings(settings, area = chrome.storage.sync) {
  const normalized = normalizeSettings(settings);
  await area.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}