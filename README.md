# Super Download Manager

Developed by Swaraj.

A lightweight Manifest V3 browser extension for Chrome and Edge. It captures browser downloads that match your rules, sorts them into category folders and runs manual downloads through a queue with a concurrency limit. Everything is built on the `chrome.downloads` API. An optional native helper adds FFmpeg (merge, extract audio) and yt-dlp (pick-your-quality video + audio, or audio only).


## Quick Start

On Debian/Ubuntu-based Linux, install the `.deb` package instead. It works without Developer mode. See [INSTALL.md](INSTALL.md).

For development (unpacked extension):

```bash
# 1. Tools (yt-dlp as a user tool; FFmpeg from your package manager or a static build)
uv tool install "yt-dlp[default]"          # or: pipx install yt-dlp
sudo apt install ffmpeg                     # or copy static ffmpeg + ffprobe into ~/.local/bin

# 2. Load the extension: chrome://extensions → Developer mode → Load unpacked → sdm-extension
#    Copy the 32-letter extension ID.

# 3. Register the native helper, then fully restart the browser
cd sdm-extension
node native/install.mjs --extension-id <ID> \
  --ffmpeg "$(command -v ffmpeg)" \
  --ytdlp ~/.local/bin/yt-dlp \
  --output-dir ~/Downloads                  # add --browser all for Chromium, Brave and Edge

# 4. Optional checks
npm run check
SDM_FFMPEG="$(command -v ffmpeg)" npm test
SDM_FFMPEG="$(command -v ffmpeg)" SDM_YTDLP=~/.local/bin/yt-dlp \
  npm run ytdlp-live -- "https://www.youtube.com/watch?v=DS-raAyMxl4"
```

In the popup, expand **Download video / audio (yt-dlp)**. The status line should read `Ready · yt-dlp … · FFmpeg …`.

The design is informed by a static analysis of IDM's browser integration. That analysis covered its `Content-Type` and `Content-Disposition` classification, its MIME-to-extension table, how it skips stream manifests, its file-type and site-exclusion lists, and how it hooks `onDeterminingFilename`. All code here is original.

## Project Structure

```
sdm-extension/
├── manifest.json            # MV3 manifest: permissions, service worker, popup, options page
├── package.json             # npm scripts: test, smoke, integration, ytdlp-live, check
├── README.md
├── src/
│   ├── background.js        # Service worker: capture, category folders, queue, messages
│   ├── popup.html/.css/.js  # Toolbar popup: add URL, queue, download list, capture toggle
│   ├── options.html/.css/.js# Options page
│   ├── convert-panel.js     # Popup panel: merge video + audio, extract audio
│   ├── yt-panel.js          # Popup panel: yt-dlp formats, quality/format choice, progress
│   ├── content/
│   │   └── media-button.js  # Floating Download button over video/audio players
│   └── lib/
│       ├── mime.js          # MIME and extension detection, stream-manifest types
│       ├── categories.js    # Category table, filename sanitizing, target path building
│       ├── rules.js         # URL validation, site patterns, capture decision
│       ├── settings.js      # Defaults, normalization and validation, storage load and save
│       ├── queue.js         # Download queue with concurrency and persistence
│       ├── media.js         # Media response classification, per-tab dedupe, button menu
│       ├── convert.js       # Convert request validation, track pairing, container choice
│       ├── native.js        # Native-messaging client (request ids, progress, timeouts)
│       ├── ytdlp.js         # yt-dlp request validation, presets, YouTube page detection
│       └── format.js        # Byte formatting, display names, metadata keys
├── native/
│   ├── sdm-ffmpeg-host.mjs  # Native-messaging host (stdio) that runs ffmpeg and yt-dlp
│   ├── ffmpeg-host-lib.mjs  # Framing, argument building, fallback plans, job queues
│   ├── ytdlp-lib.mjs        # yt-dlp arguments, progress parsing, format summary, output paths
│   └── install.mjs          # Registers the host with Chrome, Chromium, Brave or Edge
├── tests/
│   ├── helpers/chrome-mock.js  # In-memory chrome.* mock that loads background.js
│   ├── *.test.js               # Unit tests for each lib module, plus background tests
└── scripts/
    ├── smoke.mjs               # End-to-end test in real headless Chrome
    ├── youtube-integration.mjs # YouTube capture test against a local fake YouTube
    └── ytdlp-live.mjs          # Real yt-dlp + FFmpeg downloads through the native host
```

