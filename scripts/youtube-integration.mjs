import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:https";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_BIN || "google-chrome";
const TIMEOUT_MS = 20000;
const VIDEO_BYTES = 300 * 1024;
const AUDIO_BYTES = 120 * 1024;


const root = mkdtempSync(join(tmpdir(), "sdm-yt-"));
const key = join(root, "key.pem");
const cert = join(root, "cert.pem");
const gen = spawnSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=sdm-test",
  "-addext", "subjectAltName=DNS:www.youtube.com,DNS:*.googlevideo.com",
], { encoding: "utf8" });
if (gen.status !== 0) {
  console.error("openssl failed:", gen.stderr);
  process.exit(1);
}

const streamUrl = (port, params) =>
  `https://rr1---sn-test.googlevideo.com:${port}/videoplayback?${new URLSearchParams({ expire: "9999999999", id: "o-int1", ...params })}`;

function page(title, script) {
  return `<!doctype html><title>${title}</title><video width="640" height="360" muted></video><script>${script}</script>`;
}

const requests = [];
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const u = new URL(req.url, "https://x");
  requests.push({ method: req.method, host: req.headers.host, path: req.url });
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST" };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  if (u.pathname === "/videoplayback") {
    if (u.searchParams.get("sabr") === "1") {
      res.writeHead(200, { ...cors, "Content-Type": "application/vnd.yt-ump" });
      return res.end(Buffer.alloc(64, 1));
    }
    const full = u.searchParams.get("mime")?.startsWith("audio/") ? AUDIO_BYTES : VIDEO_BYTES;
    const body = u.searchParams.has("range") ? Buffer.alloc(1024, 2) : Buffer.alloc(full, 2);
    res.writeHead(200, { ...cors, "Content-Type": "application/vnd.yt-ump", "Content-Length": body.length });
    return res.end(body);
  }
  const port = server.address().port;
  if (u.pathname === "/watch" && u.searchParams.get("v") === "adaptive") {
    const video = streamUrl(port, { itag: "137", mime: "video/mp4", clen: String(VIDEO_BYTES), range: "0-1023", rn: "1", rbuf: "0" });
    const audio = streamUrl(port, { itag: "140", mime: "audio/mp4", clen: String(AUDIO_BYTES), range: "0-1023", rn: "2" });
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(page("Cats - YouTube", `Promise.all([fetch(${JSON.stringify(video)}), fetch(${JSON.stringify(audio)})]).then(() => { document.body.dataset.fetched = "1"; });`));
  }
  if (u.pathname === "/watch" && u.searchParams.get("v") === "sabr") {
    const sabr = streamUrl(port, { sabr: "1", rn: "1", alr: "yes" });
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(page("Dogs - YouTube", `fetch(${JSON.stringify(sabr)}, { method: "POST", body: "x", headers: { "Content-Type": "text/plain" } }).then(() => { document.body.dataset.fetched = "1"; });`));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `https://www.youtube.com:${port}`;

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
  `--host-resolver-rules=MAP www.youtube.com 127.0.0.1, MAP *.googlevideo.com 127.0.0.1`,
  "--ignore-certificate-errors",
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
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }) + "\0");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label) {
  const end = Date.now() + TIMEOUT_MS;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openPage(url) {
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
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

const SHADOW = "document.getElementById('sdm-media-host').shadowRoot";

async function openMenu(session, accept, label) {
  await waitFor(() => evaluate(session, "document.body?.dataset.fetched === '1' && Boolean(document.getElementById('sdm-media-host'))"), `${label} page`);
  return waitFor(async () => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 200, y: 150 }, session);
    const state = await evaluate(session, `(() => {
      const r = ${SHADOW};
      const btn = r.querySelector('.btn');
      if (btn.style.display !== 'flex') return null;
      const menu = r.querySelector('.menu');
      if (menu.style.display === 'block') btn.click();
      btn.click();
      return true;
    })()`);
    if (!state) return null;
    await sleep(600);
    const view = await evaluate(session, `(() => {
      const r = ${SHADOW};
      return {
        items: [...r.querySelectorAll('.item')].map((b) => ({ name: b.querySelector('.n').textContent, label: b.querySelector('.l').textContent })),
        notes: [...r.querySelectorAll('.note')].map((n) => n.textContent),
      };
    })()`);
    return accept(view) ? view : null;
  }, `${label} menu`);
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

  const yt = await openPage(`${base}/watch?v=adaptive`);
  const view = await openMenu(yt, (v) => v.items.length >= 2, "adaptive");
  const names = view.items.map((i) => i.name);
  check("menu lists the captured 1080p video track", names.includes("YouTube 1080p · video only"), names.join(" | "));
  check("menu lists the captured audio track", names.includes("YouTube 128k · audio only"));
  const videoItem = view.items.find((i) => i.name === "YouTube 1080p · video only");
  check("video entry shows full size from clen and paired audio", /300\.0 KB/.test(videoItem.label) && /\+ audio file/.test(videoItem.label), videoItem.label);

  await evaluate(yt, `[...${SHADOW}.querySelectorAll('.item')].find((b) => b.textContent.includes('1080p')).click()`);
  const want = ["SDM/Video/Cats [1080p video].mp4", "SDM/Music/Cats [128k audio].m4a"];
  await waitFor(() => want.every((f) => listFiles(downloads).includes(f)), "YouTube downloads");
  check("video saved with page title", true, want[0]);
  check("matching audio queued and saved", true, want[1]);
  const sizes = want.map((f) => statSync(join(downloads, f)).size);
  check("downloads fetched the whole stream, not a range", sizes[0] === VIDEO_BYTES && sizes[1] === AUDIO_BYTES, sizes.join(", "));
  const full = requests.filter((r) => r.method === "GET" && r.path.startsWith("/videoplayback") && !/[?&](range|rn|rbuf)=/.test(r.path));
  check("download requests had byte-range params stripped", full.length >= 2, `${full.length} full-stream GETs`);

  const sabr = await openPage(`${base}/watch?v=sabr`);
  const sview = await openMenu(sabr, (v) => v.notes.some((n) => n.includes("SABR")), "sabr");
  check("SABR video reports a definite SABR message", true, sview.notes[0]);
  check("SABR video lists no entries", sview.items.length === 0);

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
  console.log(exitCode ? "YOUTUBE INTEGRATION FAILED" : "YOUTUBE INTEGRATION PASSED");
  process.exit(exitCode);
}