import { baseName, formatBytes, metaKey } from "./lib/format.js";

const list = document.getElementById("list");
const empty = document.getElementById("empty");
const form = document.getElementById("add-form");
const urlInput = document.getElementById("url");
const errorEl = document.getElementById("error");
const captureToggle = document.getElementById("capture");
const queueSection = document.getElementById("queue-section");
const queueList = document.getElementById("queue");
const queueCount = document.getElementById("queue-count");

function showError(text) {
  errorEl.textContent = text;
  errorEl.hidden = !text;
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || "Request failed");
  return res.result;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  try {
    await send({ type: "pdm:add", url: urlInput.value.trim() });
    urlInput.value = "";
    render();
  } catch (err) {
    showError(err.message);
  }
});

captureToggle.addEventListener("change", async () => {
  try {
    await send({ type: "pdm:setSettings", patch: { enabled: captureToggle.checked } });
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

function statusText(d) {
  if (d.state === "complete") return `Completed · ${formatBytes(d.fileSize || d.bytesReceived)}`;
  if (d.state === "interrupted") return `Interrupted (${d.error || "unknown"})`;
  const total = d.totalBytes > 0 ? ` / ${formatBytes(d.totalBytes)}` : "";
  return `${d.paused ? "Paused" : "Downloading"} · ${formatBytes(d.bytesReceived)}${total}`;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", async () => {
    try {
      await onClick();
    } catch (err) {
      showError(err.message);
    }
    render();
  });
  return b;
}

function actionsFor(d) {
  const a = [];
  if (d.state === "in_progress") {
    a.push(d.paused
      ? button("Resume", () => chrome.downloads.resume(d.id))
      : button("Pause", () => chrome.downloads.pause(d.id)));
    a.push(button("Cancel", () => chrome.downloads.cancel(d.id)));
  } else if (d.state === "interrupted" && d.canResume) {
    a.push(button("Resume", () => chrome.downloads.resume(d.id)));
  } else if (d.state === "complete" && d.exists) {
    a.push(button("Open", () => chrome.downloads.open(d.id)));
    a.push(button("Show in folder", () => chrome.downloads.show(d.id)));
  }
  if (d.state !== "in_progress") {
    a.push(button("Remove", () => chrome.downloads.erase({ id: d.id })));
  }
  return a;
}

function renderItem(d, category) {
  const li = document.createElement("li");

  const name = document.createElement("div");
  name.className = "name";
  if (category) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = category;
    name.append(tag);
  }
  name.append(baseName(d.filename, d.finalUrl || d.url));
  name.title = d.finalUrl || d.url;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = statusText(d);

  li.append(name, meta);

  if (d.state === "in_progress") {
    const bar = document.createElement("progress");
    if (d.totalBytes > 0) {
      bar.max = d.totalBytes;
      bar.value = d.bytesReceived;
    }
    li.append(bar);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(...actionsFor(d));
  li.append(actions);
  return li;
}

function renderQueue(pending) {
  queueSection.hidden = pending.length === 0;
  queueCount.textContent = String(pending.length);
  queueList.replaceChildren(...pending.map((job) => {
    const li = document.createElement("li");
    const url = document.createElement("span");
    url.className = "url";
    url.textContent = baseName("", job.url);
    url.title = job.url;
    li.append(url, button("Remove", () => send({ type: "pdm:removeJob", id: job.id })));
    return li;
  }));
}

let rendering = false;

async function render() {
  if (rendering) return;
  rendering = true;
  try {
    const [items, state] = await Promise.all([
      chrome.downloads.search({ orderBy: ["-startTime"], limit: 30 }),
      send({ type: "pdm:getState" }),
    ]);
    const metas = await chrome.storage.local.get(items.map((d) => metaKey(d.id)));
    captureToggle.checked = state.settings.enabled;
    renderQueue(state.queue.pending);
    list.replaceChildren(...items.map((d) => renderItem(d, metas[metaKey(d.id)]?.category)));
    empty.hidden = items.length > 0 || state.queue.pending.length > 0;
  } catch (err) {
    showError(err.message);
  } finally {
    rendering = false;
  }
}

chrome.downloads.onCreated.addListener(render);
chrome.downloads.onChanged.addListener(render);
chrome.downloads.onErased.addListener(render);

setInterval(async () => {
  const active = await chrome.downloads.search({ state: "in_progress", limit: 1 });
  if (active.length) render();
}, 1000);

render();