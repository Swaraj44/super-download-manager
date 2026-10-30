import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = "") {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

function hostPing() {
  return new Promise((resolve, reject) => {
    const p = spawn("/opt/sdm/bin/sdm-ffmpeg-host", [`chrome-extension://${ID}/`], { stdio: ["pipe", "pipe", "inherit"] });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { p.kill(); reject(new Error("host ping timed out")); }, 30000);
    p.stdout.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        clearTimeout(timer);
        resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString("utf8")));
        p.stdin.end();
      }
    });
    const body = Buffer.from(JSON.stringify({ id: "ping-1", type: "ping" }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length);
    p.stdin.write(Buffer.concat([len, body]));
  });
}

const pong = await hostPing();
check("native host launcher answers ping", pong.type === "pong" && pong.ffmpeg, `ffmpeg=${pong.ffmpeg} yt-dlp=${pong.ytdlp}`);

const payload = Buffer.alloc(64 * 1024, 7);
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": payload.length, "Content-Disposition": 'attachment; filename="pkg.zip"' });
  res.end(payload);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const root = mkdtempSync(join(tmpdir(), "sdm-deb-"));
const profile = join(root, "profile");
const downloads = join(root, "downloads");
mkdirSync(join(profile, "Default"), { recursive: true });
mkdirSync(downloads);
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
}));

const chrome = spawn("google-chrome", [
  "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage",
  ...(process.env.SDM_CHROME_ARGS || "").split(" ").filter(Boolean), "about:blank",
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
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
async function waitFor(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
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

try {
  const sw = await waitFor(async () => {
    const { targetInfos } = await send("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${ID}/`));
  }, "policy-installed extension service worker", 60000);
  check("Chrome installs the extension from policy (no Developer mode, no unpacked load)", sw, sw.url);

  const prefs = JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8"));
  check("Developer mode is off", prefs.extensions?.ui?.developer_mode !== true);

  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${ID}/src/popup.html` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await waitFor(() => evaluate(sessionId, "document.readyState === 'complete'"), "popup load");

  const state = await waitFor(() => evaluate(sessionId, "chrome.runtime.sendMessage({ type: 'sdm:getState' })"), "background");
  check("background answers sdm:getState", state?.ok === true);

  const status = await evaluate(sessionId, "chrome.runtime.sendMessage({ type: 'sdm:converterStatus' })");
  check("extension reaches native helper (FFmpeg)", status?.ok && status.result.available, JSON.stringify(status?.result));
  check("extension reaches native helper (yt-dlp)", status?.ok && status.result.ytdlp, status?.result?.ytdlp || status?.result?.ytdlpError);

  const add = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: 'sdm:add', url: '${base}/files/pkg.zip' })`);
  check("sdm:add accepted", add?.ok === true);
  await waitFor(async () => listFiles(downloads).includes("SDM/Compressed/pkg.zip"), "download");
  check("download saved to SDM/Compressed/pkg.zip", true);
} catch (err) {
  console.error("ERROR", err.message);
  console.error(stderr.split("\n").slice(-20).join("\n"));
  results.push(false);
} finally {
  chrome.kill();
  server.close();
  const ok = results.every(Boolean);
  console.log(ok ? "E2E PASSED" : "E2E FAILED");
  process.exit(ok ? 0 : 1);
}