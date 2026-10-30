# Installing Super Download Manager

## Windows

Chrome and Edge on Windows only allow policy installs of store-hosted extensions, unless the PC is joined to a domain or enrolled in management. Windows Home can't be joined, so there are two options:

- **Without Developer mode:** publish `dist/sdm-extension-store-<version>.zip` to Edge Add-ons (free, can be unlisted) or the Chrome Web Store. Install it from the store, then run `Install.cmd -StoreId <store extension ID>` so the native helper accepts the store ID.
- **Right away (Developer mode on):** use the unpacked bundle as described below.

### Install

1. Build the bundle with `npm run build:win`, or use the prebuilt `dist/sdm-windows-<version>.zip`. Extract it.
2. Double-click `Install.cmd`. It needs no admin rights. It copies SDM to `%LOCALAPPDATA%\SDM`, registers the FFmpeg / yt-dlp helper for Chrome, Edge, Chromium and Brave under `HKCU`, and adds an entry to **Installed apps**.
3. Open `edge://extensions` or `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `%LOCALAPPDATA%\SDM\extension`. The installer copies that path to the clipboard. The extension ID is always `beledmllpkkkhpjpidfgeplpncdijegp`.
4. Fully close and reopen the browser.

The optional helper needs Node.js 20 or newer, plus FFmpeg and yt-dlp:

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg yt-dlp.yt-dlp
```

Run `Install.cmd` again after installing these tools. It accepts these options: `-Ffmpeg <path>`, `-Ytdlp <path>`, `-OutputDir <dir>`, `-StoreId <id>`.

### Uninstall

Run `Uninstall.cmd` in `%LOCALAPPDATA%\SDM`, or remove SDM from **Settings → Apps → Installed apps**. Then remove the extension in the browser.

### Test (developers)

```powershell
npm run build:win
npm run test:win -- --extension "$env:LOCALAPPDATA\SDM\extension" --id beledmllpkkkhpjpidfgeplpncdijegp
```

This starts headless Edge and checks the fixed ID, the background worker, the helper connection through the registry entry, and a download to `SDM\Compressed`. Set `--browser` to point at `chrome.exe`, and add `--expect-ffmpeg` when FFmpeg is installed.

## Linux

The `.deb` package installs the extension through browser policy, so it works **without Developer mode**. It also registers the optional native helper for FFmpeg and yt-dlp.

Supported: Debian, Ubuntu, Linux Mint, Kali and other `.deb`-based distributions, with Google Chrome, Chromium, Microsoft Edge or Brave (version 109 or newer). Firefox is not supported.

## 1. Get the package

Use the prebuilt file `dist/sdm-download-manager_<version>_all.deb`, or build it yourself:

```bash
cd sdm-extension
npm run build:deb
```

Building needs Node.js 20 or newer, `zip` and `dpkg-deb`. It writes these files to `dist/`:

| File                                   | Purpose                                     |
| -------------------------------------- | ------------------------------------------- |
| `sdm-download-manager_<version>_all.deb` | The installable package                     |
| `sdm-extension-<version>.crx`          | Signed extension (included in the package)  |
| `sdm-extension-<version>.zip`          | Unsigned extension archive                  |
| `extension-id.txt`                     | The extension ID                            |

Keep `packaging/sdm-extension.pem`. It signs the extension and fixes its ID (`beledmllpkkkhpjpidfgeplpncdijegp`). If it is lost, a new key and a new ID are generated, and existing installs will not update.

## 2. Install

```bash
sudo apt install ./dist/sdm-download-manager_0.5.0_all.deb
```

Then fully close the browser (all windows) and open it again. The extension appears in the toolbar's extension menu. Pin it if you like.

## 3. Install the optional tools

Only needed for merging video and audio, extracting audio, and quality downloads with yt-dlp:

```bash
sudo apt install ffmpeg
node --version                                # must be v20 or newer; older distro packages are too old (use NodeSource or nvm)
pipx install yt-dlp                           # or: uv tool install "yt-dlp[default]"
```

The helper finds `node`, `ffmpeg` and `yt-dlp` on `PATH`, in `~/.local/bin`, in `/usr/local/bin`, and Node.js also in `~/.nvm` and `~/.volta`. To set paths explicitly, edit `/etc/sdm/helper.conf` (all users) or `~/.config/sdm/helper.conf` (one user):

```sh
SDM_NODE=/usr/local/bin/node
SDM_FFMPEG=/usr/bin/ffmpeg          # ffprobe must sit next to it
SDM_YTDLP=/home/me/.local/bin/yt-dlp
SDM_OUTPUT_DIR="$HOME/Downloads"    # root folder for yt-dlp downloads
```

Restart the browser after changing these settings.

## 4. Check that it works

- `chrome://extensions` (or `edge://extensions`, `brave://extensions`) lists **Super Download Manager**. Developer mode can stay off.
- `chrome://policy` lists `ExtensionSettings` with the extension ID.
- In the popup, expand **Download video / audio (yt-dlp)**. The status line should read `Ready · yt-dlp … · FFmpeg …`.

The browser may show **"Managed by your organization"**. This is expected: it is how policy-installed extensions are marked.

## Updating

Build or download the newer `.deb` and install it the same way:

```bash
sudo apt install ./dist/sdm-download-manager_<new-version>_all.deb
```

The browser picks up the new version on restart. Your settings in `/etc/sdm/helper.conf` are kept.

To update yt-dlp when YouTube downloads start failing:

```bash
pipx upgrade yt-dlp                            # or: uv tool upgrade yt-dlp
```

## Uninstalling

```bash
sudo apt remove sdm-download-manager           # keeps /etc/sdm/helper.conf
sudo apt purge sdm-download-manager            # also removes /etc/sdm/helper.conf
```

Restart the browser afterwards to unload the extension.

## Troubleshooting

| Problem                                         | Fix                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension does not appear                       | Close every browser window (check for a background process with `pgrep -a chrome`), then reopen. Check `chrome://policy` and click **Reload policies**. |
| Helper status says FFmpeg or yt-dlp not found   | Install them (step 3), or set `SDM_FFMPEG` / `SDM_YTDLP` in `~/.config/sdm/helper.conf`, then restart the browser.                          |
| Helper status says Node.js not found            | Install Node.js 20 or newer, or set `SDM_NODE` in `~/.config/sdm/helper.conf`.                                                               |
| Helper does not work in Brave                   | The package does not register the helper for Brave. Run `node native/install.mjs --extension-id beledmllpkkkhpjpidfgeplpncdijegp --browser brave`. |
| Browser installed as Snap or Flatpak            | Sandboxed browsers may not read the `/etc` policy and native-host files (untested). Use the `.deb` version of the browser, or load the extension unpacked (see `README.md`). |

To see the helper's own error messages, run it directly:

```bash
/opt/sdm/bin/sdm-ffmpeg-host </dev/null
```

## Testing the package (developers)

```bash
npm run test:deb
```

This installs the `.deb` into a temporary root inside a user namespace (no `sudo`), starts headless Chrome against the policy files, and checks that the extension loads with Developer mode off, reaches the native helper, saves a download, and that remove and purge clean up. It needs Google Chrome, Node.js and `unshare`. FFmpeg and yt-dlp must be on `PATH` for the helper checks to pass.

`packaging/test-deb.sh` runs the same test in a Docker container with a real `dpkg -i`.