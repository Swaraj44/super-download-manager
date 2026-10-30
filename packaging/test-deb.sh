#!/bin/sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
NODE=${NODE:-$(command -v node)}
FFMPEG=${FFMPEG:-$(command -v ffmpeg)}
FFPROBE=${FFPROBE:-$(dirname "$FFMPEG")/ffprobe}
DEB=$(ls "$ROOT"/dist/pdm-download-manager_*_all.deb | tail -1)
ID=$(cat "$ROOT/dist/extension-id.txt")

docker build -q -t pdm-deb-test "$HERE/test" >/dev/null
docker run --rm \
  -v "$DEB:/pkg/pdm.deb:ro" \
  -v "$HERE/test:/test:ro" \
  -v "$NODE:/usr/local/bin/node:ro" \
  -v "$FFMPEG:/usr/local/bin/ffmpeg:ro" \
  -v "$FFPROBE:/usr/local/bin/ffprobe:ro" \
  pdm-deb-test sh /test/run.sh /pkg/pdm.deb "$ID"