import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, LIMITS, SETTINGS_KEY,
  parseList, parseFileTypes, normalizeBaseFolder, normalizeSettings,
} from "../src/lib/settings.js";

const storage = (initial = {}) => {
  const data = { ...initial };
  return {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (obj) => { Object.assign(data, obj); },
  };
};

test("parseList splits strings and dedupes", () => {
  assert.deepEqual(parseList("a.com, b.com;; c.com\nb.com"), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(parseList(["x.com", " x.com ", ""]), ["x.com"]);
  assert.deepEqual(parseList(""), []);
});

test("parseFileTypes normalizes dots, wildcards and case", () => {
  assert.deepEqual(parseFileTypes("*.ZIP, .Pdf mp3 MP3"), ["zip", "pdf", "mp3"]);
  assert.deepEqual(parseFileTypes("not!!valid zip"), ["zip"]);
});

test("normalizeBaseFolder sanitizes segments", () => {
  assert.equal(normalizeBaseFolder("Downloads/My Files"), "Downloads/My Files");
  assert.equal(normalizeBaseFolder('a<b>/c:d'), "a_b_/c_d");
  assert.equal(normalizeBaseFolder("  //a//b//  "), "a/b");
  assert.equal(normalizeBaseFolder(""), "");
});

test("normalizeSettings fills defaults and clamps values", () => {
  const n = normalizeSettings({ minSizeKB: -5, maxConcurrent: 99 });
  assert.equal(n.minSizeKB, LIMITS.minSizeKB[0]);
  assert.equal(n.maxConcurrent, LIMITS.maxConcurrent[1]);
  assert.equal(n.enabled, DEFAULT_SETTINGS.enabled);
  assert.deepEqual(n.fileTypes, [...DEFAULT_SETTINGS.fileTypes]);
  assert.deepEqual(n.excludedSites, []);

  const bad = normalizeSettings({ enabled: "yes", fileTypes: "zip", excludedSites: ["a.com"] });
  assert.equal(bad.enabled, true, "non-boolean falls back to default");
  assert.deepEqual(bad.fileTypes, ["zip"]);

  const off = normalizeSettings({ enabled: false, baseFolder: 'x<y"z' });
  assert.equal(off.enabled, false);
  assert.equal(off.baseFolder, "x_y_z");
});

test("loadSettings and saveSettings round-trip through storage", async () => {
  const { loadSettings, saveSettings } = await import("../src/lib/settings.js");
  const area = storage();
  assert.deepEqual(await loadSettings(area), normalizeSettings(null));

  const saved = await saveSettings({ enabled: false, maxConcurrent: 2, fileTypes: "zip,rar" }, area);
  assert.equal(saved.enabled, false);
  const loaded = await loadSettings(area);
  assert.deepEqual(loaded, saved);
  assert.deepEqual(loaded.fileTypes, ["zip", "rar"]);
});