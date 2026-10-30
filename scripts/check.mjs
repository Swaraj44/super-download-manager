import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = [
  ["src", ".js"], ["src/lib", ".js"], ["src/content", ".js"], ["tests", ".js"], ["tests/helpers", ".js"],
  ["scripts", ".mjs"], ["native", ".mjs"], ["packaging", ".mjs"], ["packaging/test", ".mjs"],
];


let failed = false;
for (const [dir, ext] of DIRS) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) continue;
  for (const name of readdirSync(full).filter((n) => n.endsWith(ext)).sort()) {
    const r = spawnSync(process.execPath, ["--check", join(full, name)], { encoding: "utf8" });
    if (r.status !== 0) {
      failed = true;
      console.error(r.stderr || `${dir}/${name}: syntax check failed`);
    }
  }
}
try {
  JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
} catch (err) {
  failed = true;
  console.error(`manifest.json: ${err.message}`);
}
if (failed) process.exit(1);
console.log("check-ok");