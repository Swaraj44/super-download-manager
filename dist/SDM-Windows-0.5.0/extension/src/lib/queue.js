export const QUEUE_KEY = "queue";

export class DownloadQueue {
  constructor(state, maxConcurrent = 3) {
    const s = state && typeof state === "object" ? state : {};
    this.pending = (Array.isArray(s.pending) ? s.pending : [])
      .filter((j) => j && Number.isInteger(j.id) && typeof j.url === "string" && j.url)
      .map((j) => ({ ...j }));
    this.active = [...new Set((Array.isArray(s.active) ? s.active : []).filter(Number.isInteger))];
    const maxId = this.pending.reduce((m, j) => Math.max(m, j.id), 0);
    this.seq = Math.max(Number.isInteger(s.seq) ? s.seq : 1, maxId + 1);
    this.maxConcurrent = maxConcurrent;
  }

  enqueue(url, { filename } = {}) {
    const job = { id: this.seq++, url, addedAt: Date.now() };
    if (typeof filename === "string" && filename) job.filename = filename;
    this.pending.push(job);
    return job;
  }

  remove(jobId) {
    const i = this.pending.findIndex((j) => j.id === jobId);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    return true;
  }

  hasCapacity() {
    return this.active.length < this.maxConcurrent;
  }

  takeNext() {
    if (!this.hasCapacity() || this.pending.length === 0) return null;
    return this.pending.shift();
  }

  markActive(downloadId) {
    if (!this.active.includes(downloadId)) this.active.push(downloadId);
  }

  markDone(downloadId) {
    const i = this.active.indexOf(downloadId);
    if (i < 0) return false;
    this.active.splice(i, 1);
    return true;
  }

  retainActive(downloadIds) {
    const keep = new Set(downloadIds);
    this.active = this.active.filter((id) => keep.has(id));
  }

  toJSON() {
    return { pending: this.pending, active: this.active, seq: this.seq };
  }
}