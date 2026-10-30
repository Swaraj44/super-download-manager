import { DEFAULT_SETTINGS } from "./lib/settings.js";

const form = document.getElementById("options");
const statusEl = document.getElementById("status");

function fill(s) {
  form.enabled.checked = s.enabled;
  form.useCategoryFolders.checked = s.useCategoryFolders;
  form.mediaButton.checked = s.mediaButton;
  form.baseFolder.value = s.baseFolder;
  form.minSizeKB.value = s.minSizeKB;
  form.maxConcurrent.value = s.maxConcurrent;
  form.fileTypes.value = s.fileTypes.join(" ");
  form.excludedSites.value = s.excludedSites.join("\n");
}

function read() {
  return {
    enabled: form.enabled.checked,
    useCategoryFolders: form.useCategoryFolders.checked,
    mediaButton: form.mediaButton.checked,
    baseFolder: form.baseFolder.value,
    minSizeKB: form.minSizeKB.value,
    maxConcurrent: form.maxConcurrent.value,
    fileTypes: form.fileTypes.value,
    excludedSites: form.excludedSites.value,
  };
}

function showStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
  if (!isError) setTimeout(() => { statusEl.textContent = ""; }, 2000);
}

async function save(patch) {
  const res = await chrome.runtime.sendMessage({ type: "sdm:setSettings", patch });
  if (!res?.ok) return showStatus(res?.error || "Save failed", true);
  fill(res.result);
  showStatus("Saved");
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  save(read());
});

document.getElementById("reset").addEventListener("click", () => save({ ...DEFAULT_SETTINGS }));

const res = await chrome.runtime.sendMessage({ type: "sdm:getState" });
if (res?.ok) fill(res.result.settings);
else showStatus(res?.error || "Could not load settings", true);