## How It Works

**Capture.** `downloads.onDeterminingFilename` checks every browser download in this order. A download is captured only if it passes all the checks:

1. Capture is enabled.
2. The URL uses `http` or `https`.
3. Neither the URL nor the referrer matches an excluded site.
4. The file is not a stream manifest (`m3u8`, `mpd` or `f4m`).
5. The file type is in your list. The type is taken from the filename, then the URL, then the MIME type.
6. The size is at least the minimum, when the size is known.

A captured download is saved to `<base folder>/<Category>/<file>`. A download that isn't captured goes to Chrome's default location unchanged.

**Queue.** URLs added from the popup or the context menu are queued. They start when fewer than *max simultaneous* SDM downloads are running. The queue is saved in `chrome.storage.local`, so it survives service-worker restarts.

**Categories.** The categories are Compressed, Documents, Music, Video, Programs, Images and Other. The popup shows each download's category as a tag.

**Media button.** A content script draws a floating **Download** button over any visible `<video>` or `<audio>` element when you hover it or start playback. Meanwhile, the background watches response headers (`webRequest.onHeadersReceived`) for each tab and records video and audio responses. It ignores responses under 100 KB, HLS/DASH segments (`ts`, `m4s`) and non-media types, and it strips byte-range query parameters so partial requests collapse into one entry. Clicking the button lists:

1. The player's own `http(s)` sources, marked **player**.
2. Other sniffed media in the tab, largest first. This finds the real file when the player uses a `blob:` URL.
3. Stream playlists (`m3u8`, `mpd`), shown but disabled, because stream downloading is not supported yet.

**YouTube.** IDM handles YouTube natively in `IDMNetMon` (a `YouTubeParser` keyed on `googlevideo.com/videoplayback`, `itag=` and `clen=`), not in its browser extension. SDM uses the same passive approach. It watches the `videoplayback` requests the player already makes and reads `itag` (format and quality), `mime` and `clen` (full size). It also removes the byte-range parameters (`range`, `rn`, `rbuf`, `ump`, `srfvp`), which turns a segment request into a URL for the whole stream. Requests are grouped by video `id` and `itag`, and the menu shows only the most recently played video. If you pick a video-only (adaptive) track, SDM also queues the best audio track for the same video. Files are named after the page title, for example `Title [1080p video].mp4` and `Title [128k audio].m4a`. The extension itself does not mux, so the video and audio are two separate files. Join them with the optional FFmpeg helper (below).

YouTube limitations:

- SDM can't download videos streamed with SABR (`sabr=1`, POST requests). It also doesn't copy IDM's client impersonation or its PO-token handling. When SDM sees SABR traffic in a tab, the menu says so directly instead of asking you to keep playing.
- Captured URLs expire after a few hours.

Limitation: other players that stream through Media Source Extensions with segmented or DRM-protected requests, such as Netflix, don't expose a downloadable file. For these, the menu explains why instead of listing sources.

Picking an entry sends it through the queue, so it is saved to `<base folder>/Video/` or `/Music/`. The list is cleared when the tab navigates or closes.

**FFmpeg helper (optional).** A native-messaging host (`native/sdm-ffmpeg-host.mjs`, host name `com.sdm.ffmpeg`) lets the popup run FFmpeg on finished downloads:

