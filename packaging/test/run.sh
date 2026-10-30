#!/bin/sh
set -eu
DEB=$1
ID=$2

echo "== install"
dpkg -i "$DEB"
for f in /etc/opt/chrome/policies/managed/sdm-download-manager.json \
         /etc/opt/chrome/native-messaging-hosts/com.sdm.ffmpeg.json \
         /opt/sdm/sdm.crx /opt/sdm/updates.xml /opt/sdm/bin/sdm-ffmpeg-host; do
  test -e "$f" || { echo "FAIL missing $f"; exit 1; }
done
echo "PASS package files installed"

echo "== browser test (user: tester)"
runuser -u tester -- node /test/e2e.mjs "$ID"

echo "== remove"
dpkg -r sdm-download-manager
for f in /etc/opt/chrome/policies/managed/sdm-download-manager.json \
         /etc/opt/chrome/native-messaging-hosts/com.sdm.ffmpeg.json /opt/sdm/sdm.crx; do
  test ! -e "$f" || { echo "FAIL still present after remove: $f"; exit 1; }
done
test -e /etc/sdm/helper.conf || { echo "FAIL conffile removed before purge"; exit 1; }
dpkg --purge sdm-download-manager
test ! -e /etc/sdm/helper.conf || { echo "FAIL conffile left after purge"; exit 1; }
echo "PASS remove and purge clean up"
echo "DEB TEST PASSED"