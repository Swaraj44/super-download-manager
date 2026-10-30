import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./helpers/chrome-mock.js";
import { QUEUE_KEY } from "../src/lib/queue.js";
import { metaKey } from "../src/lib/format.js";

const browserItem = (over = {}) => ({
  id: 1,
  url: "https://cdn.example.com/file.zip",
  finalUrl: "https://cdn.example.com/file.zip",
  filename: "file.zip",
  mime: "application/zip",
  referrer: "https://example.com/",
  fileSize: 0,
  totalBytes: 2048,
  ...over,
});

test("registers the context menu on install", async () => {
  const m = await loadBackground();
  await m.emit("runtime.onInstalled", { reason: "install" });
  assert.equal(m.calls.menus.length, 1);
  assert.equal(m.calls.menus[0].id, "sdm-download");
});

test("sdm:add starts a valid download and updates the badge", async () => {
  const m = await loadBackground();
  const res = await m.sendMessage({ type: "sdm:add", url: "https://x.com/a.zip" });
  assert.equal(res.ok, true);
  assert.deepEqual(m.calls.downloads, [{ url: "https://x.com/a.zip", conflictAction: "uniquify" }]);
  assert.equal(m.calls.badge.at(-1), "1");
});

test("sdm:add rejects invalid URLs", async () => {
  const m = await loadBackground();
  const res = await m.sendMessage({ type: "sdm:add", url: "javascript:alert(1)" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Unsupported protocol/);
  assert.equal(m.calls.downloads.length, 0);
});

test("unknown messages return an error", async () => {
  const m = await loadBackground();
  const res = await m.sendMessage({ type: "sdm:nope" });
  assert.equal(res.ok, false);
});

test("queue honours maxConcurrent and advances on completion", async () => {
  const m = await loadBackground();
  await m.sendMessage({ type: "sdm:setSettings", patch: { maxConcurrent: 1 } });
  await m.sendMessage({ type: "sdm:add", url: "https://x.com/a.zip" });
  await m.sendMessage({ type: "sdm:add", url: "https://x.com/b.zip" });
  assert.equal(m.calls.downloads.length, 1);

  const state = (await m.sendMessage({ type: "sdm:getState" })).result;
  assert.deepEqual(state.queue.pending.map((j) => j.url), ["https://x.com/b.zip"]);

  await m.emit("downloads.onChanged", { id: 100, state: { current: "complete" } });
  assert.equal(m.calls.downloads.length, 2);
  assert.equal(m.calls.downloads[1].url, "https://x.com/b.zip");
});

test("failed downloads are dropped and the queue continues", async () => {
  const m = await loadBackground({ failUrls: ["https://x.com/bad.zip"] });
  await m.sendMessage({ type: "sdm:add", url: "https://x.com/bad.zip" });
  await m.sendMessage({ type: "sdm:add", url: "https://x.com/good.zip" });
  const state = (await m.sendMessage({ type: "sdm:getState" })).result;
  assert.equal(state.queue.pending.length, 0);
  assert.deepEqual(state.queue.active, [100]);
});

test("sdm:removeJob removes a pending job", async () => {
  const m = await loadBackground();
  await m.sendMessage({ type: "sdm:setSettings", patch: { maxConcurrent: 1 } });
  await m.sendMessage({ type: "sdm:add", url: "https://x.com/a.zip" });
  await m.sendMessage({ type: "sdm:add", url: "https://x.com/b.zip" });
  const { pending } = (await m.sendMessage({ type: "sdm:getState" })).result.queue;
  const res = await m.sendMessage({ type: "sdm:removeJob", id: pending[0].id });
  assert.deepEqual(res.result, { removed: true });
  assert.equal(m.chrome.storage.local.data[QUEUE_KEY].pending.length, 0);
});

test("captures matching browser downloads into category folders", async () => {
  const m = await loadBackground();
  const suggestion = await m.determine(browserItem());
  assert.deepEqual(suggestion, { filename: "SDM/Compressed/file.zip", conflictAction: "uniquify" });
  assert.equal(m.chrome.storage.local.data[metaKey(1)].category, "Compressed");
});

test("leaves downloads alone when capture is disabled", async () => {
  const m = await loadBackground();
  await m.sendMessage({ type: "sdm:setSettings", patch: { enabled: false } });
  assert.equal(await m.determine(browserItem()), undefined);
});

test("leaves unlisted types, excluded sites and stream manifests alone", async () => {
  const m = await loadBackground();
  await m.sendMessage({ type: "sdm:setSettings", patch: { excludedSites: ["blocked.com"] } });
  assert.equal(await m.determine(browserItem({ filename: "page.html", url: "https://x.com/p.html", finalUrl: "https://x.com/p.html", mime: "text/html" })), undefined);
  assert.equal(await m.determine(browserItem({ url: "https://blocked.com/f.zip", finalUrl: "https://blocked.com/f.zip" })), undefined);
  assert.equal(await m.determine(browserItem({ filename: "index.m3u8", url: "https://x.com/index.m3u8", finalUrl: "https://x.com/index.m3u8", mime: "application/vnd.apple.mpegurl" })), undefined);
});

test("always categorizes SDM's own downloads, even unlisted types", async () => {
  const m = await loadBackground();
  const suggestion = await m.determine(browserItem({
    byExtensionId: "sdm-test", filename: "notes.txt", url: "https://x.com/notes.txt", finalUrl: "https://x.com/notes.txt", mime: "text/plain",
  }));
  assert.equal(suggestion.filename, "SDM/Documents/notes.txt");
});

test("respects baseFolder and useCategoryFolders settings", async () => {
  const m = await loadBackground();
  await m.sendMessage({ type: "sdm:setSettings", patch: { baseFolder: "", useCategoryFolders: false } });
  assert.equal((await m.determine(browserItem())).filename, "file.zip");
});

test("init resumes persisted pending jobs and drops stale active ids", async () => {
  const m = await loadBackground({
    local: { [QUEUE_KEY]: { pending: [{ id: 1, url: "https://x.com/resume.zip" }], active: [99], seq: 2 } },
  });
  assert.equal(m.calls.downloads[0].url, "https://x.com/resume.zip");
  assert.deepEqual(m.chrome.storage.local.data[QUEUE_KEY].active, [100]);
});

test("context menu click enqueues the link", async () => {
  const m = await loadBackground();
  await m.emit("contextMenus.onClicked", { menuItemId: "sdm-download", linkUrl: "https://x.com/c.pdf" });
  await m.sendMessage({ type: "sdm:getState" });
  assert.equal(m.calls.downloads.at(-1)?.url, "https://x.com/c.pdf");
});

test("erasing a download removes its metadata", async () => {
  const m = await loadBackground({ local: { [metaKey(5)]: { category: "Video" } } });
  await m.emit("downloads.onErased", 5);
  await new Promise((r) => setImmediate(r));
  assert.equal(m.chrome.storage.local.data[metaKey(5)], undefined);
});