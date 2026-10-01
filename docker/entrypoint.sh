#!/bin/sh
# Container entrypoint: start the DSTNS server, then (unless DSTNS_AUTOSTART=0)
# start a run configured from the DSTNS_* environment variables.
#
# The server owns the process: when it exits, so does the container. The run
# is started from the side once the server is healthy, so a run that fails to
# start (no network for the map, say) leaves the server up and the observer
# reachable, with the reason shown in the interface and the container log.
set -eu

port="${DSTNS_PORT:-8090}"

/app/build/dstns_server \
  --host 0.0.0.0 \
  --port "$port" \
  --logs /app/logs \
  --maps /app/data/maps \
  --map-cache "${DSTNS_MAP_CACHE:-prune}" \
  --map-cache-keep "${DSTNS_MAP_CACHE_KEEP:-3}" &
server=$!

# Forward stop signals to the server so it can shut down its downloader.
trap 'kill -TERM "$server" 2>/dev/null' TERM INT

if [ "${DSTNS_AUTOSTART:-1}" != "0" ]; then
  # In the background: the entrypoint's job is to wait on the server.
  dstns-run --wait-for-server --quiet-if-active &
fi

wait "$server"
