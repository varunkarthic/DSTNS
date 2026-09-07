# DSTNS Operator Console (`dstns-operator-cli`)

The DSTNS Operator CLI (`dstns-operator-cli`) is a modern terminal operator interface powered by `@poppinss/cliui`. While the C++ process remains the authoritative simulation and physics runtime, the operator CLI manages environment compilation, Web UI builds, process lifecycles, and interactive operator sessions.

---

## 1. Architectural Role

```text
  +-------------------------------------------------------------+
  |              DSTNS Operator CLI (Node.js/ESM)               |
  |         Powered by @poppinss/cliui (stickers, tables, tasks)|
  +------------------------------+------------------------------+
                                 |
        +------------------------+------------------------+
        |                                                 |
        v                                                 v
+-------------------------------+                 +-------------------------------+
|       C++ Engine Server       |                 |       Web UI Frontend         |
|        (dstns_server)         |                 |    (Vite / MapLibre GL JS)    |
|   Simulation Authority & BPR  |                 |    ui-engine/dist (or dev)    |
+-------------------------------+                 +-------------------------------+
```

### Key Responsibilities
1. **Automated Environment Verification**:
   - Detects incomplete build artifacts (`build/dstns_server`, `ui-engine/dist`).
   - Automatically installs frontend dependencies (`npm install --prefix ui-engine`) if `ui-engine/node_modules` is missing.
   - Automatically builds the production Web UI bundle (`npm run build --prefix ui-engine`).
   - Configures and compiles the C++ simulation engine via CMake (`cmake --build build -j4`).
2. **Server Lifecycle & Port Management**:
   - Probes configured port (`8090`). If occupied by another process, dynamically finds an available network port.
   - If an existing healthy DSTNS server is running, seamlessly attaches to it without restarting.
3. **Web UI Launching & Browser Integration**:
   - Direct browser launch via `--open` or session command `o` using platform-native launchers (`open` on macOS, `xdg-open` on Linux, `start` on Windows).
   - Embedded support for launching the Vite development server with hot-reload (`ui dev`).
4. **Comprehensive Test Orchestration**:
   - 9-stage sequential test pipeline covering CMake configuration, test compilation, C++ unit/property/replay/perf tests, Vitest UI suites, Vite production builds, REST API smoke tests, and Eclipse SUMO physics validation.

---

## 2. Invocation & Entry Points

The operator console can be launched through multiple equivalent entrypoints:

```bash
# Direct execution via root bash wrapper
./launcher

# Direct execution via root Python wrapper
python3 launcher.py

# Direct execution via Node ESM script
node dstns-operator-cli/dstns.mjs

# Execution via npm script
npm start --prefix dstns-operator-cli
```

---

## 3. Command Reference

### Starting the Server & Web UI
```bash
# Start server, compile if needed, and enter interactive session
./launcher start

# Start server and automatically open the Web UI in the default browser
./launcher start --open

# Run server in foreground mode (for Docker containers or systemd services)
./launcher --mode=server
```

### Frontend / Web UI Management
```bash
# Open Web UI in browser
./launcher ui open

# Start Vite development server with hot-reload (http://127.0.0.1:5173/)
./launcher ui dev

# Force rebuild the production Web UI bundle into ui-engine/dist
./launcher ui build

# Ensure UI dependencies are installed
./launcher ui install
```

### Testing & Verification
```bash
# Run all 9 verification stages
./launcher test all

# Run specific test suites
./launcher test unit
./launcher test ui
```

### Logs & Telemetry Inspection
```bash
# View human-readable system log tail
./launcher logs system

# Query SQLite WAL tables
./launcher logs api
./launcher logs event
./launcher logs playback
```

### Configuration & State Management
```bash
# Interactive configuration validator and editor
./launcher config

# Clear ephemeral runtime databases, checkpoints, and SUMO live runs
./launcher reset --yes
```
