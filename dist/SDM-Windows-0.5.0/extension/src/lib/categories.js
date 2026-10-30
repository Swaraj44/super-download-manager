export const DEFAULT_CATEGORIES = Object.freeze([
  { name: "Compressed", extensions: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "lz", "cab"] },
  { name: "Documents", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "csv", "epub"] },
  { name: "Music", extensions: ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "wma", "aif", "aiff", "weba"] },
  { name: "Video", extensions: ["mp4", "m4v", "mkv", "webm", "mov", "avi", "flv", "wmv", "mpg", "mpeg", "3gp", "ts", "ogv"] },
  { name: "Programs", extensions: ["exe", "msi", "apk", "deb", "rpm", "dmg", "iso", "appimage", "pkg"] },
  { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "tif", "tiff", "bmp"] },
]);

export const OTHER_CATEGORY = "Other";

export function categoryFor(ext, categories = DEFAULT_CATEGORIES) {
  const e = String(ext ?? "").toLowerCase();
  if (!e) return OTHER_CATEGORY;
  return categories.find((c) => c.extensions.includes(e))?.name ?? OTHER_CATEGORY;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export function sanitizeSegment(value, fallback = "_") {
  const clean = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!clean) return fallback;
  return RESERVED_NAMES.test(clean) ? `_${clean}` : clean;
}

export function buildTargetPath(filename, category, { baseFolder = "", useCategoryFolders = true } = {}) {
  const base = sanitizeSegment(String(filename ?? "").split(/[\\/]/).pop(), "download");
  const parts = String(baseFolder ?? "")
    .split(/[\\/]+/)
    .filter((p) => p.trim())
    .map((p) => sanitizeSegment(p));
  if (useCategoryFolders && category) parts.push(sanitizeSegment(category));
  parts.push(base);
  return parts.join("/");
}