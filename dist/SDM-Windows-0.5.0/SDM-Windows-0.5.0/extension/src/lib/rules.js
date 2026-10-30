import { extFromFilename, extFromMime, extFromUrl, STREAM_EXTENSIONS } from "./mime.js";

export const DOWNLOAD_PROTOCOLS = new Set(["http:", "https:", "data:"]);
export const CAPTURE_PROTOCOLS = new Set(["http:", "https:"]);

export function validateDownloadUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    throw new Error("Invalid URL");
  }
  if (!DOWNLOAD_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  return url.href;
}

export function wildcardToRegExp(pattern) {
  const escaped = String(pattern ?? "")
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesPattern(url, pattern) {
  const p = String(pattern ?? "").trim();
  if (!p) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (p.includes("://")) return wildcardToRegExp(p).test(u.href);
  if (p.includes("/")) return wildcardToRegExp(p).test(u.host + u.pathname);
  const host = p.toLowerCase().replace(/^\*\./, "");
  return wildcardToRegExp(host).test(u.hostname) || wildcardToRegExp(`*.${host}`).test(u.hostname);
}

export function isExcluded(url, patterns = []) {
  return patterns.some((p) => matchesPattern(url, p));
}

export function detectExtension(item) {
  const url = item.finalUrl || item.url;
  return extFromFilename(item.filename) || extFromUrl(url) || extFromMime(item.mime);
}

export function decideCapture(item, settings) {
  if (!settings.enabled) return { capture: false, reason: "disabled" };

  const url = item.finalUrl || item.url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { capture: false, reason: "invalid-url" };
  }
  if (!CAPTURE_PROTOCOLS.has(parsed.protocol)) return { capture: false, reason: "unsupported-protocol" };

  if (isExcluded(url, settings.excludedSites) || (item.referrer && isExcluded(item.referrer, settings.excludedSites))) {
    return { capture: false, reason: "excluded-site" };
  }

  const ext = detectExtension(item);
  if (STREAM_EXTENSIONS.has(ext)) return { capture: false, reason: "stream-manifest", ext };
  if (!ext || !settings.fileTypes.includes(ext)) return { capture: false, reason: "file-type", ext };

  const size = item.fileSize > 0 ? item.fileSize : item.totalBytes;
  if (size > 0 && size < settings.minSizeKB * 1024) return { capture: false, reason: "too-small", ext };

  return { capture: true, reason: "matched", ext };
}