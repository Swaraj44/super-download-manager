#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";


const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PKG = "sdm-download-manager";
const PREFIX = "/opt/sdm";
const HOST_NAME = "com.sdm.ffmpeg";
const MAINTAINER = "Swaraj <swaraj@mislbd.com>";

const BROWSERS = {
  chrome: { policies: "/etc/opt/chrome/policies/managed", hosts: "/etc/opt/chrome/native-messaging-hosts" },
  chromium: { policies: "/etc/chromium/policies/managed", hosts: "/etc/chromium/native-messaging-hosts" },
  edge: { policies: "/etc/opt/edge/policies/managed", hosts: "/etc/opt/edge/native-messaging-hosts" },
  brave: { policies: "/etc/brave/policies/managed", hosts: null },
};

const { values: opts } = parseArgs({
  options: {
    key: { type: "string", default: join(HERE, "sdm-extension.pem") },
    out: { type: "string", default: join(ROOT, "dist") },
  },
});

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout || r.error?.message}`);
  return r.stdout;
}

function loadKey(path) {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    console.log(`Generated signing key ${path} (keep it: it fixes the extension ID)`);
  }
  return createPrivateKey(readFileSync(path));
}

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

const field = (num, buf) => Buffer.concat([varint((num << 3) | 2), varint(buf.length), buf]);

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function buildCrx(zip, privateKey) {
  const pub = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const crxId = createHash("sha256").update(pub).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const signature = sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\0"), u32(signedData.length), signedData, zip]), privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, pub), field(2, signature)])), field(10000, signedData)]);
  const id = [...crxId.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  return { id, pub, crx: Buffer.concat([Buffer.from("Cr24"), u32(3), u32(header.length), header, zip]) };
}

function write(root, path, content, mode = 0o644) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  chmodSync(full, mode);
}

function duKb(dir) {
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    bytes += s.isDirectory() ? duKb(p) * 1024 : s.size;
  }
  return Math.ceil(bytes / 1024);
}

const LAUNCHER = `#!/bin/sh
[ -r /etc/sdm/helper.conf ] && . /etc/sdm/helper.conf
user_conf="\${XDG_CONFIG_HOME:-$HOME/.config}/sdm/helper.conf"
[ -r "$user_conf" ] && . "$user_conf"
PATH="$PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

node_ok() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null
}

if ! node_ok "\${SDM_NODE:-}"; then
  SDM_NODE=
  for n in "$(command -v node 2>/dev/null)" /usr/local/bin/node $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV) "$HOME/.volta/bin/node" /usr/bin/node; do
    if node_ok "$n"; then SDM_NODE=$n; break; fi
  done
fi
if [ -z "$SDM_NODE" ]; then
  echo "sdm-ffmpeg-host: Node.js 20 or newer not found. Set SDM_NODE in /etc/sdm/helper.conf or ~/.config/sdm/helper.conf" >&2
  exit 1
fi

: "\${SDM_FFMPEG:=$(command -v ffmpeg 2>/dev/null || echo ffmpeg)}"
: "\${SDM_YTDLP:=$(command -v yt-dlp 2>/dev/null || echo yt-dlp)}"
: "\${SDM_OUTPUT_DIR:=$HOME/Downloads}"
export SDM_FFMPEG SDM_YTDLP SDM_OUTPUT_DIR
exec "$SDM_NODE" ${PREFIX}/native/sdm-ffmpeg-host.mjs "$@"
`;

const HELPER_CONF = `# Settings for the SDM FFmpeg / yt-dlp helper (shell syntax).
# Per-user overrides go in ~/.config/sdm/helper.conf.
# Unset values are detected automatically from PATH and ~/.local/bin.
#
# SDM_NODE=/usr/local/bin/node        # Node.js 20 or newer
# SDM_FFMPEG=/usr/bin/ffmpeg          # ffprobe must sit next to it
# SDM_YTDLP=/usr/local/bin/yt-dlp
# SDM_OUTPUT_DIR="$HOME/Downloads"    # root folder for yt-dlp downloads
`;

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const privateKey = loadKey(resolve(opts.key));

const work = mkdtempSync(join(tmpdir(), "sdm-build-"));
rmSync(join(opts.out, "build"), { recursive: true, force: true });
const stage = join(work, "extension");
mkdirSync(stage, { recursive: true });
cpSync(join(ROOT, "src"), join(stage, "src"), { recursive: true });

const { id: probeId, pub } = buildCrx(Buffer.alloc(0), privateKey);
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify({ ...manifest, key: pub.toString("base64") }, null, 2)}\n`);
const zipPath = join(work, "extension.zip");
run("zip", ["-q", "-X", "-r", zipPath, "manifest.json", "src"], { cwd: stage });
const { id, crx } = buildCrx(readFileSync(zipPath), privateKey);
if (id !== probeId) throw new Error("extension ID mismatch");

