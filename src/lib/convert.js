export const VIDEO_EXTS = Object.freeze(["3gp", "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "ts", "webm", "wmv"]);
export const AUDIO_EXTS = Object.freeze(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba", "wma"]);
export const CONTAINERS = Object.freeze(["mp4", "mkv", "webm"]);
export const AUDIO_FORMATS = Object.freeze(["mp3", "m4a", "opus"]);

const WEBM_FAMILY = new Set(["webm", "weba", "opus", "ogg", "oga"]);
const MP4_FAMILY = new Set(["mp4", "m4v", "mov", "m4a", "aac", "mp3"]);
const TRACK = /^(.*?)\s*\[[^\]]*?\b(video|audio)\]\.[a-z0-9]+$/i;

const extOf = (name) => (/\.([a-z0-9]{1,10})$/i.exec(String(name ?? ""))?.[1] ?? "").toLowerCase();
const fileOf = (name) => String(name ?? "").split(/[\\/]/).pop();
const isId = (v) => Number.isInteger(v) && v >= 0;

export function mediaKindOf(name) {
  const e = extOf(name);
  if (VIDEO_EXTS.includes(e)) return "video";
  if (AUDIO_EXTS.includes(e)) return "audio";
  return null;
}

export function defaultContainer(video, audio) {
  const v = extOf(video);
  const a = extOf(audio);
  if (WEBM_FAMILY.has(v) && WEBM_FAMILY.has(a)) return "webm";
  if (MP4_FAMILY.has(v) && MP4_FAMILY.has(a)) return "mp4";
  return "mkv";
}

export function normalizeConvertRequest(msg) {
  const m = msg && typeof msg === "object" ? msg : {};
  if (m.op === "merge") {
    if (!isId(m.videoId) || !isId(m.audioId)) throw new Error("Pick a video file and an audio file");
    if (m.videoId === m.audioId) throw new Error("Pick two different files");
    if (!CONTAINERS.includes(m.container)) throw new Error("Unsupported output format");
    return { op: "merge", videoId: m.videoId, audioId: m.audioId, container: m.container };
  }
  if (m.op === "extract") {
    if (!isId(m.inputId)) throw new Error("Pick a file to extract audio from");
    if (!AUDIO_FORMATS.includes(m.format)) throw new Error("Unsupported audio format");
    return { op: "extract", inputId: m.inputId, format: m.format };
  }
  throw new Error("Unknown conversion");
}

export function suggestPair(items = []) {
  const files = items.filter((d) => d && isId(d.id) && mediaKindOf(d.filename));
  const track = (d) => {
    const m = TRACK.exec(fileOf(d.filename));
    return m ? { title: m[1], kind: m[2].toLowerCase() } : null;
  };
  for (const v of files) {
    const tv = track(v);
    if (tv?.kind !== "video") continue;
    const a = files.find((d) => {
      const ta = track(d);
      return ta?.kind === "audio" && ta.title === tv.title;
    });
    if (a) return { videoId: v.id, audioId: a.id };
  }
  const v = files.find((d) => mediaKindOf(d.filename) === "video");
  const a = files.find((d) => mediaKindOf(d.filename) === "audio");
  return v && a ? { videoId: v.id, audioId: a.id } : null;
}