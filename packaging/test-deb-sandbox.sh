#!/bin/sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
DEB=$(ls "$ROOT"/dist/pdm-download-manager_*_all.deb | tail -1)
ID=$(cat "$ROOT/dist/extension-id.txt")
R=$(mktemp -d /tmp/pdm-deb-root.XXXXXX)
trap 'rm -rf "$R"' EXIT

mkdir -p "$R/var/lib/dpkg/info" "$R/var/lib/dpkg/updates"
touch "$R/var/lib/dpkg/status" "$R/var/lib/dpkg/available"
DPKG="dpkg --root=$R --force-not-root --force-script-chrootless --log=/dev/null"

echo "== install"
unshare -r $DPKG -i "$DEB"
for f in etc/opt/chrome/policies/managed/pdm-download-manager.json \
         etc/opt/chrome/native-messaging-hosts/com.pdm.ffmpeg.json \
         opt/pdm/pdm.crx opt/pdm/updates.xml opt/pdm/bin/pdm-ffmpeg-host; do
  test -e "$R/$f" || { echo "FAIL missing /$f"; exit 1; }
done
echo "PASS package files installed"

echo "== browser test (private mount namespace)"
for d in /opt/*/; do
  n=$(basename "$d")
  [ "$n" = pdm ] || mkdir -p "$R/opt/$n"
done
unshare -r -m sh -c '
  set -e
  R=$1; ID=$2; HERE=$3
  for d in /opt/*/; do mount --bind "$d" "$R/opt/$(basename "$d")"; done
  mount --rbind "$R/opt" /opt
  mount --bind "$R/etc/opt" /etc/opt
  PDM_CHROME_ARGS=--no-sandbox node "$HERE/test/e2e.mjs" "$ID"
' sh "$R" "$ID" "$HERE"

echo "== remove"
unshare -r $DPKG -r pdm-download-manager
for f in etc/opt/chrome/policies/managed/pdm-download-manager.json \
         etc/opt/chrome/native-messaging-hosts/com.pdm.ffmpeg.json opt/pdm/pdm.crx; do
  test ! -e "$R/$f" || { echo "FAIL still present after remove: /$f"; exit 1; }
done
test -e "$R/etc/pdm/helper.conf" || { echo "FAIL conffile removed before purge"; exit 1; }
unshare -r $DPKG --purge pdm-download-manager
test ! -e "$R/etc/pdm/helper.conf" || { echo "FAIL conffile left after purge"; exit 1; }
echo "PASS remove and purge clean up"
echo "DEB TEST PASSED"