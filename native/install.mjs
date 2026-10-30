#!/usr/bin/env node
import { accessSync, chmodSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOST_NAME } from "./ffmpeg-host-lib.mjs";


const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = join(HERE, "sdm-ffmpeg-host.mjs");
const PLATFORM = platform();
const IS_WIN = PLATFORM === "win32";

const BROWSER_DIRS = {
  linux: {
    chrome: ".config/google-chrome",
    chromium: ".config/chromium",
    brave: ".config/BraveSoftware/Brave-Browser",
    edge: ".config/microsoft-edge",
  },
  darwin: {
    chrome: "Library/Application Support/Google/Chrome",
    chromium: "Library/Application Support/Chromium",
    brave: "Library/Application Support/BraveSoftware/Brave-Browser",
    edge: "Library/Application Support/Microsoft Edge",
  },
  win32: {
    chrome: ["Software\\Google\\Chrome"],
    chromium: ["Software\\Chromium"],
    brave: ["Software\\BraveSoftware\\Brave-Browser", "Software\\Google\\Chrome"],
    edge: ["Software\\Microsoft\\Edge"],
  },
};

const USAGE = `Usage: node native/install.mjs --extension-id <id>[,<id>...] [options]

  --extension-id <ids>  SDM's ID from chrome://extensions; comma-separate several (required to install)
  --ffmpeg <path>       ffmpeg binary (default: ffmpeg on PATH; optional)
  --ytdlp <path>        yt-dlp binary (default: yt-dlp on PATH or ~/.local/bin; optional)
  --output-dir <dir>    root folder for yt-dlp downloads (default: ~/Downloads)
  --browser <list>      chrome, chromium, brave, edge or all (default: chrome)
  --manifest-dir <dir>  write the host manifest here instead of the browser folder
  --data-dir <dir>      where to put the launcher script
  --uninstall           remove the host manifest and launcher`;

function fail(text) {
  console.error(text);
  process.exit(1);
}

function isExecutable(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, IS_WIN ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidates(p) {
  if (!IS_WIN || extname(p)) return [p];
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...exts.map((e) => p + e.toLowerCase()), p];
}

