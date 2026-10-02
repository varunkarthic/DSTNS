# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

#
# DSTNS container image: the C++ engine, the observer it serves, the map
# downloader, and a bundled offline map. See https://dstns.readthedocs.io/deployment/docker/.
#
#   docker build -t dstns .
#   docker build -t dstns --build-arg WITH_SUMO=1 .   # include Eclipse SUMO
#
# The image is multi-architecture (linux/amd64 and linux/arm64): every stage
# uses Debian packages, so it builds natively on Apple silicon and x86 alike.

ARG DEBIAN_RELEASE=bookworm
ARG VERSION=2.1.0
ARG REVISION=unknown
ARG BUILD_DATE=unknown
ARG RELEASE_CHANNEL=local

# ---- Stage 1: the observer bundle ----------------------------------------
FROM --platform=$BUILDPLATFORM node:22-${DEBIAN_RELEASE}-slim AS ui
WORKDIR /ui
COPY ui-engine/package.json ui-engine/package-lock.json ./
RUN --mount=type=cache,id=dstns-npm,target=/root/.npm npm ci --prefer-offline --no-audit --no-fund
COPY ui-engine/ ./
RUN npm run build
# Node ships a trusted CA bundle. Bootstrap HTTPS apt even in the slim base,
# before Debian's ca-certificates package is installed.
RUN node -e "require('fs').writeFileSync('/tmp/build-ca.crt', require('tls').rootCertificates.join('\\n') + '\\n')"

# ---- Stage 2: the engine -------------------------------------------------
FROM debian:${DEBIAN_RELEASE} AS engine
ARG VERSION
ARG REVISION
ARG BUILD_DATE
ARG RELEASE_CHANNEL
COPY --from=ui /tmp/build-ca.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates libsqlite3-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt ./
COPY include include
COPY src src
COPY apps apps
COPY tools tools
RUN grep -Fx "project(dstns VERSION $VERSION LANGUAGES CXX)" CMakeLists.txt
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=OFF \
      -DDSTNS_REVISION="$REVISION" -DDSTNS_BUILD_DATE="$BUILD_DATE" -DDSTNS_CHANNEL="$RELEASE_CHANNEL" \
 && cmake --build build --target dstns_server dstns_scenario_export -j"$(nproc)"

# ---- Stage 3: runtime ----------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim
ARG WITH_SUMO=0
ARG VERSION
ARG REVISION
ARG BUILD_DATE
ARG RELEASE_CHANNEL
ARG TARGETPLATFORM
LABEL org.opencontainers.image.title="DSTNS" \
      org.opencontainers.image.description="Deterministic Spatiotemporal Transport Network Simulator" \
      org.opencontainers.image.source="https://github.com/varunkarthic/DSTNS" \
      org.opencontainers.image.url="https://github.com/varunkarthic/DSTNS" \
      org.opencontainers.image.documentation="https://dstns.readthedocs.io/" \
      org.opencontainers.image.authors="Varun Karthic (https://github.com/varunkarthic)" \
      org.opencontainers.image.vendor="Varun Karthic" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.created="$BUILD_DATE" \
      io.dstns.channel="$RELEASE_CHANNEL" \
      io.dstns.sumo="$WITH_SUMO"

COPY --from=ui /tmp/build-ca.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      libsqlite3-0 zlib1g python3 ca-certificates tini \
 && if [ "$WITH_SUMO" = "1" ]; then apt-get install -y --no-install-recommends sumo; fi \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin dstns

WORKDIR /app
COPY --from=engine /src/build/dstns_server /src/build/dstns_scenario_export /app/build/
COPY --from=ui /ui/dist /app/ui-engine/dist
COPY config /app/config
COPY LICENSE COPYRIGHT /app/
COPY ui-engine/package.json /tmp/observer-package.json
RUN python3 -c 'import json,sys; from pathlib import Path; keys=("version","revision","created","channel","platform","with_sumo"); data=dict(zip(keys,sys.argv[1:])); data.update(observer_version=json.loads(Path("/tmp/observer-package.json").read_text())["version"], author="Varun Karthic", source="https://github.com/varunkarthic/DSTNS", license="AGPL-3.0-or-later"); Path("/app/build-info.json").write_text(json.dumps(data,indent=2)+"\n")' \
      "$VERSION" "$REVISION" "$BUILD_DATE" "$RELEASE_CHANNEL" "$TARGETPLATFORM" "$WITH_SUMO" \
 && rm /tmp/observer-package.json
COPY scripts/fetch_osm.py /app/scripts/fetch_osm.py
# A recorded real district, so a container can run with no network at all:
# DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml
COPY data/fixtures/real_network.osm.xml /app/data/fixtures/real_network.osm.xml
COPY docker/entrypoint.sh /usr/local/bin/dstns-entrypoint
COPY docker/dstns-run /usr/local/bin/dstns-run
RUN chmod 0755 /usr/local/bin/dstns-entrypoint /usr/local/bin/dstns-run \
 && mkdir -p /app/logs /app/data/maps /app/data/seed-store \
 && chown -R dstns:dstns /app/logs /app/data

# The map cache and logs are the only state worth keeping; mount volumes there.
VOLUME ["/app/data/maps", "/app/logs"]

ENV DSTNS_PORT=8090 \
    DSTNS_AUTOSTART=1 \
    DSTNS_SEED=auto \
    DSTNS_DAY_TYPE=weekday \
    DSTNS_SPEED=1 \
    DSTNS_DURATION=3600 \
    DSTNS_OSM_FILE=auto \
    DSTNS_MAP_CACHE=prune \
    DSTNS_MAP_CACHE_KEEP=3 \
    SUMO_HOME=/usr/share/sumo

USER dstns
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('DSTNS_PORT','8090'), timeout=2).read()"

# tini reaps the map downloader's children and forwards signals, so
# `docker stop` shuts the server down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dstns-entrypoint"]
