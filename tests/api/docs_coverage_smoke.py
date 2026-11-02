#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Everything the server says it offers is documented: in the OpenAPI description and in Every endpoint."""
from pathlib import Path
import re
import tempfile

from fabric_platform_smoke import Server

ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory() as tmp:
        server = Server(tmp)
        try:
            groups = server.call("GET", "/api/v1/system/endpoints")[1]["groups"]
        finally:
            server.stop()
    openapi = set(re.findall(r"^  (/[^\s:]*):$", (ROOT / "docs/api/openapi.yaml").read_text(), re.M))
    page = (ROOT / "docs/api/endpoints.md").read_text()
    missing = []
    for group in groups:
        for endpoint in group["endpoints"]:
            route = endpoint["path"]
            # A choice in the index, such as {play|pause}, stands for one route each.
            choice = re.search(r"\{([a-z-]+(?:\|[a-z-]+)+)\}", route)
            for one in [route.replace(choice.group(0), option) for option in choice.group(1).split("|")] if choice else [route]:
                if one not in openapi:
                    missing.append(("openapi", one))
                # Legacy routes are in a table of their own, by group.
                if not one.startswith(("/api/v1/playback/", "/api/v1/control/")) and one not in page and re.sub(r"/[^/]+$", "", one) not in page:
                    missing.append(("endpoints.md", one))
    assert not missing, missing
    print("docs coverage ok")


if __name__ == "__main__":
    main()