const root = join(work, "deb");
write(root, `${PREFIX}/sdm.crx`, crx);
write(root, `${PREFIX}/updates.xml`, `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='file://${PREFIX}/sdm.crx' version='${version}' />
  </app>
</gupdate>
`);
for (const name of ["sdm-ffmpeg-host.mjs", "ffmpeg-host-lib.mjs", "ytdlp-lib.mjs"]) {
  write(root, `${PREFIX}/native/${name}`, readFileSync(join(ROOT, "native", name)));
}
write(root, `${PREFIX}/bin/sdm-ffmpeg-host`, LAUNCHER, 0o755);
write(root, "/etc/sdm/helper.conf", HELPER_CONF);

const policy = {
  ExtensionSettings: {
    [id]: { installation_mode: "normal_installed", update_url: `file://${PREFIX}/updates.xml` },
  },
};
const hostManifest = {
  name: HOST_NAME,
  description: "SDM FFmpeg helper: merge video and audio, extract audio, yt-dlp downloads",
  path: `${PREFIX}/bin/sdm-ffmpeg-host`,
  type: "stdio",
  allowed_origins: [`chrome-extension://${id}/`],
};
for (const { policies, hosts } of Object.values(BROWSERS)) {
  write(root, `${policies}/sdm-download-manager.json`, `${JSON.stringify(policy, null, 2)}\n`);
  if (hosts) write(root, `${hosts}/${HOST_NAME}.json`, `${JSON.stringify(hostManifest, null, 2)}\n`);
}

write(root, "DEBIAN/control", `Package: ${PKG}
Version: ${version}
Architecture: all
Maintainer: ${MAINTAINER}
Section: web
Priority: optional
Installed-Size: ${duKb(root)}
Recommends: ffmpeg
Suggests: yt-dlp
Description: Super Download Manager browser extension
 Installs the Super Download Manager extension into Google Chrome,
 Chromium, Microsoft Edge and Brave through browser policy, so it works
 without Developer mode. Also registers the native FFmpeg / yt-dlp helper
 (needs Node.js 20 or newer).
`);
write(root, "DEBIAN/conffiles", "/etc/sdm/helper.conf\n");
write(root, "DEBIAN/postinst", `#!/bin/sh
set -e
if [ "$1" = configure ]; then
  echo "Super Download Manager installed (extension ID ${id})."
  echo "Restart Chrome / Edge / Chromium / Brave to load it."
fi
`, 0o755);

for (const dir of [root]) run("chmod", ["-R", "u+rwX,go+rX,go-w", dir]);
mkdirSync(opts.out, { recursive: true });
const debPath = join(opts.out, `${PKG}_${version}_all.deb`);
run("dpkg-deb", ["--root-owner-group", "-Zxz", "--build", root, debPath]);
copyFileSync(join(work, "extension.zip"), join(opts.out, `sdm-extension-${version}.zip`));
writeFileSync(join(opts.out, `sdm-extension-${version}.crx`), crx);
writeFileSync(join(opts.out, "extension-id.txt"), `${id}\n`);
rmSync(work, { recursive: true, force: true });

console.log(`Extension ID: ${id}`);
console.log(`Package: ${debPath}`);