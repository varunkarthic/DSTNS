#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Fast Boot: a city kept compressed in advance is unpacked and used, with no download."""
import gzip
import itertools
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from fabric_launch_smoke import ROOT, Server

FIXTURE = ROOT / "data/fixtures/real_network.osm.xml"
SERVER = os.environ.get("DSTNS_SERVER", str(ROOT / "build/dstns_server"))


def city_of(seed):
    return json.loads(subprocess.run([SERVER, "--city-of-seed", str(seed)], capture_output=True, text=True, check=True).stdout)


def main():
    listed = json.loads(subprocess.run([SERVER, "--list-cities", "5000"], capture_output=True, text=True, check=True).stdout)
    assert len(listed) >= 100 and all({"city", "country", "key", "bbox"} <= set(city) for city in listed), listed[:2]
    assert {city["key"] for city in listed} >= {"berlin_x5000", "london_x5000"}
    seeds = list(itertools.islice((seed for seed in range(1, 4000) if city_of(seed)["key"] == "berlin_x5000"), 3))
    assert seeds, "a seed that chooses Berlin, whose centre the fixture covers"

    with tempfile.TemporaryDirectory() as tmp:
        fast = Path(tmp) / "fastboot"
        maps = Path(tmp) / "maps"
        fast.mkdir()
        with open(FIXTURE, "rb") as source, gzip.open(fast / "berlin_x5000.osm.xml.gz", "wb") as target:
            shutil.copyfileobj(source, target)
        # A damaged one is not trusted, and nothing half-written is left behind.
        (fast / "london_x5000.osm.xml.gz").write_bytes(b"not gzip at all")
        s = Server(tmp, DSTNS_FASTBOOT_DIR=str(fast))
        try:
            ran = None
            for seed in seeds:
                began = time.monotonic()
                started = s.call("POST", "/api/v1/playback/start", {"seed": str(seed), "playback_duration_seconds": 600, "map": {"osm_file": "auto", "cache_dir": str(maps)}}, headers=s.host)
                assert started[0] == 202, started
                while time.monotonic() - began < 30:
                    status = s.call("GET", "/api/v1/fabric/engine/status")[1]["data"]
                    if status["lifecycle"] in ("RUNNING", "IDLE") and status["lifecycle"] != "PREPARING":
                        if status["lifecycle"] == "RUNNING" or status.get("preparation_error"):
                            break
                    time.sleep(0.1)
                if status["lifecycle"] == "RUNNING":
                    ran = (seed, time.monotonic() - began)
                    break
                # The district this seed grows may fall outside the small fixture: try the next.
                s.call("POST", "/api/v1/fabric/engine/stop", {}, headers=s.host)
            assert ran, "a Berlin seed ran from the packed city"
            unpacked = maps / "berlin_x5000.osm.xml"
            assert unpacked.read_bytes() == FIXTURE.read_bytes(), "unpacked whole, byte for byte"
            assert not list(maps.glob("*.unpacking")), "nothing half-written left"
            assert s.call("GET", "/api/v1/view/topology")[1]["data"]["location"]["city"] == "Berlin"
            print(f"seed {ran[0]} ran in {ran[1]:.1f} s with no download")
        finally:
            s.stop()
    print("fastboot ok")


if __name__ == "__main__":
    main()
