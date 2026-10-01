# System requirements

What DSTNS needs to run: the operating systems and toolchains it supports, the
hardware a district of a given size needs, the browsers the observer supports, and
the network access it uses. Check these before [installing](installation.md) or
[running with Docker](docker.md).

## At a glance

| | Docker | From source |
|---|---|---|
| Operating system | Any system that runs Docker: Linux, macOS, Windows | macOS 13 or later, Linux; Windows through WSL 2 |
| Processor | x86-64 or 64-bit Arm | x86-64 or 64-bit Arm |
| Memory | 1 GB free for a typical district | The same, plus headroom for the compiler during the first build |
| Disk | About 250 MB for the image, plus the map cache | About 1 GB with build outputs and dependencies, plus the map cache |
| Network | HTTPS to OpenStreetMap's Overpass API for new cities; none offline | The same, plus package registries during the first build |
| Browser | A current Chrome, Edge, Firefox or Safari | The same |

## Operating systems

| Platform | Status | Notes |
|---|---|---|
| macOS 13 or later, Apple silicon or Intel | Supported | Native build or Docker Desktop |
| Ubuntu 22.04 and 24.04, Debian 12 | Supported | Built and tested in continuous integration and in the container image |
| Fedora 39 or later, Arch Linux | Expected to work | Same dependencies under other package names |
| Windows 10 and 11 | Through WSL 2 or Docker Desktop | The core uses POSIX process APIs (`posix_spawn`, `popen`, process groups), so there is no native Windows build |

The container image is published for `linux/amd64` and `linux/arm64`, so it runs
natively on Intel and Apple silicon machines and on Arm servers.

## Software

### For Docker

| Software | Minimum |
|---|---|
| Docker Engine or Docker Desktop | 24 |
| Docker Compose | v2 (`docker compose`, not `docker-compose`) |

### For a source build

| Software | Minimum | Used for |
|---|---|---|
| C++ compiler | GCC 12, Clang 15 or Apple Clang 15, with C++20 | The simulation core |
| CMake | 3.22 | Configuring and building the core |
| SQLite 3, with development headers | Any current release | The runtime journal |
| zlib, with development headers | Any current release | Compressing large API responses |
| Node.js and npm | Node.js 20, npm 9 | The operator CLI and the observer build |
| Python 3 | 3.10 | The map downloader and the test suites |
| git | Any | Cloning; CMake also fetches two header-only libraries |
| Eclipse SUMO | 1.15, optional | The microscopic cross-check |

Installation commands for each platform are in [Installation](installation.md#installing-the-prerequisites).

## Hardware sizing

Memory and processor time grow roughly linearly with the number of junctions in the
district. A seed-selected district has about 3,000 junctions by default
(`map.district_nodes`).

| District | Typical source | Memory to allow | Processor at 1× |
|---|---|---|---|
| About 1,200 junctions | The bundled offline district | 1 GB | A small fraction of one core |
| About 3,000 junctions | A seed-selected city, by default | 1 GB (about 800 MB measured) | 5 to 15% of one core |
| Up to 50,000 junctions | A large pinned map with `--max-nodes 50000` | 2 GB | Considerably more; seeking takes longer |

Most of the memory holds checkpoints: the full dynamic state of every node and road,
stored every 15 virtual minutes so that seeking backwards is fast and exact.

The measured figures are from one Apple silicon laptop; measure your own with the
tools in [Performance](../deployment/performance.md). The observer runs in the
browser, and on a modest laptop it, rather than the server, is usually what limits
speed. [Adaptive backpressure](../concepts/backpressure.md) slows the simulation
automatically when the browser falls behind.

### Disk

| Item | Size |
|---|---|
| Container image | About 234 MB; about 1.1 GB with SUMO |
| Source build (`build/`, `node_modules/`, observer bundle) | About 1 GB |
| One cached city extract | 5 to 50 MB, typically 20 to 40 MB |
| Logs and journal | Grows with requests; `./launcher reset` clears it |

The server keeps the newest cached city by default and the container keeps three; see
[Seeds and places: the map cache](../guide/seeds-and-places.md#the-map-cache).

## Browsers

The observer supports current versions of Chrome, Edge, Firefox and Safari on
desktop.

| Requirement | Why |
|---|---|
| A window of at least 1024 × 640 CSS pixels | The map, telemetry and controls need the space; smaller windows show a notice instead of a cramped layout |
| Hardware acceleration enabled (recommended) | The map is redrawn on a canvas many times a second |
| JavaScript and local storage enabled | Preferences are kept in the browser |

Mobile browsers can open the observer but are not a supported way to operate it.

## Network

| Direction | Destination | Purpose | When |
|---|---|---|---|
| Outbound HTTPS | `overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee`, `overpass.osm.jp` | Download a city's map from OpenStreetMap | The first time a seed selects a city |
| Outbound HTTPS | GitHub, npm registry, Debian or Homebrew mirrors | Fetch build dependencies | First build only |
| Inbound TCP 8090 | The DSTNS server | The observer and the API | Always; bound to `127.0.0.1` by default |
| Inbound TCP 8443 | The optional TLS gateway | HTTPS access | Only with the `tls` Compose profile |
| Inbound TCP 5173 | The Vite development server | Observer development | Only with `./scripts/dev.sh` |

Set `DSTNS_OVERPASS_ENDPOINTS` to use a different Overpass instance, for example one
inside your own network. Behind a proxy, set `HTTPS_PROXY` for the downloader and for
Docker builds. Without any network access, run the bundled district or a cached city;
see [Quick start: offline](quick-start.md#offline).

## Related

- [Installation](installation.md): building from source
- [Run with Docker](docker.md): the container path
- [Performance](../deployment/performance.md): measured costs and how to measure them
