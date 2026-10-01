#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic
"""Add or check the licence header on every source file.

    scripts/license-headers.py --check    exit 1 if any file lacks the header (used by CI)
    scripts/license-headers.py --fix      add the header where it is missing

The header is two lines, in the file's own comment syntax:

    SPDX-License-Identifier: AGPL-3.0-or-later
    Copyright (C) 2026 Varun Karthic

SPDX identifiers (https://spdx.dev) are machine-readable, and the REUSE
specification (https://reuse.software) asks for one in every file. A shebang line
(and a Dockerfile's `# syntax=` directive) must stay first, so the header goes
after it.
"""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPDX = "SPDX-License-Identifier: AGPL-3.0-or-later"
COPYRIGHT = "Copyright (C) 2026 Varun Karthic"

SLASH = {".cpp", ".hpp", ".h", ".ts", ".tsx", ".js", ".mjs"}
HASH = {".py", ".sh"}
BLOCK = {".css"}
# Files with no extension, or named files, that are source.
HASH_NAMES = {"launcher", "CMakeLists.txt", "Dockerfile", "dstns-run"}
# Never touched: generated, vendored or data.
SKIP_PARTS = {"node_modules", "dist", "build", "data", "docs", "site"}
SKIP_NAMES = {"package-lock.json"}


def style(path: Path):
    if path.name in SKIP_NAMES:
        return None
    if path.suffix in SLASH:
        return "slash"
    if path.suffix in HASH or path.name in HASH_NAMES:
        return "hash"
    if path.suffix in BLOCK:
        return "block"
    return None


def header(kind: str) -> list[str]:
    if kind == "slash":
        return [f"// {SPDX}", f"// {COPYRIGHT}"]
    if kind == "hash":
        return [f"# {SPDX}", f"# {COPYRIGHT}"]
    return [f"/* {SPDX}", f"   {COPYRIGHT} */"]


def sources() -> list[Path]:
    listed = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
    out = []
    for name in filter(None, listed):
        path = Path(name)
        if SKIP_PARTS & set(path.parts):
            continue
        if style(path):
            out.append(path)
    return out


def has_header(lines: list[str]) -> bool:
    return any("SPDX-License-Identifier" in line for line in lines[:6])


def insertion_point(path: Path, lines: list[str]) -> int:
    """After a shebang, and after a Dockerfile parser directive: both must be first."""
    at = 0
    if lines and lines[0].startswith("#!"):
        at = 1
    if path.name == "Dockerfile" and lines and lines[0].startswith("# syntax="):
        at = 1
    return at


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--fix", action="store_true")
    args = parser.parse_args()

    missing, fixed = [], 0
    for path in sources():
        full = ROOT / path
        try:
            text = full.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        lines = text.split("\n")
        if has_header(lines):
            continue
        missing.append(path)
        if args.fix:
            at = insertion_point(path, lines)
            block = header(style(path)) + [""]
            full.write_text("\n".join(lines[:at] + block + lines[at:]), encoding="utf-8")
            fixed += 1

    if args.check:
        for path in missing:
            print(f"missing licence header: {path}")
        if missing:
            print(f"\n{len(missing)} file(s) lack the header. Run: scripts/license-headers.py --fix", file=sys.stderr)
            return 1
        print("every source file has a licence header")
        return 0
    print(f"added a licence header to {fixed} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