function findExecutable(name, extraDirs = []) {
  if (/[\\/]/.test(name)) return candidates(resolve(name)).find(isExecutable) || null;
  const dirs = [...(process.env.PATH || "").split(delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    const hit = candidates(join(dir, name)).find(isExecutable);
    if (hit) return hit;
  }
  return null;
}

function reg(args) {
  return spawnSync("reg", args, { encoding: "utf8", windowsHide: true });
}

const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const cmd = (s) => String(s).replace(/%/g, "%%");

let opts;
try {
  opts = parseArgs({
    options: {
      "extension-id": { type: "string" },
      ffmpeg: { type: "string" },
      ytdlp: { type: "string" },
      "output-dir": { type: "string" },
      browser: { type: "string", default: "chrome" },
      "manifest-dir": { type: "string" },
      "data-dir": { type: "string" },
      uninstall: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  }).values;
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!BROWSER_DIRS[PLATFORM]) fail(`This installer supports Linux, macOS and Windows only (found ${PLATFORM}).`);

const home = homedir();
const browsers = opts.browser === "all" ? Object.keys(BROWSER_DIRS[PLATFORM]) : opts.browser.split(",").map((s) => s.trim());
for (const b of browsers) if (!BROWSER_DIRS[PLATFORM][b]) fail(`Unknown browser: ${b}`);

const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
const dataDir = resolve(opts["data-dir"] || (IS_WIN
  ? join(localAppData, "SDM")
  : PLATFORM === "darwin"
    ? join(home, "Library/Application Support/SDM")
    : join(process.env.XDG_DATA_HOME || join(home, ".local/share"), "sdm-ffmpeg")));
const launcher = join(dataDir, IS_WIN ? "sdm-ffmpeg-host.cmd" : "sdm-ffmpeg-host");

const manifestDirs = opts["manifest-dir"]
  ? [resolve(opts["manifest-dir"])]
  : IS_WIN
    ? [dataDir]
    : browsers.map((b) => join(home, BROWSER_DIRS[PLATFORM][b], "NativeMessagingHosts"));
const regKeys = IS_WIN
  ? [...new Set(browsers.flatMap((b) => BROWSER_DIRS.win32[b]))].map((root) => `HKCU\\${root}\\NativeMessagingHosts\\${HOST_NAME}`)
  : [];

if (opts.uninstall) {
  for (const key of regKeys) reg(["delete", key, "/f"]);
  for (const dir of manifestDirs) rmSync(join(dir, `${HOST_NAME}.json`), { force: true });
  rmSync(launcher, { force: true });
  console.log(`Removed ${HOST_NAME} from: ${[...regKeys, ...manifestDirs].join(", ")}`);
  process.exit(0);
}

const extIds = String(opts["extension-id"] || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!extIds.length || !extIds.every((id) => /^[a-p]{32}$/.test(id))) {
  fail(`A valid --extension-id is required (32 letters a-p, see chrome://extensions).\n\n${USAGE}`);
}

const extraDirs = IS_WIN
  ? [join(localAppData, "Microsoft", "WinGet", "Links"), join(home, "scoop", "shims")]
  : [join(home, ".local/bin"), "/usr/local/bin"];
const installHint = IS_WIN
  ? "winget install Gyan.FFmpeg yt-dlp.yt-dlp"
  : PLATFORM === "darwin" ? "brew install ffmpeg yt-dlp" : "sudo apt install ffmpeg; pipx install yt-dlp";

const ffmpeg = findExecutable(opts.ffmpeg || "ffmpeg", extraDirs);
if (opts.ffmpeg && !ffmpeg) fail(`ffmpeg not found: ${opts.ffmpeg}`);
let version = null;
if (ffmpeg) {
  const probe = spawnSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  version = /^ffmpeg version (\S+)/m.exec(probe.stdout || "")?.[1];
  if (probe.status !== 0 || !version) fail(`${ffmpeg} did not run as ffmpeg.`);
}

const ytdlp = findExecutable(opts.ytdlp || "yt-dlp", extraDirs);
if (opts.ytdlp && !ytdlp) fail(`yt-dlp not found: ${opts.ytdlp}`);
let ytVersion = null;
if (ytdlp) {
  const yt = spawnSync(ytdlp, ["--version"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  ytVersion = yt.status === 0 ? (yt.stdout || "").trim() : null;
  if (!ytVersion) fail(`${ytdlp} did not run as yt-dlp.`);
}
const outputDir = resolve(opts["output-dir"] || join(home, "Downloads"));

const env = { ...(ffmpeg && { SDM_FFMPEG: ffmpeg }), ...(ytdlp && { SDM_YTDLP: ytdlp }), SDM_OUTPUT_DIR: outputDir };
mkdirSync(dataDir, { recursive: true });
if (IS_WIN) {
  const lines = ["@echo off", ...Object.entries(env).map(([k, v]) => `set "${k}=${cmd(v)}"`), `"${cmd(process.execPath)}" "${cmd(HOST_SCRIPT)}" %*`];
  writeFileSync(launcher, `${lines.join("\r\n")}\r\n`);
} else {
  const lines = Object.entries(env).map(([k, v]) => `export ${k}=${sh(v)}`);
  writeFileSync(launcher, `#!/bin/sh\n${lines.join("\n")}\nexec ${sh(process.execPath)} ${sh(HOST_SCRIPT)} "$@"\n`);
  chmodSync(launcher, 0o755);
}

const manifest = {
  name: HOST_NAME,
  description: "SDM FFmpeg helper: merge video and audio, extract audio, yt-dlp downloads",
  path: launcher,
  type: "stdio",
  allowed_origins: extIds.map((id) => `chrome-extension://${id}/`),
};
for (const dir of manifestDirs) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${HOST_NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}
const manifestFile = join(manifestDirs[0], `${HOST_NAME}.json`);
for (const key of regKeys) {
  const r = reg(["add", key, "/ve", "/t", "REG_SZ", "/d", manifestFile, "/f"]);
  if (r.status !== 0) fail(`Could not write registry key ${key}: ${(r.stderr || r.stdout || "").trim()}`);
}

console.log(ffmpeg ? `FFmpeg ${version}: ${ffmpeg}` : `FFmpeg: not found (merge/extract and yt-dlp merging disabled; install it with: ${installHint})`);
console.log(ytdlp ? `yt-dlp ${ytVersion}: ${ytdlp}` : `yt-dlp: not found (quality downloads disabled; install it with: ${installHint})`);
console.log(`yt-dlp output folder: ${outputDir}`);
console.log(`Launcher: ${launcher}`);
console.log(`Allowed extensions: ${extIds.join(", ")}`);
console.log(`Registered ${HOST_NAME} in: ${(IS_WIN ? regKeys : manifestDirs).join(", ")}`);