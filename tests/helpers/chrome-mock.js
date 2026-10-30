export function createChromeMock({
  extensionId = "pdm-test", inProgress = [], local = {}, sync = {}, session = {}, failUrls = [], downloadItems = [], nativeHost = null,
} = {}) {
  const listeners = {};
  const event = (name) => {
    listeners[name] = [];
    return { addListener: (fn) => listeners[name].push(fn) };
  };

  const storageEvent = event("storage.onChanged");

  const area = (areaName, initial) => {
    const data = structuredClone(initial);
    return {
      data,
      async get(keys) {
        if (keys == null) return structuredClone(data);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
          data[k] = structuredClone(v);
        }
        for (const fn of listeners["storage.onChanged"]) fn(changes, areaName);
      },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      },
    };
  };

  const calls = { downloads: [], menus: [], badge: [], tabMessages: [], webRequestFilters: [], native: [], nativeMessages: [] };

  const connectNative = (name) => {
    calls.native.push(name);
    const onMsg = [];
    const onDisc = [];
    let open = true;
    const handler = nativeHost?.((reply) => setImmediate(() => open && onMsg.forEach((fn) => fn(structuredClone(reply)))));
    if (!handler) {
      setImmediate(() => {
        open = false;
        chrome.runtime.lastError = { message: "Specified native messaging host not found." };
        onDisc.forEach((fn) => fn());
        delete chrome.runtime.lastError;
      });
    }
    return {
      onMessage: { addListener: (fn) => onMsg.push(fn) },
      onDisconnect: { addListener: (fn) => onDisc.push(fn) },
      postMessage(msg) {
        if (!open) throw new Error("Attempting to use a disconnected port object");
        calls.nativeMessages.push(structuredClone(msg));
        if (handler) setImmediate(() => handler(structuredClone(msg)));
      },
      disconnect() {
        open = false;
      },
    };
  };
  let nextId = 100;
  const baseUrl = `chrome-extension://${extensionId}/`;

  const webRequestEvent = (name) => {
    listeners[name] = [];
    return {
      addListener: (fn, filter, extra) => {
        listeners[name].push(fn);
        calls.webRequestFilters.push({ name, filter, extra });
      },
    };
  };

  const chrome = {
    runtime: {
      id: extensionId,
      getURL: (path = "") => baseUrl + String(path).replace(/^\//, ""),
      onInstalled: event("runtime.onInstalled"),
      onMessage: event("runtime.onMessage"),
      connectNative,
    },
    contextMenus: { create: (opts) => calls.menus.push(opts), onClicked: event("contextMenus.onClicked") },
    action: { setBadgeText: async ({ text }) => { calls.badge.push(text); } },
    storage: {
      local: area("local", local),
      sync: area("sync", sync),
      session: area("session", session),
      onChanged: storageEvent,
    },
    tabs: {
      async sendMessage(tabId, msg) {
        calls.tabMessages.push({ tabId, msg });
      },
      onRemoved: event("tabs.onRemoved"),
    },
    webRequest: { onHeadersReceived: webRequestEvent("webRequest.onHeadersReceived") },
    downloads: {
      async download(opts) {
        calls.downloads.push(opts);
        if (failUrls.includes(opts.url)) throw new Error("Download failed");
        return nextId++;
      },
      async search(query = {}) {
        if (query && "id" in query) return structuredClone(downloadItems.filter((d) => d.id === query.id));
        return structuredClone(inProgress);
      },
      onDeterminingFilename: event("downloads.onDeterminingFilename"),
      onChanged: event("downloads.onChanged"),
      onErased: event("downloads.onErased"),
    },
  };

  const senders = {
    popup: { id: extensionId, url: `${baseUrl}src/popup.html` },
    tab: (tabId, url = "https://video.example.com/watch") => ({ id: extensionId, url, tab: { id: tabId, url } }),
    foreign: { id: "someone-else", url: "https://evil.example.com/" },
  };

  const emit = (name, ...args) => Promise.all(listeners[name].map((fn) => fn(...args)));

  const sendMessage = (msg, sender = senders.popup) =>
    new Promise((resolve) => {
      for (const fn of listeners["runtime.onMessage"]) fn(msg, sender, resolve);
    });

  const determine = (item) =>
    new Promise((resolve) => {
      for (const fn of listeners["downloads.onDeterminingFilename"]) fn(item, (s) => resolve(s));
    });

  const flush = () => new Promise((r) => setImmediate(r));

  return { chrome, calls, emit, sendMessage, determine, listeners, senders, flush };
}

let instance = 0;

export async function loadBackground(options) {
  const mock = createChromeMock(options);
  globalThis.chrome = mock.chrome;
  await import(`../../src/background.js?instance=${++instance}`);
  await mock.sendMessage({ type: "pdm:getState" });
  return mock;
}