- **Merge** a video file and an audio file into MP4, MKV or WebM. The format defaults to one that allows a stream copy (MP4 for `mp4` + `m4a`, WebM for `webm` + `weba`, otherwise MKV). If a copy fails, the host retries with re-encoded audio, then with re-encoded video (MP4 and WebM only).
- **Extract audio** to MP3, M4A or Opus. M4A and Opus try a stream copy first.

The output is saved next to the source. SDM's track tags are dropped (`Cats [1080p video].mp4` + `Cats [128k audio].m4a` become `Cats [1080p].mp4`), and an existing file is never overwritten: the host picks `name (1).ext` and runs FFmpeg with `-n`. The popup refers to files by download ID; the background resolves them to paths only for finished downloads that still exist. The host accepts only absolute paths to existing files with media extensions, runs FFmpeg without a shell, prefixes paths with `file:`, runs one job at a time and reports progress.

**yt-dlp downloads (optional, recommended for YouTube).** The same native helper can run yt-dlp, which downloads separate best-quality video and audio streams and merges them with FFmpeg into a single file. This avoids the SABR, signature and PO-token limits of passive capture. You can use it in two places:

- **Player button on YouTube:** one-click presets: Best MP4, 1080p MP4, 720p MP4, Best MKV (AV1/VP9), Audio M4A, Audio MP3. Captured streams are still listed below the presets.
- **Popup → Download video / audio (yt-dlp):** paste or prefill a URL, click **Get formats** to list the real resolutions, codecs and approximate sizes, then choose:
  - **Video + audio**, with a quality setting and MP4 (H.264/AAC), MKV (best codec) or WebM (VP9/Opus).
  - **Audio only**, as M4A or Opus (both without re-encoding), MP3, or the original stream.

Files go to `<output dir>/<base folder>/Video` or `/Music`. The output dir defaults to `~/Downloads`; set it with `--output-dir`. yt-dlp runs with `--ignore-config --no-playlist --no-overwrites` and receives the URL after `--`. Node is passed in as its JavaScript runtime. Page buttons can only start downloads for the YouTube tab they run in.

Which option to pick:

| Goal                               | Choice                  | Why                                    |
| ---------------------------------- | ----------------------- | -------------------------------------- |
| Plays everywhere                   | Video + audio, MP4      | H.264 + AAC, stream copy, no re-encode |
| Smallest file for the same quality | Video + audio, MKV      | Keeps AV1/VP9 + Opus                   |
| Browser-native open format         | Video + audio, WebM     | VP9 + Opus                             |
| Music, best quality                | Audio only, M4A or Opus | Original stream, no re-encode          |
| Music for old players              | Audio only, MP3         | Re-encoded at the highest VBR quality  |

Format selection sorts by resolution first, then codec (`-S res:1080,vcodec:h264,acodec:aac`). Putting the codec first would make yt-dlp pick YouTube's single-file 360p stream.

**Message security.** The background accepts messages only from this extension. Popup and options actions (`sdm:add`, `sdm:getState`, `sdm:setSettings`, `sdm:removeJob`, `sdm:converterStatus`, `sdm:convert`, `sdm:cancelConvert`, `sdm:ytProbe`) are rejected when they come from a content script. Web pages can only ask for the media list, queue `http(s)` media, and, on a YouTube video page, list yt-dlp presets (`sdm:ytPresets`) and start a yt-dlp download (`sdm:ytDownload`) for that tab's own URL; any URL the page sends is ignored.

## Requirements

- Chrome or Edge, version 109 or newer
- Node.js 20 or newer, for running the tests and the optional native helper. There is no build step and there are no npm dependencies.
- FFmpeg (with `ffprobe`), only for the optional helper (`sudo apt install ffmpeg`, `brew install ffmpeg`, or a static build).
- yt-dlp, only for quality downloads (`uv tool install "yt-dlp[default]"`, `pipx install yt-dlp` or `brew install yt-dlp`). Keep it current: YouTube changes often.

