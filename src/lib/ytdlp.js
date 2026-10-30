export const YT_QUALITIES = Object.freeze(["best", "2160", "1440", "1080", "720", "480", "360", "240", "144"]);
export const YT_CONTAINERS = Object.freeze(["mp4", "mkv", "webm"]);
export const YT_AUDIO_FORMATS = Object.freeze(["m4a", "opus", "mp3", "best"]);

export const YT_PRESETS = Object.freeze([
  { mode: "video", quality: "best", container: "mp4", name: "Best quality · MP4", label: "video + audio, merged by FFmpeg" },
  { mode: "video", quality: "1080", container: "mp4", name: "1080p · MP4", label: "video + audio" },
  { mode: "video", quality: "720", container: "mp4", name: "720p · MP4", label: "video + audio" },
  { mode: "video", quality: "best", container: "mkv", name: "Best quality · MKV", label: "highest resolution and codec (AV1/VP9)" },
  { mode: "audio", audioFormat: "m4a", name: "Audio only · M4A", label: "original AAC, no re-encode" },
  { mode: "audio", audioFormat: "mp3", name: "Audio only · MP3", label: "best audio converted to MP3" },
]);

export function isYtdlpSite(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return u.pathname.length > 1;
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return false;
    return (u.pathname === "/watch" && u.searchParams.has("v")) || /^\/(shorts|embed|live)\/[\w-]+/.test(u.pathname);
  } catch {
    return false;
  }
}

export function normalizeYtRequest(msg) {
  const m = msg && typeof msg === "object" ? msg : {};
  if (m.mode === "audio") {
    if (!YT_AUDIO_FORMATS.includes(m.audioFormat)) throw new Error("Unsupported audio format");
    return { mode: "audio", audioFormat: m.audioFormat };
  }
  if (m.mode !== "video") throw new Error("Choose video or audio");
  if (!YT_QUALITIES.includes(m.quality)) throw new Error("Unsupported quality");
  if (!YT_CONTAINERS.includes(m.container)) throw new Error("Unsupported video format");
  return { mode: "video", quality: m.quality, container: m.container };
}

export function describeYtRequest(r) {
  if (r.mode === "audio") return r.audioFormat === "best" ? "audio (original)" : `audio ${r.audioFormat.toUpperCase()}`;
  return `${r.quality === "best" ? "best" : `${r.quality}p`} ${r.container.toUpperCase()}`;
}