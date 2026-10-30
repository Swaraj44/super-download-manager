export const MIME_EXTENSIONS = {
  "application/zip": "zip",
  "application/x-zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
  "application/vnd.rar": "rar",
  "application/x-tar": "tar",
  "application/gzip": "gz",
  "application/x-gzip": "gz",
  "application/x-bzip2": "bz2",
  "application/x-xz": "xz",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/epub+zip": "epub",
  "application/x-msdownload": "exe",
  "application/x-msi": "msi",
  "application/vnd.android.package-archive": "apk",
  "application/x-iso9660-image": "iso",
  "application/x-apple-diskimage": "dmg",
  "application/vnd.debian.binary-package": "deb",
  "application/x-rpm": "rpm",
  "application/x-bittorrent": "torrent",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  "video/avi": "avi",
  "video/x-flv": "flv",
  "video/mpeg": "mpg",
  "video/3gpp": "3gp",
  "video/x-ms-wmv": "wmv",
  "video/mp2t": "ts",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/webm": "weba",
  "audio/x-ms-wma": "wma",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/tiff": "tif",
  "application/vnd.apple.mpegurl": "m3u8",
  "application/x-mpegurl": "m3u8",
  "audio/mpegurl": "m3u8",
  "audio/x-mpegurl": "m3u8",
  "video/x-mpegurl": "m3u8",
  "application/dash+xml": "mpd",
  "video/vnd.mpeg.dash.mpd": "mpd",
};

export const STREAM_EXTENSIONS = new Set(["m3u8", "mpd", "f4m"]);

export function normalizeMime(mime) {
  return String(mime ?? "").split(";")[0].trim().toLowerCase();
}

export function extFromMime(mime) {
  return MIME_EXTENSIONS[normalizeMime(mime)] || "";
}

export function extFromFilename(name) {
  const base = String(name ?? "").split(/[\\/]/).pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

export function extFromUrl(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return "";
  }
  try {
    path = decodeURIComponent(path);
  } catch {}
  return extFromFilename(path);
}