## How to Run

1. Open `chrome://extensions`, or `edge://extensions` in Edge.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `sdm-extension` folder.
4. Optionally, pin the extension to the toolbar.

After you change any file, click **Reload** on the extension card.

### Installing the native helper (FFmpeg + yt-dlp)

Copy the extension ID from `chrome://extensions`, then run (Linux or macOS):

```bash
node native/install.mjs --extension-id <id>                      # Chrome, ffmpeg and yt-dlp from PATH
node native/install.mjs --extension-id <id> --browser all --ffmpeg /path/to/ffmpeg
node native/install.mjs --extension-id <id> --ytdlp ~/.local/bin/yt-dlp --output-dir ~/Downloads
node native/install.mjs --uninstall --browser all
```

| Option                             | Default                                          | Notes                                                          |
| ---------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `--extension-id <id>`            | required                                         | 32 letters a–p, from `chrome://extensions`                  |
| `--ffmpeg <path>`                | `ffmpeg` on PATH                               | `ffprobe` must sit next to it for audio extraction           |
| `--ytdlp <path>`                 | `yt-dlp` on PATH, then `~/.local/bin/yt-dlp` | Optional; without it the yt-dlp panel and presets are disabled |
| `--output-dir <dir>`             | `~/Downloads`                                  | Root folder for yt-dlp downloads                               |
| `--browser <list>`               | `chrome`                                       | `chrome`, `chromium`, `brave`, `edge` or `all`       |
| `--manifest-dir`, `--data-dir` | browser folder, `~/.local/share/sdm-ffmpeg`    | Overrides for unusual setups                                   |

The installer checks that FFmpeg and yt-dlp run, writes a launcher to `~/.local/share/sdm-ffmpeg/` (macOS: `~/Library/Application Support/SDM/`) that exports `SDM_FFMPEG`, `SDM_YTDLP` and `SDM_OUTPUT_DIR`, and registers `com.sdm.ffmpeg.json` in the browser's `NativeMessagingHosts` folder, allowing only your extension ID. Fully restart the browser afterwards.

The launcher stores absolute paths to Node, FFmpeg and yt-dlp. Run the installer again after you move the `sdm-extension` folder, switch Node versions (for example with nvm), move FFmpeg or yt-dlp, or get a new extension ID.

### Maintenance

```bash
uv tool upgrade yt-dlp                               # when YouTube downloads start failing (or: pipx upgrade yt-dlp)
node native/install.mjs --extension-id <id> ...      # after moving folders or changing Node
node native/install.mjs --uninstall --browser all    # remove the helper
```

### Tests

```bash
npm test          # 108 unit, background, FFmpeg host and yt-dlp tests (node:test, chrome mock)
npm run smoke     # end-to-end test in headless Chrome (set CHROME_BIN to override the binary)
npm run integration # YouTube capture test in headless Chrome against a local fake YouTube (needs openssl)
npm run check     # syntax check of all JS files and the manifest
npm run ytdlp-live -- <url>  # real yt-dlp + FFmpeg downloads through the host (needs SDM_FFMPEG, SDM_YTDLP)
```

The FFmpeg host tests generate small fixtures with FFmpeg and run real merges and extractions. They are skipped when FFmpeg is not found; point them at a binary with `SDM_FFMPEG=/path/to/ffmpeg npm test`. The yt-dlp unit tests need no network.

`npm run ytdlp-live` starts the real native host, pings it, reads the format list, then downloads 1080p MP4, 480p WebM, M4A audio and MP3 audio, and checks each output's streams with `ffprobe`. It needs network access, `SDM_FFMPEG` and `SDM_YTDLP`, and writes to `SDM_OUTPUT_DIR` (default: a new temp folder).

The smoke test does the following:

