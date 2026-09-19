# DEPRECATED in 2.0.0 - unmaintained and untested; see docs/DOCKER.md.
# Stage 1: Build React/Vite UI
FROM node:22-bookworm-slim AS ui-build
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /ui
COPY ui-engine/package.json ui-engine/package-lock.json ./
RUN npm ci --registry=$NPM_REGISTRY
COPY ui-engine/ ./
RUN npm run build

# Package the same CLI used on the host; saved configurations use Python sqlite3.
WORKDIR /operator
COPY dstns-operator-cli/package.json dstns-operator-cli/package-lock.json ./
RUN npm ci --omit=dev --registry=$NPM_REGISTRY
COPY dstns-operator-cli/dstns.mjs dstns-operator-cli/seeds.py dstns-operator-cli/artifacts.mjs ./

# Stage 2: Build C++ backend
FROM ghcr.io/eclipse-sumo/sumo:latest AS build
WORKDIR /src
COPY CMakeLists.txt ./
COPY include include
COPY src src
COPY apps apps
COPY tools tools
COPY tests tests
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=OFF && cmake --build build --target dstns_server -j2

# Stage 3: Unified Runtime Container
FROM ghcr.io/eclipse-sumo/sumo:latest
WORKDIR /app
COPY --from=build /src/build/dstns_server /app/dstns_server
COPY --from=ui-build /ui/dist /app/ui-engine/dist
COPY config /app/config
# Keep the bundled map outside /app/data: existing Compose data volumes mask image files.
COPY data/fixtures/downtown_osm.xml /app/maps/downtown_osm.xml
COPY --from=ui-build /usr/local/bin/node /usr/local/bin/node
COPY --from=ui-build /operator /app/dstns-operator-cli
COPY data/fixtures /app/data/fixtures
# The on-demand map fetcher. Without it a seed cannot resolve to a city tile,
# so the server would refuse to compile any scenario that uses map.osm_file=auto.
COPY scripts /app/scripts
RUN mkdir -p /app/logs /app/data /app/data/maps /app/build && ln -s /app/dstns_server /app/build/dstns_server
EXPOSE 8090
HEALTHCHECK --interval=5s --timeout=2s --retries=10 CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=1).read()"]
ENTRYPOINT ["/app/dstns_server","--host","0.0.0.0","--port","8090","--logs","/app/logs"]
