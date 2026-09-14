#!/usr/bin/env python3
"""DSTNS Operator CLI Launcher.
Authoritative launcher forwarding execution to the modern Node/@poppinss/cliui
operator console in dstns-operator-cli. The C++ process remains the simulation authority.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OPERATOR_DIR = ROOT / "dstns-operator-cli"
OPERATOR_SCRIPT = OPERATOR_DIR / "dstns.mjs"


def ensure_operator_dependencies(node_bin: str) -> None:
    """Ensure @poppinss/cliui and operator CLI dependencies are installed."""
    probe = subprocess.run(
        [node_bin, "--input-type=module", "-e", "await import('@poppinss/cliui')"],
        cwd=OPERATOR_DIR,
        capture_output=True,
    )
    if probe.returncode == 0:
        return

    npm_bin = shutil.which("npm")
    if not npm_bin:
        raise RuntimeError("npm is required to install the operator CLI dependencies. Please install npm and retry.")
    install_command = "ci" if (OPERATOR_DIR / "package-lock.json").exists() else "install"
    print(f"[DSTNS] Installing operator CLI dependencies (npm {install_command})...", flush=True)
    subprocess.run([npm_bin, install_command], cwd=OPERATOR_DIR, check=True)


def main() -> int:
    node_bin = shutil.which("node")
    if not node_bin:
        print("Error: Node.js (>= 20) is required to run the DSTNS operator console.", file=sys.stderr)
        print("Please install Node.js or ensure 'node' is present in your PATH.", file=sys.stderr)
        return 1

    if not OPERATOR_SCRIPT.exists():
        print(f"Error: Operator CLI script not found at {OPERATOR_SCRIPT}", file=sys.stderr)
        return 1

    try:
        ensure_operator_dependencies(node_bin)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    cmd = [node_bin, str(OPERATOR_SCRIPT)] + sys.argv[1:]
    try:
        # On POSIX systems, replace current process with node for clean TTY handoff
        if hasattr(os, "execvp") and sys.platform != "win32":
            os.execvp(node_bin, cmd)
        else:
            return subprocess.call(cmd)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
