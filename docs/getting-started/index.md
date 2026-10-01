# Getting started

DSTNS runs in one of two ways. Pick the one that suits you; both give the same
simulator.

<div class="grid cards" markdown>

-   **Docker**

    ---

    Nothing to install but Docker. One command builds the image and starts a
    simulation at `http://localhost:8090`.

    *Best for:* trying DSTNS, demos, servers.

    [Run with Docker](docker.md)

-   **From source**

    ---

    Build the C++ core and the observer on your machine and drive runs from the
    operator CLI, with tests, logs and saved seeds.

    *Best for:* development, research, the full operator toolset.

    [Installation](installation.md)

</div>

Then:

1. [Quick start](quick-start.md): the shortest path to a running simulation, either way.
2. [Your first simulation](first-simulation.md): a guided tour of the interface
   and the ideas behind it.

## What you need

| | Docker | From source |
|---|---|---|
| Operating system | Anything that runs Docker | macOS 13+, Linux; Windows through WSL 2 |
| Software | Docker 24+ with Compose v2 | CMake 3.22+, a C++20 compiler, SQLite, zlib, Node.js 20+, Python 3.10+ |
| Disk | About 250 MB image + map cache | About 1 GB with build outputs and `node_modules` |
| Memory | 1 GB free for a typical 3,000-node district | The same |
| Network | Internet access to download city maps (or use the bundled offline map) | The same |
| Browser | A current Chrome, Edge, Firefox or Safari, window at least 1024 × 640 | The same |

!!! tip "No internet?"
    Both paths include a recorded real district you can run offline. See
    [Run with Docker: offline](docker.md#run-offline) and
    [Quick start](quick-start.md#offline).
