import { baseName, formatBytes } from "./lib/format.js";
import { YT_QUALITIES } from "./lib/ytdlp.js";

const panel = document.getElementById("ytdl");
const statusEl = document.getElementById("yt-status");
const infoEl = document.getElementById("yt-info");
const probeForm = document.getElementById("yt-probe");
const form = document.getElementById("yt-form");
const jobsEl = document.getElementById("yt-jobs");
const pf = probeForm.elements;
const f = form.elements;

let available = false;
let poll = 0;

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || "Request failed");
  return res.result;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
}

function option(value, text) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}

function fillQualities(heights = []) {
  const known = heights.filter((h) => YT_QUALITIES.includes(String(h.height)));
  const list = known.length
    ? known.map((h) => option(String(h.height), `${h.height}p${h.fps > 30 ? h.fps : ""} · ${h.codecs.join("/")}${h.size ? ` · ~${formatBytes(h.size)}` : ""}`))
    : YT_QUALITIES.slice(1).map((q) => option(q, `${q}p`));
  f.quality.replaceChildren(option("best", "Best available"), ...list);
}

function syncMode() {
  const audio = f.mode.value === "audio";
  for (const l of form.querySelectorAll("label[data-for]")) l.hidden = l.dataset.for !== (audio ? "audio" : "video");
  form.querySelector("button").disabled = !available || !pf.url.value;
}

function duration(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

function jobText(j) {
  if (j.state === "running") return `${j.stage || "Working"} · ${Math.round((j.progress || 0) * 100)}% · ${j.preset}`;
  if (j.state === "done") return `Saved (${j.plan})`;
  if (j.state === "cancelled") return "Cancelled";
  return `Failed: ${j.error || "unknown error"}`;
}

function renderJob(j) {
  const li = document.createElement("li");
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = j.output ? baseName(j.output) : j.name;
  name.title = j.output || j.name;
  const meta = document.createElement("div");
  meta.className = j.state === "error" ? "meta err" : "meta";
  meta.textContent = jobText(j);
  li.append(name, meta);
  if (j.state === "running") {
    const bar = document.createElement("progress");
    bar.max = 1;
    bar.value = j.progress || 0;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => send({ type: "sdm:cancelConvert", id: j.id }).catch((err) => setStatus(err.message, true)));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(cancel);
    li.append(bar, actions);
  }
  return li;
}

async function renderJobs() {
  clearTimeout(poll);
  const { converts = [] } = await send({ type: "sdm:getState" });
  const jobs = converts.filter((j) => j.op === "download");
  jobsEl.replaceChildren(...jobs.slice().reverse().map(renderJob));
  if (jobs.some((j) => j.state === "running")) poll = setTimeout(() => renderJobs().catch(() => {}), 1000);
}

async function prefillUrl() {
  if (pf.url.value) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (/^https?:/.test(tab?.url || "")) pf.url.value = tab.url;
}

async function refresh() {
  setStatus("Checking yt-dlp helper…");
  fillQualities();
  try {
    const [s] = await Promise.all([send({ type: "sdm:converterStatus" }), prefillUrl(), renderJobs()]);
    available = Boolean(s.ytdlp && s.ffmpeg);
    if (available) setStatus(`Ready · ${s.ytdlp} · ${s.ffmpeg}`);
    else setStatus(s.ytdlp ? s.error || "FFmpeg not found" : s.ytdlpError || s.error, true);
  } catch (err) {
    setStatus(err.message, true);
  }
  syncMode();
}

probeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = probeForm.querySelector("button");
  btn.disabled = true;
  infoEl.hidden = false;
  infoEl.textContent = "Reading formats…";
  try {
    const info = await send({ type: "sdm:ytProbe", url: pf.url.value.trim() });
    fillQualities(info.heights);
    const top = info.heights[0];
    const audio = info.audio[0];
    infoEl.textContent = [
      info.title,
      info.duration ? duration(info.duration) : "",
      top ? `up to ${top.height}p` : "",
      audio ? `audio ${audio.codec} ${audio.abr}k` : "",
    ].filter(Boolean).join(" · ");
  } catch (err) {
    infoEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    await send({
      type: "sdm:ytDownload",
      url: pf.url.value.trim(),
      title: infoEl.hidden ? "" : infoEl.textContent.split(" · ")[0],
      mode: f.mode.value,
      quality: f.quality.value,
      container: f.container.value,
      audioFormat: f.audioFormat.value,
    });
    await renderJobs();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    syncMode();
  }
});

f.mode.addEventListener("change", syncMode);
pf.url.addEventListener("input", syncMode);

panel.addEventListener("toggle", () => {
  if (panel.open) refresh();
  else clearTimeout(poll);
});