1. Starts a local HTTP server.
2. Loads the extension into a temporary Chrome profile through CDP's `Extensions.loadUnpacked`.
3. Checks that a manually added download is saved to `SDM/Compressed/`.
4. Checks that a captured browser download is saved to `SDM/Compressed/`.
5. Checks that downloads go to the default folder when capture is off.
6. Opens a page with a `<video>`, hovers it, clicks the **Download** button, checks that the menu lists the source with its sniffed size, and checks that picking it saves `SDM/Video/clip.mp4`.
7. Checks that the options page loads.

## How to Use

- **Download from a page.** Right-click a link, image, video or audio element and choose **Download with SDM**.
- **Download by URL.** Open the popup, paste a URL and click **Add**. Only `http`, `https` and `data` URLs are accepted.
- **Download video or audio from a page.** Hover a player (or start playing it). Click the blue **Download** button in its top-right corner and pick a source from the list. If the list is empty, start playback and click again. Pages that were open before the extension was installed or reloaded need a refresh.
- **Download YouTube in a chosen quality (yt-dlp).** On a YouTube video page, click the player's **Download** button and pick a preset under **yt-dlp + FFmpeg**. Or open the popup, expand **Download video / audio (yt-dlp)** (the URL is prefilled from the active tab), click **Get formats**, choose **Video + audio** with a quality and format or **Audio only** with an audio format, then click **Download**. Progress (Downloading, Merging, Converting audio) shows in the panel, and running jobs can be cancelled. Playlist URLs download only the selected video.
- **Merge video and audio, or extract audio.** Install the native helper, then open the popup and expand **Merge / extract audio (FFmpeg)**. The status line shows whether the helper and FFmpeg were found. For YouTube downloads, the matching video and audio tracks are preselected. Pick a format and click **Merge** or **Extract**. Progress shows in the panel, and running jobs can be cancelled.
- **Automatic capture.** Click a download link as usual. Matching files are saved to category folders. Use the popup's **Capture** checkbox to turn this on or off.
- **Queue.** Queued URLs are listed under **Queued** in the popup. Click **Remove** to drop a URL before it starts.
- **Manage downloads.** The controls depend on each download's state:

| State                   | Actions                      |
| ----------------------- | ---------------------------- |
| Downloading             | Pause, Cancel                |
| Paused                  | Resume, Cancel               |
| Interrupted (resumable) | Resume, Remove               |
| Completed               | Open, Show in folder, Remove |

**Remove** deletes the entry from the download history. The file stays on disk.

### Options

Click **Options** in the popup, or right-click the extension icon and choose **Options**.

| Setting                    | Default                                          | Notes                                                                                |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Capture browser downloads  | On                                               |                                                                                      |
| File types                 | Common archives, documents, media and installers | Separate entries with spaces or commas. `.zip` and `*.zip` are accepted.         |
| Minimum size (KB)          | 0                                                | Downloads of unknown size are always captured.                                       |
| Excluded sites             | none                                             | One per line, for example `example.com`, `*.cdn.net` or `example.com/media/*`. |
| Base folder                | `SDM`                                          | A folder inside Downloads. Leave it empty to use the Downloads folder itself.        |
| Category folders           | On                                               |                                                                                      |
| Media Download button      | On                                               | Also turns media sniffing off when disabled.                                         |
| Max simultaneous downloads | 3                                                | 1 to 10                                                                              |

## Roadmap

- [X] Basic scaffold: context menu, add by URL, download list and controls
- [X] Automatic capture of browser downloads, filtered by file type and size
- [X] Options page for file types, excluded sites, save folder and on/off toggle
- [X] Download queue with a concurrency limit
- [X] Category folders
- [X] Media Download button on video and audio players (content script and `webRequest`)
- [X] Optional FFmpeg native-messaging helper: merge video and audio, extract audio
- [X] yt-dlp downloads with selectable quality, video + audio or audio only
- [ ] HLS/DASH stream downloading for non-YouTube sites
- [ ] Scheduled queue start
- [ ] Optional native-messaging host for multi-connection downloads
