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


def ensure_operator_dependencies() -> None:
    """Ensure @poppinss/cliui and operator CLI dependencies are installed."""
    node_modules = OPERATOR_DIR / "node_modules"
    if not node_modules.exists():
        print("[DSTNS] Installing operator CLI dependencies (npm install)...")
        npm_bin = shutil.which("npm") or "npm"
        subprocess.run([npm_bin, "install", "--prefix", str(OPERATOR_DIR)], check=True)


def main() -> int:
    node_bin = shutil.which("node")
    if not node_bin:
        print("Error: Node.js (>= 20) is required to run the DSTNS operator console.", file=sys.stderr)
        print("Please install Node.js or ensure 'node' is present in your PATH.", file=sys.stderr)
        return 1

    if not OPERATOR_SCRIPT.exists():
        print(f"Error: Operator CLI script not found at {OPERATOR_SCRIPT}", file=sys.stderr)
        return 1

    ensure_operator_dependencies()

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
