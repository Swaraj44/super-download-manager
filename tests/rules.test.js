import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDownloadUrl, wildcardToRegExp, matchesPattern, isExcluded, detectExtension, decideCapture,
} from "../src/lib/rules.js";

const settings = (over = {}) => ({
  enabled: true,
  minSizeKB: 0,
  fileTypes: ["zip", "pdf", "mp4"],
  excludedSites: [],
  ...over,
});

const item = (over = {}) => ({
  url: "https://cdn.example.com/file.zip",
  finalUrl: "https://cdn.example.com/file.zip",
  filename: "",
  mime: "",
  referrer: "",
  fileSize: 0,
  totalBytes: 0,
  ...over,
});

test("validateDownloadUrl accepts http/https/data and rejects others", () => {
  assert.equal(validateDownloadUrl("https://example.com/a.zip"), "https://example.com/a.zip");
  assert.equal(validateDownloadUrl("  http://example.com "), "http://example.com/");
  assert.equal(validateDownloadUrl("data:text/plain,hi"), "data:text/plain,hi");
  assert.throws(() => validateDownloadUrl("ftp://example.com/a.zip"), /Unsupported protocol/);
  assert.throws(() => validateDownloadUrl("javascript:alert(1)"), /Unsupported protocol/);
  assert.throws(() => validateDownloadUrl("not a url"), /Invalid URL/);
});

test("wildcardToRegExp matches glob patterns", () => {
  const re = wildcardToRegExp("*.example.com/*");
  assert.ok(re.test("cdn.example.com/file.zip"));
  assert.ok(!re.test("example.org/file.zip"));
});

test("matchesPattern supports bare hosts, wildcard hosts and path globs", () => {
  assert.ok(matchesPattern("https://ads.example.com/x", "example.com"));
  assert.ok(matchesPattern("https://sub.ads.example.com/x", "*.example.com"));
  assert.ok(matchesPattern("https://example.com/img/a.png", "example.com/img/*"));
  assert.ok(!matchesPattern("https://example.com/img/a.png", "example.com/docs/*"));
  assert.ok(!matchesPattern("https://notexample.com/x", "example.com"));
  assert.ok(!matchesPattern("::bad::", "example.com"));
});

test("isExcluded checks all patterns", () => {
  assert.ok(isExcluded("https://a.spam.net/x", ["spam.net", "other.com"]));
  assert.ok(!isExcluded("https://ok.com/x", ["spam.net"]));
  assert.ok(!isExcluded("https://ok.com/x", []));
});

test("detectExtension prefers filename, then final url, then url, then mime", () => {
  assert.equal(detectExtension(item({ filename: "/x/y/name.zip" })), "zip");
  assert.equal(detectExtension(item({ url: "https://c.com/p/video.mp4?sig=1", finalUrl: "https://c.com/p/video.mp4?sig=1" })), "mp4");
  assert.equal(detectExtension(item({ mime: "application/pdf", url: "https://c.com/p", finalUrl: "https://c.com/p" })), "pdf");
  assert.equal(detectExtension(item()), "zip", "falls back to default finalUrl extension");
});

test("decideCapture requires enabled setting", () => {
  const r = decideCapture(item(), settings({ enabled: false }));
  assert.equal(r.capture, false);
  assert.equal(r.reason, "disabled");
});

test("decideCapture rejects invalid urls and protocols", () => {
  assert.equal(decideCapture(item({ url: "::", finalUrl: "::" }), settings()).reason, "invalid-url");
  assert.equal(decideCapture(item({ url: "ftp://x.com/a.zip", finalUrl: "ftp://x.com/a.zip" }), settings()).reason, "unsupported-protocol");
});

test("decideCapture honours site exclusions including referrer", () => {
  const s = settings({ excludedSites: ["cdn.example.com"] });
  assert.equal(decideCapture(item(), s).reason, "excluded-site");
  const s2 = settings({ excludedSites: ["page.com"] });
  assert.equal(decideCapture(item({ referrer: "https://page.com/watch" }), s2).reason, "excluded-site");
});

test("decideCapture skips stream manifests even if listed", () => {
  const s = settings({ fileTypes: ["zip", "m3u8"] });
  assert.equal(decideCapture(item({ url: "https://x.com/v/index.m3u8", filename: "index.m3u8" }), s).reason, "stream-manifest");
});

test("decideCapture filters by file type", () => {
  assert.equal(decideCapture(item(), settings()).capture, true);
  const r = decideCapture(item({ filename: "page.htm", url: "https://x.com/page.htm" }), settings());
  assert.equal(r.capture, false);
  assert.equal(r.reason, "file-type");
  assert.equal(decideCapture(item(), settings({ fileTypes: [] })).reason, "file-type");
});

test("decideCapture enforces minimum size when size is known", () => {
  const s = settings({ minSizeKB: 100 });
  assert.equal(decideCapture(item({ fileSize: 50 * 1024 }), s).reason, "too-small");
  assert.equal(decideCapture(item({ totalBytes: 50 * 1024, fileSize: 0 }), s).reason, "too-small");
  assert.equal(decideCapture(item({ fileSize: 500 * 1024 }), s).capture, true);
  assert.equal(decideCapture(item({ fileSize: 0 }), s).capture, true, "unknown size passes");
});