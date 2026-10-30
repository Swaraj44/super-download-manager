import { baseName } from "./lib/format.js";
import { defaultContainer, mediaKindOf, suggestPair } from "./lib/convert.js";

const panel = document.getElementById("convert");
const statusEl = document.getElementById("convert-status");
const mergeForm = document.getElementById("merge-form");
const extractForm = document.getElementById("extract-form");
const jobsEl = document.getElementById("converts");
const mf = mergeForm.elements;
const ef = extractForm.elements;

let files = [];
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

function fill(select, list, selected) {
  const prev = select.value;
  select.replaceChildren(...list.map((d) => {
    const o = document.createElement("option");
    o.value = String(d.id);
    o.textContent = baseName(d.filename);
    o.title = d.filename;
    return o;
  }));
  const want = String(selected ?? prev);
  if (list.some((d) => String(d.id) === want)) select.value = want;
}

const nameOf = (id) => files.find((d) => String(d.id) === id)?.filename;
const byKind = (kind) => files.filter((d) => mediaKindOf(d.filename) === kind);

function syncButtons() {
  const v = mf.videoId.value;
  const a = mf.audioId.value;
  mergeForm.querySelector("button").disabled = !available || !v || !a || v === a;
  extractForm.querySelector("button").disabled = !available || !ef.inputId.value;
}

function syncContainer() {
  const v = nameOf(mf.videoId.value);
  const a = nameOf(mf.audioId.value);
  if (v && a) mf.container.value = defaultContainer(v, a);
  syncButtons();
}

async function loadFiles() {
  const items = await chrome.downloads.search({ state: "complete", orderBy: ["-startTime"], limit: 200 });
  files = items.filter((d) => d.exists !== false && d.filename && mediaKindOf(d.filename));
  const pair = suggestPair(files);
  fill(mf.videoId, byKind("video"), pair?.videoId);
  fill(mf.audioId, [...byKind("audio"), ...byKind("video")], pair?.audioId);
  fill(ef.inputId, files);
  syncContainer();
}

async function checkHelper() {
  const s = await send({ type: "sdm:converterStatus" });
  available = s.available;
  setStatus(s.available ? `Ready · ${s.ffmpeg}` : s.error, !s.available);
  syncButtons();
}

function jobText(j) {
  if (j.state === "running") return `Working · ${Math.round((j.progress || 0) * 100)}%`;
  if (j.state === "done") return `Saved next to the source (${j.plan})`;
  if (j.state === "cancelled") return "Cancelled";
  return `Failed: ${j.error || "unknown error"}`;
}

function renderJob(j) {
  const li = document.createElement("li");
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = `${j.op === "merge" ? "Merge" : "Extract"}: ${j.output ? baseName(j.output) : j.name}`;
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
  const { converts: all = [] } = await send({ type: "sdm:getState" });
  const converts = all.filter((j) => j.op !== "download");
  jobsEl.replaceChildren(...converts.slice().reverse().map(renderJob));
  if (panel.open && converts.some((j) => j.state === "running")) poll = setTimeout(() => renderJobs().catch(() => {}), 1000);
}

async function refresh() {
  setStatus("Checking FFmpeg helper…");
  try {
    await Promise.all([checkHelper(), loadFiles(), renderJobs()]);
    if (available && !files.length) setStatus(`${statusEl.textContent}. No finished video or audio downloads yet.`);
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function start(form, msg) {
  form.querySelector("button").disabled = true;
  try {
    await send({ type: "sdm:convert", ...msg });
    await renderJobs();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    syncButtons();
  }
}

mergeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  start(mergeForm, { op: "merge", videoId: Number(mf.videoId.value), audioId: Number(mf.audioId.value), container: mf.container.value });
});

extractForm.addEventListener("submit", (e) => {
  e.preventDefault();
  start(extractForm, { op: "extract", inputId: Number(ef.inputId.value), format: ef.format.value });
});

mf.videoId.addEventListener("change", syncContainer);
mf.audioId.addEventListener("change", syncContainer);
ef.inputId.addEventListener("change", syncButtons);

panel.addEventListener("toggle", () => {
  if (panel.open) refresh();
  else clearTimeout(poll);
});