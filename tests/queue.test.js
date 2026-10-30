import { test } from "node:test";
import assert from "node:assert/strict";
import { DownloadQueue } from "../src/lib/queue.js";

test("enqueue assigns sequential ids and preserves order", () => {
  const q = new DownloadQueue(null, 3);
  const a = q.enqueue("https://x.com/a.zip");
  const b = q.enqueue("https://x.com/b.zip");
  assert.equal(b.id, a.id + 1);
  assert.deepEqual(q.pending.map((j) => j.url), ["https://x.com/a.zip", "https://x.com/b.zip"]);
});

test("takeNext respects concurrency and order", () => {
  const q = new DownloadQueue(null, 2);
  q.enqueue("a"); q.enqueue("b"); q.enqueue("c");
  const a = q.takeNext(); q.markActive(101);
  const b = q.takeNext(); q.markActive(102);
  assert.equal(a.url, "a");
  assert.equal(b.url, "b");
  assert.equal(q.takeNext(), null, "at capacity");
  q.markDone(101);
  assert.equal(q.takeNext().url, "c");
});

test("markActive/markDone track active ids", () => {
  const q = new DownloadQueue(null, 2);
  q.markActive(10);
  q.markActive(10);
  assert.deepEqual(q.active, [10]);
  assert.equal(q.markDone(10), true);
  assert.equal(q.markDone(10), false);
  assert.deepEqual(q.active, []);
});

test("remove deletes a pending job", () => {
  const q = new DownloadQueue(null, 2);
  const j = q.enqueue("a");
  assert.equal(q.remove(j.id), true);
  assert.equal(q.remove(j.id), false);
  assert.equal(q.pending.length, 0);
});

test("round-trips through JSON and repairs bad state", () => {
  const q = new DownloadQueue(null, 3);
  q.enqueue("a"); q.enqueue("b");
  const q2 = new DownloadQueue(JSON.parse(JSON.stringify(q)), 3);
  assert.deepEqual(q2.pending, q.pending);
  assert.equal(q2.seq, q.seq);

  const q3 = new DownloadQueue({ pending: [{ id: 7, url: "u" }, { id: 7, url: "" }, "junk"], active: [5, 5], seq: 0 }, 3);
  assert.deepEqual(q3.pending.map((j) => j.id), [7]);
  assert.deepEqual(q3.active, [5]);
  assert.equal(q3.seq, 8, "seq moves past max pending id");

  const empty = new DownloadQueue("garbage", 1);
  assert.deepEqual(empty.pending, []);
  assert.equal(empty.seq, 1);
});

test("retainActive drops ids no longer present", () => {
  const q = new DownloadQueue(null, 5);
  q.markActive(1); q.markActive(2); q.markActive(3);
  q.retainActive([2]);
  assert.deepEqual(q.active, [2]);
});