export const metaKey = (downloadId) => `meta:${downloadId}`;

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function baseName(path, url) {
  if (path) return path.split(/[\\/]/).pop() || path;
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (!last) return u.hostname || u.href;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return url || "";
  }
}