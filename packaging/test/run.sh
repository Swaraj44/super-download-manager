#!/bin/sh
set -eu
DEB=$1
ID=$2

echo "== install"
dpkg -i "$DEB"
for f in /etc/opt/chrome/policies/managed/pdm-download-manager.json \
         /etc/opt/chrome/native-messaging-hosts/com.pdm.ffmpeg.json \
         /opt/pdm/pdm.crx /opt/pdm/updates.xml /opt/pdm/bin/pdm-ffmpeg-host; do
  test -e "$f" || { echo "FAIL missing $f"; exit 1; }
done
echo "PASS package files installed"

echo "== browser test (user: tester)"
runuser -u tester -- node /test/e2e.mjs "$ID"

echo "== remove"
dpkg -r pdm-download-manager
for f in /etc/opt/chrome/policies/managed/pdm-download-manager.json \
         /etc/opt/chrome/native-messaging-hosts/com.pdm.ffmpeg.json /opt/pdm/pdm.crx; do
  test ! -e "$f" || { echo "FAIL still present after remove: $f"; exit 1; }
done
test -e /etc/pdm/helper.conf || { echo "FAIL conffile removed before purge"; exit 1; }
dpkg --purge pdm-download-manager
test ! -e /etc/pdm/helper.conf || { echo "FAIL conffile left after purge"; exit 1; }
echo "PASS remove and purge clean up"
echo "DEB TEST PASSED"