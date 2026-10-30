export const NATIVE_HOST = "com.pdm.ffmpeg";

export function createNativeClient(connect, lastError = () => "") {
  let port = null;
  let seq = 0;
  const pending = new Map();

  function idle() {
    if (!port || pending.size) return;
    const p = port;
    port = null;
    try {
      p.disconnect();
    } catch {
      // Already closed.
    }
  }

  function fail(err) {
    const list = [...pending.values()];
    pending.clear();
    port = null;
    for (const e of list) {
      clearTimeout(e.timer);
      e.reject(err);
    }
  }

  function open() {
    if (port) return port;
    const p = connect();
    p.onMessage.addListener((msg) => {
      const e = pending.get(msg?.id);
      if (!e) return;
      if (msg.type === "progress") {
        e.onEvent?.(msg);
        return;
      }
      pending.delete(msg.id);
      clearTimeout(e.timer);
      if (msg.type === "error") e.reject(new Error(msg.error || "FFmpeg helper error"));
      else e.resolve(msg);
      idle();
    });
    p.onDisconnect.addListener(() => {
      if (port === p) fail(new Error(lastError() || "FFmpeg helper exited"));
    });
    port = p;
    return p;
  }

  function request(msg, { onEvent, timeout = 0 } = {}) {
    const id = typeof msg?.id === "string" ? msg.id : `n${++seq}`;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, onEvent, timer: 0 };
      pending.set(id, entry);
      if (timeout) {
        entry.timer = setTimeout(() => {
          if (pending.get(id) !== entry) return;
          pending.delete(id);
          reject(new Error("FFmpeg helper did not respond"));
          idle();
        }, timeout);
      }
      try {
        open().postMessage({ ...msg, id });
      } catch (err) {
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(err);
        idle();
      }
    });
  }

  return {
    request,
    get connected() {
      return Boolean(port);
    },
  };
}