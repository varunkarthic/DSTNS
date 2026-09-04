#!/usr/bin/env python3
"""DSTNS operator launcher. The C++ process remains the simulation authority."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "config" / "defaults.json"
LOGS = ROOT / "logs"
SERVER = ROOT / "build" / "dstns_server"
UI_DIST = ROOT / "ui-engine" / "dist"
VERSION = "1.0.0"
LOGO = """\033[96m
  ██████╗ ███████╗████████╗███╗   ██╗███████╗
  ██╔══██╗██╔════╝╚══██╔══╝████╗  ██║██╔════╝
  ██║  ██║███████╗   ██║   ██╔██╗ ██║███████╗
  ██║  ██║╚════██║   ██║   ██║╚██╗██║╚════██║
  ██████╔╝███████║   ██║   ██║ ╚████║███████║
  ╚═════╝ ╚══════╝   ╚═╝   ╚═╝  ╚═══╝╚══════╝\033[0m"""

def banner() -> None:
    print(LOGO)
    print("Deterministic Simulated Environment")
    print(f"Developed by Varun Karthic · Version {VERSION}\n")

def load_config() -> dict:
    with CONFIG.open(encoding="utf-8") as handle:
        cfg = json.load(handle)
    duration = cfg["playback"]["duration_seconds"]
    tick = cfg["playback"]["tick_rate"]
    if not 60 <= duration <= 1200:
        raise ValueError("playback.duration_seconds must be in [60, 1200]")
    if not 0 < tick <= 100:
        raise ValueError("playback.tick_rate must be in (0, 100]")
    return cfg

def build() -> None:
    print("Building DSTNS C++ engine...")
    subprocess.run(["cmake", "-S", str(ROOT), "-B", str(ROOT / "build"), "-DCMAKE_BUILD_TYPE=Release"], check=True)
    subprocess.run(["cmake", "--build", str(ROOT / "build"), "-j4"], check=True)
    if not UI_DIST.exists():
        build_ui()

def build_ui() -> None:
    print("Building DSTNS Web UI bundle...")
    subprocess.run(["npm", "run", "build", "--prefix", str(ROOT / "ui-engine")], check=True)

def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0

def find_available_port(start_port: int, host: str = "127.0.0.1") -> int:
    port = start_port
    while port < 65535:
        if not is_port_in_use(port, host):
            return port
        port += 1
    raise RuntimeError("No available network ports found")

def check_dstns_health(port: int) -> dict | None:
    url = f"http://127.0.0.1:{port}/health"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=1) as response:
            if response.status == 200:
                data = json.loads(response.read().decode("utf-8"))
                if data.get("product") == "DSTNS" or data.get("service") == "dstns":
                    return data
    except Exception:
        pass
    return None

def api_call(port: int, path: str, method: str = "GET", payload: dict | None = None) -> tuple[int, dict]:
    url = f"http://127.0.0.1:{port}{path}"
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.load(exc)
        except Exception:
            return exc.code, {"error": str(exc)}
    except Exception as exc:
        return 500, {"error": str(exc)}

def wait_health(port: int, process: subprocess.Popen, timeout: float = 15) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/health"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            err_msg = stderr.strip() if stderr else (stdout.strip() if stdout else "process exited unexpectedly")
            raise RuntimeError(f"Server process exited with code {process.returncode}: {err_msg}")
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=1) as response:
                if response.status == 200:
                    return
        except (urllib.error.HTTPError, urllib.error.URLError, OSError):
            time.sleep(0.2)
    raise RuntimeError(f"Server did not become healthy at {url} within {timeout} seconds.")

def start_server(replace: bool = False) -> tuple[subprocess.Popen | None, int]:
    cfg = load_config()
    if not SERVER.exists():
        build()
    if not UI_DIST.exists():
        build_ui()
    LOGS.mkdir(exist_ok=True)
    port = int(cfg["api"]["port"])
    host = cfg["api"]["host"]

    if is_port_in_use(port, "127.0.0.1"):
        existing = check_dstns_health(port)
        if existing:
            print(f"\n[Info] An active DSTNS server instance is already running on port {port} (Lifecycle: {existing.get('lifecycle', 'UNKNOWN')}).")
            print(f"  Web UI: http://127.0.0.1:{port}/")
            print(f"  API Health: http://127.0.0.1:{port}/health\n")
            return None, port
        else:
            free_port = find_available_port(port + 1)
            print(f"\n[Warning] Configured port {port} is occupied. Auto-assigning free port {free_port}.")
            port = free_port

    command = [str(SERVER), "--host", host, "--port", str(port), "--logs", str(LOGS)]
    if replace:
        os.execv(command[0], command)
        return None, port

    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        wait_health(port, process)
    except Exception as exc:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=2)
        raise RuntimeError(f"Failed to start DSTNS server: {exc}") from exc

    print(f"\n\033[92m[DSTNS Server Running]\033[0m")
    print(f"  ► Web Application UI : \033[94mhttp://127.0.0.1:{port}/\033[0m")
    print(f"  ► REST API Endpoint  : http://127.0.0.1:{port}/api/v1/playback/status")
    print(f"  ► SUMO Micro-Physics : http://127.0.0.1:{port}/api/v1/system/info")
    print(f"  ► UI Dev Hot-Reload  : cd ui-engine && npm run dev (http://127.0.0.1:5173/)\n")
    return process, port

def control_session(process: subprocess.Popen | None, port: int) -> None:
    print("--- Active Server Session (Press Ctrl+C or enter 'q' to stop) ---")
    print("Commands: [1] Start Simulation (Auto-Seed & SUMO Physics), [2] Pause, [3] Play, [4] Status, [5] Terminate, [q] Return")
    while True:
        try:
            cmd = input(f"dstns(port:{port})> ").strip().lower()
            if cmd in {"q", "exit", "return", "quit"}:
                break
            elif cmd in {"1", "start", "init"}:
                code, res = api_call(port, "/api/v1/playback/start", "POST", {
                    "seed": "auto",
                    "playback_duration_seconds": 1200,
                    "day": 0,
                    "tick_rate": 1.0,
                    "modules": {"traffic": True, "signals": True, "buildings": True, "dws": True, "flooding": True, "news": True},
                    "dws": {"frequency": 4}
                })
                print(f"Simulation Started (with SUMO Physics): Code {code} -> Lifecycle: {res.get('lifecycle', res.get('error'))}")
            elif cmd in {"2", "pause"}:
                code, res = api_call(port, "/api/v1/playback/pause", "POST", {})
                print(f"Simulation Pause: Code {code} -> Lifecycle: {res.get('lifecycle', res.get('error'))}")
            elif cmd in {"3", "play", "resume"}:
                code, res = api_call(port, "/api/v1/playback/play", "POST", {})
                print(f"Simulation Play: Code {code} -> Lifecycle: {res.get('lifecycle', res.get('error'))}")
            elif cmd in {"4", "status"}:
                code, res = api_call(port, "/api/v1/system/status")
                print(json.dumps(res, indent=2))
            elif cmd in {"5", "terminate", "kill"}:
                code, res = api_call(port, "/terminate", "POST", {})
                print(f"Server Termination: Code {code} -> {res.get('message', res)}")
                break
            else:
                print("Options: [1] Start Sim (Auto-seed & SUMO), [2] Pause, [3] Play, [4] Status, [5] Terminate, [q] Return")
        except (KeyboardInterrupt, EOFError):
            print()
            break

def run_sumo_simulation() -> None:
    """Export deterministic scenario to SUMO, build network, and execute microscopic simulation."""
    print("\n--- DSTNS SUMO Microscopic Physics Engine Execution ---")
    sumo_bin = None
    netconvert_bin = None

    for candidate_dir in [os.environ.get("SUMO_HOME", "") + "/bin", "/Users/varun/sumo/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]:
        if candidate_dir:
            s = Path(candidate_dir) / "sumo"
            n = Path(candidate_dir) / "netconvert"
            if s.exists() and n.exists():
                sumo_bin = str(s)
                netconvert_bin = str(n)
                break

    if not sumo_bin:
        which_sumo = shutil.which("sumo")
        which_nc = shutil.which("netconvert")
        if which_sumo and which_nc:
            sumo_bin = which_sumo
            netconvert_bin = which_nc

    if not sumo_bin or not netconvert_bin:
        print("Error: SUMO binaries (sumo, netconvert) not found on PATH or in $SUMO_HOME.", file=sys.stderr)
        return

    print(f"Detected SUMO: {sumo_bin}")
    print(f"Detected Netconvert: {netconvert_bin}")

    export_tool = ROOT / "build" / "dstns_scenario_export"
    if not export_tool.exists():
        build()

    export_dir = ROOT / "data" / "sumo_live_run"
    export_dir.mkdir(parents=True, exist_ok=True)

    print(f"Exporting deterministic scenario to {export_dir}...")
    subprocess.run([str(export_tool), "--export-sumo", str(export_dir), "--grid", "12x12"], cwd=ROOT, check=True)

    print("Compiling network with netconvert...")
    nc_cmd = [
        netconvert_bin,
        f"--node-files={export_dir / 'network.nod.xml'}",
        f"--edge-files={export_dir / 'network.edg.xml'}",
        f"--output-file={export_dir / 'network.net.xml'}",
        "--no-warnings=true"
    ]
    subprocess.run(nc_cmd, cwd=export_dir, check=True)

    print("Running SUMO microscopic traffic simulation...")
    tripinfo = export_dir / "tripinfo.xml"
    if tripinfo.exists():
        tripinfo.unlink()

    sumo_cmd = [
        sumo_bin,
        "-c", str(export_dir / "sandbox.sumocfg"),
        "--begin", "0",
        "--end", "3600",
        "--seed", "42",
        f"--tripinfo-output={tripinfo}",
        "--no-step-log=true",
        "--duration-log.disable=true"
    ]
    subprocess.run(sumo_cmd, cwd=export_dir, check=True)

    print("\n\033[92mSUMO Microscopic Simulation Completed Successfully!\033[0m")
    if tripinfo.exists():
        size = tripinfo.stat().st_size
        print(f"Generated tripinfo output: {tripinfo} ({size} bytes)")
        content = tripinfo.read_text(errors="replace")
        trips = [line for line in content.splitlines() if "<tripinfo" in line]
        print(f"Total microscopic trips executed: {len(trips)}")
        if trips:
            print("Sample trip telemetry:")
            for sample in trips[:3]:
                print(f"  {sample.strip()}")
    print()

def view_logs() -> None:
    choice = input("system / api / event / playback / return: ").strip().lower()
    if choice in {"return", "r", ""}:
        return
    if choice == "system":
        path = LOGS / "system.log"
        print("\n".join(path.read_text(errors="replace").splitlines()[-100:]) if path.exists() else "No system log yet.")
        return
    table = {"api": "api_log", "event": "event_log", "playback": "lifecycle_log"}.get(choice)
    db = LOGS / "runtime.db"
    if not table or not db.exists():
        print("No matching runtime log.")
        return
    with sqlite3.connect(db) as conn:
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY id DESC LIMIT 100").fetchall()
    for row in reversed(rows):
        print(row)

def edit_config() -> None:
    cfg = load_config()
    print(json.dumps(cfg, indent=2))
    duration = input(f"Playback duration [{cfg['playback']['duration_seconds']}]: ").strip()
    tick = input(f"Tick rate [{cfg['playback']['tick_rate']}]: ").strip()
    port = input(f"API port [{cfg['api']['port']}]: ").strip()
    if duration:
        cfg["playback"]["duration_seconds"] = int(duration)
    if tick:
        cfg["playback"]["tick_rate"] = float(tick)
    if port:
        cfg["api"]["port"] = int(port)
    if not 60 <= cfg["playback"]["duration_seconds"] <= 1200 or not 0 < cfg["playback"]["tick_rate"] <= 10:
        raise ValueError("configuration is outside documented bounds")
    CONFIG.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    print("Configuration saved.")

def run_tests(scope: str = "all") -> None:
    commands = {
        "unit": [["ctest", "--test-dir", str(ROOT / "build"), "--output-on-failure"]],
        "ui": [["npm", "test", "--prefix", str(ROOT / "ui-engine")]],
        "all": [
            ["cmake", "-S", str(ROOT), "-B", str(ROOT / "build"), "-DDSTNS_BUILD_TESTS=ON"],
            ["cmake", "--build", str(ROOT / "build"), "-j4"],
            ["ctest", "--test-dir", str(ROOT / "build"), "--output-on-failure"],
            ["npm", "test", "--prefix", str(ROOT / "ui-engine")],
            ["npm", "run", "build", "--prefix", str(ROOT / "ui-engine")],
            ["python3", str(ROOT / "tests" / "api" / "api_smoke.py"), "--server", str(SERVER)],
            ["bash", str(ROOT / "tests" / "integration" / "sumo_smoke.sh")],
            [str(ROOT / "build" / "dstns_replay_verify")],
            [str(ROOT / "build" / "dstns_benchmark")]
        ],
    }
    for command in commands.get(scope, commands["all"]):
        print(f"Running: {' '.join(command)}")
        subprocess.run(command, cwd=ROOT, check=True)

def reset_runtime() -> None:
    for path in (LOGS / "system.log", LOGS / "runtime.db", LOGS / "runtime.db-wal", LOGS / "runtime.db-shm"):
        path.unlink(missing_ok=True)
    for directory in (ROOT / "data" / "checkpoints", ROOT / "data" / "scenarios", ROOT / "data" / "sumo_live_run"):
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True, exist_ok=True)
    print("Runtime logs, checkpoints, temporary scenarios, and SUMO runs reset. OSM cache and configuration preserved.")

HELP = """Commands:
  start   Build if needed and launch the C++ API server with embedded SUMO physics and Web UI.
  logs    Inspect system, API, event, or lifecycle logs.
  config  Validate and edit persisted defaults.
  test    Run native, API, replay, SUMO, and UI tests.
  reset   Clear ephemeral runtime data; preserves OSM cache/config.
  help    Display command help.
  exit    Leave the operator interface.
"""

def menu() -> int:
    process = None
    server_port = 8090
    aliases = {
        "1": "start",
        "2": "logs",
        "3": "config",
        "4": "test",
        "5": "reset",
        "6": "help",
        "7": "exit"
    }
    try:
        while True:
            print("1. Start DSTNS (Web UI & Simulation with SUMO Physics)")
            print("2. View Logs")
            print("3. Modify Default Configuration")
            print("4. Run Test Cases")
            print("5. Reset Runtime State")
            print("6. Help")
            print("7. Exit")
            raw = input("dstns> ").strip().lower()
            action = aliases.get(raw, raw)
            try:
                if action == "start":
                    if process and process.poll() is None:
                        print(f"DSTNS server is already running on port {server_port}.")
                        control_session(process, server_port)
                    else:
                        p, port = start_server()
                        server_port = port
                        if p:
                            process = p
                        control_session(process, server_port)
                elif action == "logs":
                    view_logs()
                elif action == "config":
                    edit_config()
                elif action == "test":
                    run_tests(input("Scope [all/unit/ui]: ").strip() or "all")
                elif action == "reset":
                    reset_runtime()
                elif action == "help":
                    print(HELP)
                elif action in {"exit", "quit", "q"}:
                    return 0
                else:
                    print("Unknown command. Type 6 for help.")
            except (ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
                print(f"Error: {exc}", file=sys.stderr)
    finally:
        if process and process.poll() is None:
            process.terminate()

def main() -> int:
    parser = argparse.ArgumentParser(description="DSTNS operator launcher", epilog=HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", choices=["start", "logs", "config", "test", "reset", "help"])
    parser.add_argument("topic", nargs="?")
    parser.add_argument("--mode", choices=["interactive", "server"], default="interactive" if sys.stdin.isatty() else None)
    args = parser.parse_args()
    banner()

    if args.command == "start":
        process, port = start_server()
        try:
            if process:
                control_session(process, port)
                process.terminate()
        except KeyboardInterrupt:
            if process:
                process.terminate()
        return 0
    if args.command == "logs":
        view_logs()
        return 0
    if args.command == "config":
        edit_config()
        return 0
    if args.command == "test":
        run_tests(args.topic or "all")
        return 0
    if args.command == "reset":
        reset_runtime()
        return 0
    if args.command == "help":
        print(HELP)
        return 0

    if args.mode == "server":
        start_server(replace=True)
        return 0

    return menu()

if __name__ == "__main__":
    raise SystemExit(main())
