import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./helpers/chrome-mock.js";

const MB = 1024 * 1024;
const h = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));

const response = (over = {}) => ({
  tabId: 7,
  type: "media",
  url: "https://cdn.example.com/v/movie.mp4?range=0-1000",
  statusCode: 206,
  responseHeaders: h({ "Content-Type": "video/mp4", "Content-Range": `bytes 0-1000/${20 * MB}` }),
  ...over,
});

async function sniff(m, details) {
  await m.emit("webRequest.onHeadersReceived", details);
  await m.flush();
  await m.flush();
}

test("registers webRequest listener with response headers", async () => {
  const m = await loadBackground();
  const reg = m.calls.webRequestFilters.find((f) => f.name === "webRequest.onHeadersReceived");
  assert.ok(reg);
  assert.deepEqual(reg.extra, ["responseHeaders"]);
  assert.ok(reg.filter.types.includes("media"));
});

test("sniffed media is stored per tab and offered to that tab's content script", async () => {
  const m = await loadBackground();
  await sniff(m, response());
  await sniff(m, response({ tabId: 8, url: "https://other.com/x.mp4", statusCode: 200, responseHeaders: h({ "Content-Type": "video/mp4", "Content-Length": 5 * MB }) }));

  const res = await m.sendMessage({ type: "pdm:getMedia", elementUrls: ["blob:https://cdn.example.com/abc"] }, m.senders.tab(7));
  assert.equal(res.ok, true);
  assert.deepEqual(res.result.map((e) => e.url), ["https://cdn.example.com/v/movie.mp4"]);
  assert.equal(res.result[0].size, 20 * MB);
  assert.equal(res.result[0].label, "MP4 · 20.0 MB");
  assert.ok(m.chrome.storage.session.data["media:7"]);
  assert.ok(m.calls.tabMessages.some((c) => c.tabId === 7 && c.msg.type === "pdm:mediaFound"));
});

test("player element sources are listed first", async () => {
  const m = await loadBackground();
  await sniff(m, response());
  const res = await m.sendMessage({ type: "pdm:getMedia", elementUrls: ["https://cdn.example.com/direct.webm"] }, m.senders.tab(7));
  assert.deepEqual(res.result.map((e) => e.name), ["direct.webm", "movie.mp4"]);
  assert.equal(res.result[0].fromPlayer, true);
});

test("non-media and background requests are ignored", async () => {
  const m = await loadBackground();
  await sniff(m, response({ responseHeaders: h({ "Content-Type": "text/html", "Content-Length": 5 * MB }) }));
  await sniff(m, response({ tabId: -1 }));
  const res = await m.sendMessage({ type: "pdm:getMedia", elementUrls: [] }, m.senders.tab(7));
  assert.deepEqual(res.result, []);
});

test("main frame navigation clears the tab's media list", async () => {
  const m = await loadBackground();
  await sniff(m, response());
  await sniff(m, { tabId: 7, type: "main_frame", url: "https://cdn.example.com/next", statusCode: 200, responseHeaders: h({ "Content-Type": "text/html" }) });
  const res = await m.sendMessage({ type: "pdm:getMedia", elementUrls: [] }, m.senders.tab(7));
  assert.deepEqual(res.result, []);
});

test("closing a tab clears its media list", async () => {
  const m = await loadBackground();
  await sniff(m, response());
  await m.emit("tabs.onRemoved", 7);
  await m.flush();
  assert.equal(m.chrome.storage.session.data["media:7"], undefined);
});

test("sniffing is disabled when the media button is off", async () => {
  const m = await loadBackground();
  await m.sendMessage({ type: "pdm:setSettings", patch: { mediaButton: false } });
  const cfg = await m.sendMessage({ type: "pdm:mediaConfig" }, m.senders.tab(7));
  assert.deepEqual(cfg.result, { enabled: false });
  await sniff(m, response());
  const res = await m.sendMessage({ type: "pdm:getMedia", elementUrls: [] }, m.senders.tab(7));
  assert.deepEqual(res.result, []);
});

test("pdm:downloadMedia queues http media and rejects streams and blobs", async () => {
  const m = await loadBackground();
  const ok = await m.sendMessage({ type: "pdm:downloadMedia", url: "https://cdn.example.com/v/movie.mp4" }, m.senders.tab(7));
  assert.equal(ok.ok, true);
  assert.equal(m.calls.downloads.at(-1).url, "https://cdn.example.com/v/movie.mp4");

  const stream = await m.sendMessage({ type: "pdm:downloadMedia", url: "https://cdn.example.com/live/index.m3u8" }, m.senders.tab(7));
  assert.equal(stream.ok, false);
  assert.match(stream.error, /Streaming/);

  const blob = await m.sendMessage({ type: "pdm:downloadMedia", url: "blob:https://cdn.example.com/x" }, m.senders.tab(7));
  assert.equal(blob.ok, false);

  const data = await m.sendMessage({ type: "pdm:downloadMedia", url: "data:video/mp4,xx" }, m.senders.tab(7));
  assert.equal(data.ok, false);
});

test("content scripts cannot use extension-page-only messages", async () => {
  const m = await loadBackground();
  for (const type of ["pdm:add", "pdm:getState", "pdm:setSettings", "pdm:removeJob"]) {
    const res = await m.sendMessage({ type, url: "https://x.com/a.zip", patch: { enabled: false } }, m.senders.tab(7));
    assert.equal(res.ok, false, type);
    assert.equal(res.error, "Forbidden");
  }
  assert.equal(m.calls.downloads.length, 0);
});

test("messages from other extensions are rejected", async () => {
  const m = await loadBackground();
  const res = await m.sendMessage({ type: "pdm:mediaConfig" }, m.senders.foreign);
  assert.equal(res.error, "Forbidden");
});