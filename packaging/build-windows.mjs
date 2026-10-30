#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createZip } from "./zip.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const NATIVE_FILES = ["sdm-ffmpeg-host.mjs", "ffmpeg-host-lib.mjs", "ytdlp-lib.mjs", "install.mjs"];
const SCRIPTS = ["Install.cmd", "Uninstall.cmd", "install.ps1", "uninstall.ps1"];

const { values: opts } = parseArgs({
  options: {
    key: { type: "string", default: join(HERE, "sdm-extension.pem") },
    out: { type: "string", default: join(ROOT, "dist") },
  },
});

const keyPath = resolve(opts.key);
if (!existsSync(keyPath)) throw new Error(`Signing key not found: ${keyPath}. It fixes the extension ID; restore it from backup.`);
const pub = createPublicKey(createPrivateKey(readFileSync(keyPath))).export({ type: "spki", format: "der" });
const id = [...createHash("sha256").update(pub).digest().subarray(0, 16).toString("hex")]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const { version } = manifest;
const name = `SDM-Windows-${version}`;
const out = resolve(opts.out);
const bundle = join(out, name);

const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : [p];
}).sort();
const entriesOf = (dir, prefix) => files(dir).map((p) => ({ name: `${prefix}${relative(dir, p).split(sep).join("/")}`, data: readFileSync(p) }));
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

rmSync(bundle, { recursive: true, force: true });
mkdirSync(join(bundle, "native"), { recursive: true });
cpSync(join(ROOT, "src"), join(bundle, "extension", "src"), { recursive: true });
writeFileSync(join(bundle, "extension", "manifest.json"), json({ ...manifest, key: pub.toString("base64") }));
for (const f of NATIVE_FILES) cpSync(join(ROOT, "native", f), join(bundle, "native", f));
for (const f of SCRIPTS) {
  writeFileSync(join(bundle, f), readFileSync(join(HERE, "windows", f), "utf8").replace(/\r?\n/g, "\r\n"));
}
cpSync(join(ROOT, "INSTALL.md"), join(bundle, "INSTALL.md"));
writeFileSync(join(bundle, "sdm.json"), json({ id, version }));

const bundleZip = join(out, `sdm-windows-${version}.zip`);
writeFileSync(bundleZip, createZip(entriesOf(bundle, `${name}/`)));

const storeZip = join(out, `sdm-extension-store-${version}.zip`);
writeFileSync(storeZip, createZip([
  { name: "manifest.json", data: Buffer.from(json(manifest)) },
  ...entriesOf(join(ROOT, "src"), "src/"),
]));
writeFileSync(join(out, "extension-id.txt"), `${id}\n`);

console.log(`Extension ID: ${id}`);
console.log(`Windows bundle: ${bundle}`);
console.log(`Windows zip: ${bundleZip}`);
console.log(`Store upload zip (Edge Add-ons / Chrome Web Store): ${storeZip}`);