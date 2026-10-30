#!/usr/bin/env node
import { accessSync, chmodSync, constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOST_NAME } from "./ffmpeg-host-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = join(HERE, "pdm-ffmpeg-host.mjs");
const PLATFORM = platform();

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
};

const USAGE = `Usage: node native/install.mjs --extension-id <id> [options]

  --extension-id <id>   PDM's ID from chrome://extensions (required to install)
  --ffmpeg <path>       ffmpeg binary (default: ffmpeg on PATH)
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
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(name) {
  if (name.includes("/")) return isExecutable(resolve(name)) ? resolve(name) : null;
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const p = join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

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
if (!BROWSER_DIRS[PLATFORM]) fail(`This installer supports Linux and macOS only (found ${PLATFORM}).`);

const home = homedir();
const browsers = opts.browser === "all" ? Object.keys(BROWSER_DIRS[PLATFORM]) : opts.browser.split(",").map((s) => s.trim());
for (const b of browsers) if (!BROWSER_DIRS[PLATFORM][b]) fail(`Unknown browser: ${b}`);

const manifestDirs = opts["manifest-dir"]
  ? [resolve(opts["manifest-dir"])]
  : browsers.map((b) => join(home, BROWSER_DIRS[PLATFORM][b], "NativeMessagingHosts"));
const dataDir = resolve(opts["data-dir"] || (PLATFORM === "darwin"
  ? join(home, "Library/Application Support/PDM")
  : join(process.env.XDG_DATA_HOME || join(home, ".local/share"), "pdm-ffmpeg")));
const launcher = join(dataDir, "pdm-ffmpeg-host");

if (opts.uninstall) {
  for (const dir of manifestDirs) rmSync(join(dir, `${HOST_NAME}.json`), { force: true });
  rmSync(launcher, { force: true });
  console.log(`Removed ${HOST_NAME} from: ${manifestDirs.join(", ")}`);
  process.exit(0);
}

const extId = opts["extension-id"];
if (!/^[a-p]{32}$/.test(extId || "")) fail(`A valid --extension-id is required (32 letters a-p, see chrome://extensions).\n\n${USAGE}`);

const ffmpeg = findExecutable(opts.ffmpeg || "ffmpeg");
if (!ffmpeg) fail("ffmpeg not found. Install it (e.g. sudo apt install ffmpeg) or pass --ffmpeg /path/to/ffmpeg.");
const probe = spawnSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8", timeout: 10000 });
const version = /^ffmpeg version (\S+)/m.exec(probe.stdout || "")?.[1];
if (probe.status !== 0 || !version) fail(`${ffmpeg} did not run as ffmpeg.`);

const ytdlp = opts.ytdlp
  ? findExecutable(opts.ytdlp)
  : findExecutable("yt-dlp") || (isExecutable(join(home, ".local/bin/yt-dlp")) ? join(home, ".local/bin/yt-dlp") : null);
if (opts.ytdlp && !ytdlp) fail(`yt-dlp not found: ${opts.ytdlp}`);
let ytVersion = null;
if (ytdlp) {
  const yt = spawnSync(ytdlp, ["--version"], { encoding: "utf8", timeout: 30000 });
  ytVersion = yt.status === 0 ? (yt.stdout || "").trim() : null;
  if (!ytVersion) fail(`${ytdlp} did not run as yt-dlp.`);
}
const outputDir = resolve(opts["output-dir"] || join(home, "Downloads"));

mkdirSync(dataDir, { recursive: true });
const env = [
  `export PDM_FFMPEG=${sh(ffmpeg)}`,
  ...(ytdlp ? [`export PDM_YTDLP=${sh(ytdlp)}`] : []),
  `export PDM_OUTPUT_DIR=${sh(outputDir)}`,
];
writeFileSync(launcher, `#!/bin/sh\n${env.join("\n")}\nexec ${sh(process.execPath)} ${sh(HOST_SCRIPT)} "$@"\n`);
chmodSync(launcher, 0o755);

const manifest = {
  name: HOST_NAME,
  description: "PDM FFmpeg helper: merge video and audio, extract audio, yt-dlp downloads",
  path: launcher,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extId}/`],
};
for (const dir of manifestDirs) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${HOST_NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`FFmpeg ${version}: ${ffmpeg}`);
console.log(ytdlp ? `yt-dlp ${ytVersion}: ${ytdlp}` : "yt-dlp: not found (quality downloads disabled; pass --ytdlp)");
console.log(`yt-dlp output folder: ${outputDir}`);
console.log(`Launcher: ${launcher}`);
console.log(`Registered ${HOST_NAME} in: ${manifestDirs.join(", ")}`);