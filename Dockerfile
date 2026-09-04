# Stage 1: Build React/Vite UI
FROM node:22-bookworm-slim AS ui-build
WORKDIR /ui
COPY ui-engine/package.json ui-engine/package-lock.json ./
RUN npm ci
COPY ui-engine/ ./
RUN npm run build

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
RUN mkdir -p /app/logs /app/data
EXPOSE 8090
HEALTHCHECK --interval=5s --timeout=2s --retries=10 CMD curl -fsS http://127.0.0.1:8090/health || exit 1
ENTRYPOINT ["/app/dstns_server","--host","0.0.0.0","--port","8090","--logs","/app/logs"]

