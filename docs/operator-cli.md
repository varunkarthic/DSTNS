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

---

## 2. Interactive Navigation (Ubuntu Server Style)

When launched in an interactive terminal session (`./launcher` or `python3 launcher.py` without subcommands), the operator console starts with a **System Bootstrap Splash Screen** developed by **Varun Karthic**:

```text
╭────────────────────────────────────────────────────────────────────────────────╮
│                                                                                │
│    DSTNS — DETERMINISTIC SIMULATED ENVIRONMENT  v1.1.0                         │
│    Developed by Varun Karthic · Lead Architect & Developer                     │
│    C++ Simulation Authority · Microscopic Physics · WebGL / MapLibre UI        │
│                                                                                │
╰────────────────────────────────────────────────────────────────────────────────╯
  SYSTEM BOOTSTRAP & PREREQUISITES VERIFICATION
  ──────────────────────────────────────────────────────────────────────────
  ✔  Host OS & Platform       macOS 15.0 arm64 (10 cores, 24.0 GB RAM) · COMPATIBLE
  ✔  C++20 Toolchain          Apple clang 21.0.0 (C++20 enabled)
  ✔  Build System (CMake)     CMake 4.4.2
  ✔  Scripting Runtime        Python 3.14.6 (SQLite3 WAL mode enabled)
  ✔  Frontend Engine          Node.js v26.7.0 · npm ready
  ✔  Microscopic Simulator    Eclipse SUMO 1.27.1 (found)
  ✔  C++ Simulation Core      build/dstns_server (compiled & ready)
  ✔  Web UI Assets            ui-engine/dist (production bundle ready)
  ──────────────────────────────────────────────────────────────────────────
  ●  All prerequisites verified. Launching operator console…
```

Following bootstrap, the console presents the **Flicker-Free Terminal Interface** with System Telemetry pinned to the top of all views:

```text
  SYSTEM & SIMULATION TELEMETRY
  ──────────────────────────────────────────────────────────────────────────
  ●  Platform Host   READY      macOS 15.0 arm64 (10 cores, 24.0 GB RAM)
  ●  C++ Core Engine READY      build/dstns_server (C++20 Release · deterministic)
  ●  Web UI Engine   READY      ui-engine/dist (production bundle · MapLibre/Vite)
  ●  Configuration   VALID      config/defaults.json (port 8090 · 127.0.0.1)
  ●  API Server      IDLE       http://127.0.0.1:8090/ · lifecycle: IDLE · health: READY
  ●  Simulation Hub  ACTIVE     10 Hz · 3600s cycle · Blake3-128 cryptographic sub-seed · 4 incident slots
  ●  Telemetry DB    READY      logs/runtime.db (SQLite WAL · api_log, event_log)
  ──────────────────────────────────────────────────────────────────────────

  OPERATOR ACTIONS
  ──────────────────────────────────────────────────────────────────────────
❯ [●] Launch & Control Simulation     Start C++ server, physics loop & open Web UI
  [ ] Inspect System Logs             View event log, API requests, and SQLite DB
  [ ] Configuration Manager           Inspect and edit playback & network defaults
  [ ] Run Verification Suite          Execute native C++, REST API, SUMO & UI tests
  [ ] Standalone SUMO Execution       Microscopic traffic simulation (sandbox.sumocfg)
  [ ] Reset Runtime State             Clear ephemeral SQLite DB, logs & scenarios
  [ ] Web UI Manager                  Open browser, Vite dev server, build, or install
  [ ] Command Reference               Display CLI command syntax and flags
  [ ] Exit Operator Console           Shut down managed services and terminate

  ──────────────────────────────────────────────────────────────────────────
  [↑/↓] Navigate    [Space] Select    [Enter] Execute Selected    [Esc] Exit
  ──────────────────────────────────────────────────────────────────────────
```

### Controls & Aesthetics
- **`↑` / `↓` Arrow Keys** (or `k` / `j`): Move focus cursor (`❯`) across menu options.
- **`Space`**: Mark / select the highlighted option with radio indicator (`[●]`).
- **`Enter`**: Execute the selected (`[●]`) option.
- **`Esc`**: Return to parent menu or exit the operator console.
- **`Ctrl+C`**: Cleanly terminate managed background processes and exit.
- **Status Indicator Colors**:
  - Green (`●`): Active, running, ready, or passed.
  - Yellow (`●`): Idle, paused, standby, or warning.
  - Red (`●`): Stopped, dead, crashed, missing, or failed.
- **Zero-Flicker Rendering**: In-place cursor repositioning (`\x1b[H`) and line clearing (`\x1b[K`) guarantees 100% flicker-free navigation across all terminal emulators.

---

## 3. Invocation & Entry Points

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

## 4. Command Reference

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
