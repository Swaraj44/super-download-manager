import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_BIN || "google-chrome";
const TIMEOUT_MS = 20000;

const payload = Buffer.alloc(64 * 1024, 7);
const mediaPayload = Buffer.alloc(200 * 1024, 3);
const server = createServer((req, res) => {
  if (req.url.startsWith("/media/")) {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": mediaPayload.length });
    return res.end(mediaPayload);
  }
  if (req.url.startsWith("/video.html")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end('<!doctype html><title>video</title><video src="/media/clip.mp4" width="640" height="360" preload="auto" muted></video>');
  }
  if (req.url.startsWith("/files/")) {
    const name = req.url.slice("/files/".length).split("?")[0];
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": payload.length,
      "Content-Disposition": `attachment; filename="${name}"`,
    });
    return res.end(payload);
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><title>smoke</title>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const root = mkdtempSync(join(tmpdir(), "pdm-smoke-"));
const profile = join(root, "profile");
const downloads = join(root, "downloads");
mkdirSync(join(profile, "Default"), { recursive: true });
mkdirSync(downloads);
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
}));

const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });

let stderr = "";
chrome.stderr.on("data", (d) => { stderr += d; });

let nextId = 1;
const pending = new Map();
let buffer = "";
chrome.stdio[4].on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let i;
  while ((i = buffer.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    const p = msg.id && pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
  }
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params, ...(sessionId && { sessionId }) };
  chrome.stdio[3].write(JSON.stringify(msg) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label) {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openPage(url) {
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId };
}

async function evaluate(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

function listFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p, `${prefix}${n}/`) : [`${prefix}${n}`];
  });
}

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

let exitCode = 0;
try {
  const { id: extId } = await send("Extensions.loadUnpacked", { path: EXT_DIR });
  check("extension loads", Boolean(extId), extId);

  const popup = await openPage(`chrome-extension://${extId}/src/popup.html`);
  await waitFor(() => evaluate(popup.sessionId, "document.readyState === 'complete'"), "popup load");

  const state = await waitFor(
    () => evaluate(popup.sessionId, "chrome.runtime.sendMessage({ type: 'pdm:getState' }).catch(() => null)"),
    "background ready",
  );
  check("background answers pdm:getState", state?.ok === true && state.result.settings.enabled === true);

  const ids = await evaluate(popup.sessionId,
    "[...document.querySelectorAll('[id]')].map((e) => e.id).sort().join(',')");
  check("popup renders", ["add-form", "capture", "list", "queue"].every((id) => ids.split(",").includes(id)));

  const bad = await evaluate(popup.sessionId, "chrome.runtime.sendMessage({ type: 'pdm:add', url: 'javascript:alert(1)' })");
  check("rejects unsafe URL", bad?.ok === false, bad?.error);

  const add = await evaluate(popup.sessionId,
    `chrome.runtime.sendMessage({ type: 'pdm:add', url: '${base}/files/manual.zip' })`);
  check("pdm:add accepted", add?.ok === true);
  await waitFor(() => listFiles(downloads).includes("PDM/Compressed/manual.zip"), "manual download");
  check("manual add saved to PDM/Compressed/manual.zip", true);

  const page = await openPage(`${base}/`);
  await sleep(500);
  await evaluate(page.sessionId, `location.href = '${base}/files/captured.zip'`).catch(() => { });
  await waitFor(() => listFiles(downloads).includes("PDM/Compressed/captured.zip"), "captured download");
  check("browser download captured into PDM/Compressed/captured.zip", true);

  const off = await evaluate(popup.sessionId, "chrome.runtime.sendMessage({ type: 'pdm:setSettings', patch: { enabled: false } })");
  check("capture can be disabled", off?.ok === true && off.result.enabled === false);
  const page2 = await openPage(`${base}/`);
  await sleep(500);
  await evaluate(page2.sessionId, `location.href = '${base}/files/ignored.zip'`).catch(() => { });
  await waitFor(() => listFiles(downloads).includes("ignored.zip"), "uncaptured download");
  check("capture off leaves download in default folder", !listFiles(downloads).includes("PDM/Compressed/ignored.zip"));

  const video = await openPage(`${base}/video.html`);
  await waitFor(() => evaluate(video.sessionId, "Boolean(document.getElementById('pdm-media-host'))"), "media button host");
  check("content script injects media button host", true);

  const btnShown = await waitFor(async () => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 200, y: 150 }, video.sessionId);
    return evaluate(video.sessionId,
      "document.getElementById('pdm-media-host').shadowRoot.querySelector('.btn').style.display === 'flex'");
  }, "media button visible on hover");
  check("hovering the video shows the Download button", btnShown);

  await evaluate(video.sessionId, "document.getElementById('pdm-media-host').shadowRoot.querySelector('.btn').click()");
  const items = await waitFor(async () => {
    const v = await evaluate(video.sessionId,
      "[...document.getElementById('pdm-media-host').shadowRoot.querySelectorAll('.item')].map((b) => b.textContent)");
    return v?.length ? v : null;
  }, "media menu items");
  check("menu lists the video source with sniffed size", items.some((t) => t.includes("clip.mp4") && t.includes("200.0 KB")), items.join(" | "));

  await evaluate(video.sessionId, "document.getElementById('pdm-media-host').shadowRoot.querySelector('.item').click()");
  await waitFor(() => listFiles(downloads).includes("PDM/Video/clip.mp4"), "media download");
  check("media download saved to PDM/Video/clip.mp4", true);

  const opts = await openPage(`chrome-extension://${extId}/src/options.html`);
  const maxC = await waitFor(
    () => evaluate(opts.sessionId, "document.querySelector('[name=maxConcurrent]')?.value || ''"),
    "options load",
  );
  check("options page loads settings", maxC === "3", `maxConcurrent=${maxC}`);

  console.log("Downloaded files:", listFiles(downloads).join(", "));
} catch (err) {
  console.error("ERROR", err.message);
  if (stderr) console.error(stderr.split("\n").slice(-15).join("\n"));
  results.push(false);
} finally {
  exitCode = results.every(Boolean) ? 0 : 1;
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(root, { recursive: true, force: true });
  console.log(exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
  process.exit(exitCode);
}