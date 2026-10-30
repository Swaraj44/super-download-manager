# Installing Personal Download Manager on Linux

The `.deb` package installs the extension through browser policy, so it works **without Developer mode**. It also registers the optional native helper for FFmpeg and yt-dlp.

Supported: Debian, Ubuntu, Linux Mint, Kali and other `.deb`-based distributions, with Google Chrome, Chromium, Microsoft Edge or Brave (version 109 or newer). Firefox is not supported.

## 1. Get the package

Use the prebuilt file `dist/pdm-download-manager_<version>_all.deb`, or build it yourself:

```bash
cd pdm-extension
npm run build:deb
```

Building needs Node.js 20 or newer, `zip` and `dpkg-deb`. It writes these files to `dist/`:

| File                                   | Purpose                                     |
| -------------------------------------- | ------------------------------------------- |
| `pdm-download-manager_<version>_all.deb` | The installable package                     |
| `pdm-extension-<version>.crx`          | Signed extension (included in the package)  |
| `pdm-extension-<version>.zip`          | Unsigned extension archive                  |
| `extension-id.txt`                     | The extension ID                            |

Keep `packaging/pdm-extension.pem`. It signs the extension and fixes its ID (`beledmllpkkkhpjpidfgeplpncdijegp`). If it is lost, a new key and a new ID are generated, and existing installs will not update.

## 2. Install

```bash
sudo apt install ./dist/pdm-download-manager_0.5.0_all.deb
```

Then fully close the browser (all windows) and open it again. The extension appears in the toolbar's extension menu. Pin it if you like.

## 3. Install the optional tools

Only needed for merging video and audio, extracting audio, and quality downloads with yt-dlp:

```bash
sudo apt install ffmpeg
node --version                                # must be v20 or newer; older distro packages are too old (use NodeSource or nvm)
pipx install yt-dlp                           # or: uv tool install "yt-dlp[default]"
```

The helper finds `node`, `ffmpeg` and `yt-dlp` on `PATH`, in `~/.local/bin`, in `/usr/local/bin`, and Node.js also in `~/.nvm` and `~/.volta`. To set paths explicitly, edit `/etc/pdm/helper.conf` (all users) or `~/.config/pdm/helper.conf` (one user):

```sh
PDM_NODE=/usr/local/bin/node
PDM_FFMPEG=/usr/bin/ffmpeg          # ffprobe must sit next to it
PDM_YTDLP=/home/me/.local/bin/yt-dlp
PDM_OUTPUT_DIR="$HOME/Downloads"    # root folder for yt-dlp downloads
```

Restart the browser after changing these settings.

## 4. Check that it works

- `chrome://extensions` (or `edge://extensions`, `brave://extensions`) lists **Personal Download Manager**. Developer mode can stay off.
- `chrome://policy` lists `ExtensionSettings` with the extension ID.
- In the popup, expand **Download video / audio (yt-dlp)**. The status line should read `Ready · yt-dlp … · FFmpeg …`.

The browser may show **"Managed by your organization"**. This is expected: it is how policy-installed extensions are marked.

## Updating

Build or download the newer `.deb` and install it the same way:

```bash
sudo apt install ./dist/pdm-download-manager_<new-version>_all.deb
```

The browser picks up the new version on restart. Your settings in `/etc/pdm/helper.conf` are kept.

To update yt-dlp when YouTube downloads start failing:

```bash
pipx upgrade yt-dlp                            # or: uv tool upgrade yt-dlp
```

## Uninstalling

```bash
sudo apt remove pdm-download-manager           # keeps /etc/pdm/helper.conf
sudo apt purge pdm-download-manager            # also removes /etc/pdm/helper.conf
```

Restart the browser afterwards to unload the extension.

## Troubleshooting

| Problem                                         | Fix                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension does not appear                       | Close every browser window (check for a background process with `pgrep -a chrome`), then reopen. Check `chrome://policy` and click **Reload policies**. |
| Helper status says FFmpeg or yt-dlp not found   | Install them (step 3), or set `PDM_FFMPEG` / `PDM_YTDLP` in `~/.config/pdm/helper.conf`, then restart the browser.                          |
| Helper status says Node.js not found            | Install Node.js 20 or newer, or set `PDM_NODE` in `~/.config/pdm/helper.conf`.                                                               |
| Helper does not work in Brave                   | The package does not register the helper for Brave. Run `node native/install.mjs --extension-id beledmllpkkkhpjpidfgeplpncdijegp --browser brave`. |
| Browser installed as Snap or Flatpak            | Sandboxed browsers may not read the `/etc` policy and native-host files (untested). Use the `.deb` version of the browser, or load the extension unpacked (see `README.md`). |

To see the helper's own error messages, run it directly:

```bash
/opt/pdm/bin/pdm-ffmpeg-host </dev/null
```

## Testing the package (developers)

```bash
npm run test:deb
```

This installs the `.deb` into a temporary root inside a user namespace (no `sudo`), starts headless Chrome against the policy files, and checks that the extension loads with Developer mode off, reaches the native helper, saves a download, and that remove and purge clean up. It needs Google Chrome, Node.js and `unshare`. FFmpeg and yt-dlp must be on `PATH` for the helper checks to pass.

`packaging/test-deb.sh` runs the same test in a Docker container with a real `dpkg -i`.