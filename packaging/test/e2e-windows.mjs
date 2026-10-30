import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    extension: { type: "string" },
    id: { type: "string" },
    browser: { type: "string", default: process.env.BROWSER_BIN || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
    "expect-ffmpeg": { type: "boolean", default: false },
  },
});
if (!opts.extension || !opts.id) {
  console.error("Usage: node packaging/test/e2e-windows.mjs --extension <folder> --id <extension id> [--browser <exe>] [--expect-ffmpeg]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
async function waitFor(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function listFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p, `${prefix}${n}/`) : [`${prefix}${n}`];
  });
}

const payload = Buffer.alloc(64 * 1024, 7);
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": payload.length, "Content-Disposition": 'attachment; filename="pkg.zip"' });
  res.end(payload);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const root = mkdtempSync(join(tmpdir(), "sdm-win-e2e-"));
const profile = join(root, "profile");
const downloads = join(root, "downloads");
mkdirSync(join(profile, "Default"), { recursive: true });
mkdirSync(downloads);
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
}));

const browser = spawn(opts.browser, [
  "--headless=new", "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: "ignore" });

let ws;
let nextId = 1;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
}
async function evaluate(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

try {
  const portFile = join(profile, "DevToolsActivePort");
  const [port, path] = await waitFor(async () => existsSync(portFile) && readFileSync(portFile, "utf8").trim().split(/\r?\n/), "DevToolsActivePort");
  ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result);
  };

  const { id } = await send("Extensions.loadUnpacked", { path: resolve(opts.extension) });
  check("extension loads from the installed folder", id, id);
  check("extension ID is fixed by the manifest key", id === opts.id, `expected ${opts.id}`);

  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${id}/src/popup.html` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await waitFor(() => evaluate(sessionId, "document.readyState === 'complete'"), "popup load");

  const state = await waitFor(() => evaluate(sessionId, "chrome.runtime.sendMessage({ type: 'sdm:getState' })"), "background");
  check("background answers sdm:getState", state?.ok === true);

  const status = await evaluate(sessionId, "chrome.runtime.sendMessage({ type: 'sdm:converterStatus' })");
  check("extension reaches the native helper through the HKCU registry entry", status?.ok && status.result.version, JSON.stringify(status?.result));
  if (opts["expect-ffmpeg"]) check("helper finds FFmpeg", status?.result?.available, status?.result?.ffmpeg || status?.result?.error);

  const add = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: 'sdm:add', url: '${base}/files/pkg.zip' })`);
  check("sdm:add accepted", add?.ok === true);
  await waitFor(async () => listFiles(downloads).includes("SDM/Compressed/pkg.zip"), "download");
  check("download saved to SDM\\Compressed\\pkg.zip", true);
} catch (err) {
  console.error("ERROR", err.message);
  results.push(false);
} finally {
  try { ws?.close(); } catch {}
  browser.kill();
  server.close();
  await sleep(1500);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  const ok = results.length > 0 && results.every(Boolean);
  console.log(ok ? "E2E PASSED" : "E2E FAILED");
  process.exit(ok ? 0 : 1);
}