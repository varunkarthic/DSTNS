# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

#
# DSTNS container image: the C++ engine, the observer it serves, the map
# downloader, and a bundled offline map. See https://dstns.readthedocs.io/deployment/docker/.
#
#   docker build -t dstns .
#   docker build -t dstns --build-arg WITH_SUMO=1 .   # include Eclipse SUMO
#   docker build -t dstns --build-arg WITH_VULKAN=1 . # include the Vulkan loader and
#                                                     # Mesa drivers, for GPUs passed in
#                                                     # with --device /dev/dri
#
# Without a GPU passed in, the container runs the physics on the CPU backend;
# results are identical either way.
#
# The image is multi-architecture (linux/amd64 and linux/arm64): every stage
# uses Debian packages, so it builds natively on Apple silicon and x86 alike.

ARG DEBIAN_RELEASE=bookworm

# ---- Stage 1: the observer bundle ----------------------------------------
FROM node:22-${DEBIAN_RELEASE}-slim AS ui
WORKDIR /ui
COPY ui-engine/package.json ui-engine/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui-engine/ ./
RUN npm run build

# ---- Stage 2: the engine -------------------------------------------------
FROM debian:${DEBIAN_RELEASE} AS engine
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates libsqlite3-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt ./
COPY cmake cmake
COPY include include
COPY shaders shaders
COPY src src
COPY apps apps
COPY tools tools
# The Vulkan backend is always built (it costs nothing at run time without a
# GPU); the shaders come precompiled from shaders/spirv/, so no shader
# compiler is needed here.
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=OFF \
 && cmake --build build --target dstns_server dstns_scenario_export -j"$(nproc)"

# ---- Stage 3: runtime ----------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim
ARG WITH_SUMO=0
ARG WITH_VULKAN=0
LABEL org.opencontainers.image.title="DSTNS" \
      org.opencontainers.image.description="Deterministic Spatiotemporal Transport Network Simulator" \
      org.opencontainers.image.source="https://github.com/varunkarthic/DSTNS" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libsqlite3-0 zlib1g python3 ca-certificates tini \
 && if [ "$WITH_SUMO" = "1" ]; then apt-get install -y --no-install-recommends sumo; fi \
 && if [ "$WITH_VULKAN" = "1" ]; then apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers; fi \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin dstns

WORKDIR /app
COPY --from=engine /src/build/dstns_server /src/build/dstns_scenario_export /app/build/
COPY --from=ui /ui/dist /app/ui-engine/dist
COPY config /app/config
COPY scripts/fetch_osm.py /app/scripts/fetch_osm.py
COPY scripts/fetch_dem.py /app/scripts/fetch_dem.py
# A recorded real district, so a container can run with no network at all:
# DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml
COPY data/fixtures/real_network.osm.xml /app/data/fixtures/real_network.osm.xml
COPY docker/entrypoint.sh /usr/local/bin/dstns-entrypoint
COPY docker/dstns-run /usr/local/bin/dstns-run
RUN chmod 0755 /usr/local/bin/dstns-entrypoint /usr/local/bin/dstns-run \
 && mkdir -p /app/logs /app/data/maps /app/data/dem /app/data/seed-store /app/data/cache \
 && chown -R dstns:dstns /app/logs /app/data

# The map cache and logs are the only state worth keeping; mount volumes there.
VOLUME ["/app/data/maps", "/app/data/dem", "/app/logs"]

ENV DSTNS_PORT=8090 \
    DSTNS_AUTOSTART=1 \
    DSTNS_SEED=auto \
    DSTNS_DAY_TYPE=auto \
    DSTNS_SPEED=1 \
    DSTNS_DURATION=3600 \
    DSTNS_OSM_FILE=auto \
    DSTNS_MAP_CACHE=prune \
    DSTNS_MAP_CACHE_KEEP=3 \
    SUMO_HOME=/usr/share/sumo \
    DSTNS_COMPUTE_BACKEND=auto

USER dstns
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('DSTNS_PORT','8090'), timeout=2).read()"

# tini reaps the map downloader's children and forwards signals, so
# `docker stop` shuts the server down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dstns-entrypoint"]
