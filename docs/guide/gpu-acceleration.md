# GPU acceleration

DSTNS can run its physics step on a GPU through Vulkan: NVIDIA, AMD and Intel
GPUs on Linux, Apple GPUs on macOS (through MoltenVK and Metal), and GPUs that
WSL 2 exposes. It is an optimisation, never a requirement: a machine without a
usable GPU runs the same simulation on the CPU, and **results are identical on
every backend**, bit for bit. Nothing about a run, its seed, its hashes or its
numbers, depends on which hardware computed it.

How it works is explained in [Compute architecture](../concepts/compute.md).

## Will it be faster?

Only for large worlds. A GPU step has a fixed cost (a submission and a wait,
about half a millisecond) before it does any work, and every simulated second
returns to the CPU for events and demand. A district-sized world of a few
thousand junctions takes a fraction of a millisecond per step on the CPU, so
it stays there. From about 50,000 junctions a GPU starts to win. On an Apple
M4 it is 1.2 to 1.5 times faster than eight CPU threads, up to a
million-junction world; see [Performance](../deployment/performance.md) for
the measured figures.

The default, `auto`, decides this for you: it uses the CPU for small worlds
and, for large ones, measures both on the world itself and keeps the faster.

## Turning it on and off

In the launcher: **Configuration → Compute**. The settings live in the
`compute` section of `config/defaults.json`:

```json
"compute": {
  "backend": "auto",
  "allow_vulkan": true,
  "allow_software_vulkan": false,
  "require_vulkan": false,
  "verification": false,
  "validation_layers": false,
  "device": "auto",
  "gpu_thresholds": { "min_nodes": 40000, "min_edges": 150000 }
}
```

| Setting | Meaning |
|---|---|
| `backend` | `auto` uses a GPU only where it is measured faster; `cpu` never uses one; `vulkan` uses one for every world |
| `allow_vulkan` | `false` switches GPU acceleration off whatever `backend` says |
| `device` | `auto`, a device index, a device UUID, or part of its name (`"M4"`, `"Radeon"`), when several are present |
| `require_vulkan` | With `backend: vulkan`, refuse to start without a working GPU instead of falling back to the CPU |
| `allow_software_vulkan` | Allow CPU implementations of Vulkan such as llvmpipe. For testing; slower than the CPU backend |
| `verification` | Recompute every GPU step on the CPU and compare. For diagnosis; much slower |
| `validation_layers` | Run with the Khronos validation layers, when installed. For development |
| `gpu_thresholds` | In `auto` mode, worlds below both sizes stay on the CPU without measuring |

For one run, from the command line:

```bash
./launcher start --compute cpu
./launcher start --compute vulkan --gpu-device Radeon
```

or with environment variables, which take precedence over the configuration
file (see [Environment variables](../reference/environment-variables.md#compute)):

```bash
DSTNS_COMPUTE_BACKEND=vulkan DSTNS_GPU_DEVICE=1 ./launcher start
```

The backend is chosen by the server when it starts. A launcher that attaches
to a server already running says so if that server's backend differs from the
configuration; restart the server to apply a change.

## Checking a machine

```bash
./launcher diagnostics gpu
```

```text
 GPU acceleration
 Policy           auto: CPU below 40,000 nodes and 150,000 edges; above, whichever is measured faster
 Vulkan loader    libvulkan.1.dylib · instance 1.3.0
 Selected         Apple M4 · MoltenVK → Metal · Vulkan 1.3.357

 #    Device                            Driver       Type        Vulkan   Self-test
 0    Apple M4                          KosmicKrisp  integrated  1.3.354  passed
 1    llvmpipe (LLVM 22.1.8, 128 bits)  llvmpipe     cpu         1.4.354  passed
 2 *  Apple M4                          MoltenVK     integrated  1.3.357  passed
 [OK]    GPU acceleration available  tested in 0.8 s
```

Each device is brought up for real: buffers allocated, every pipeline
compiled, a kernel dispatched and its answer checked. A library being
installed is not enough. The command exits with status 3 when the simulation
would run on the CPU. The same test runs in the launcher's environment check,
cached so that it costs a millisecond once it has run, and under
**Diagnostics → GPU diagnostics** in the terminal interface.

Without the launcher:

```bash
./build/dstns_server --gpu-diagnostics      # JSON report; exit 0 or 3
curl -s localhost:8090/api/v1/system/compute # the running server's backend and timings
```

The observer shows the active backend in the telemetry deck's stack view and
in **About**.

## Preparing a machine

```bash
./launcher bootstrap --check           # what is present and what would be installed
./launcher bootstrap                   # install it, after asking
./launcher bootstrap --yes --profile full
```

The bootstrap detects the platform and its package manager (Homebrew, apt,
dnf, pacman), checks every dependency by running it or finding its headers,
and builds one installation plan, shown before anything runs. It asks for
`sudo` once, uses only package names from its own manifest, and checks
everything again afterwards.

| Profile | Prepares |
|---|---|
| `minimal` | Compiler, CMake, Python, SQLite and zlib headers |
| `standard` (default) | `minimal`, Node.js for the observer, and the Vulkan runtime (loader, MoltenVK on macOS, `vulkaninfo`) |
| `full` | `standard`, Eclipse SUMO, and the shader compiler (glslang) |

It never installs GPU drivers, kernel modules or Homebrew itself. Those
change a system in ways that need a person's judgement; the plan says what to
do instead.

## Platforms

### macOS

macOS has no native Vulkan driver. DSTNS uses **MoltenVK**, which implements
Vulkan on Metal, on Apple silicon and on Intel Macs with Metal-capable GPUs:

```bash
brew install molten-vk vulkan-loader     # or: ./launcher bootstrap
```

DSTNS finds the Khronos loader first, which also finds any other installed
driver (Mesa's KosmicKrisp, for instance) and the validation layers. Without
the loader it opens MoltenVK directly. It enables the portability extensions
MoltenVK needs and checks the device's portability subset. No full LunarG SDK
is needed to run DSTNS, and none to build it: the build fetches pinned Vulkan
headers and the shaders come precompiled.

### Linux

DSTNS uses whatever Vulkan driver the system has; it is vendor-neutral and
needs no CUDA.

| GPU | Driver to have installed |
|---|---|
| NVIDIA | The proprietary driver; it includes Vulkan |
| AMD | Mesa's RADV (`mesa-vulkan-drivers` on Debian and Ubuntu, `vulkan-radeon` on Arch) or AMD's driver |
| Intel | Mesa's ANV (`mesa-vulkan-drivers`, `vulkan-intel`) |

plus the loader (`libvulkan1`, `vulkan-loader` or `vulkan-icd-loader`).
`./launcher bootstrap` installs the loader; it leaves drivers to you.

### WSL 2

WSL 2 exposes the Windows GPU through `/dev/dxg`; Vulkan reaches it through
Mesa's D3D12 driver (Dozen). Keep the Windows GPU driver current and install
`mesa-vulkan-drivers` in the distribution. Where that path is not available,
DSTNS runs on the CPU, which is still the right choice for ordinary worlds.

### Docker

A container sees a GPU only if the host passes it in, so the image runs the
CPU backend by default. For a GPU on a Linux host, build the image with the
Vulkan runtime and pass the device in:

```bash
docker build -t dstns --build-arg WITH_VULKAN=1 .
docker run --device /dev/dri -e DSTNS_COMPUTE_BACKEND=auto -p 8090:8090 dstns
```

NVIDIA GPUs additionally need the NVIDIA Container Toolkit (`--gpus all`).
See [Docker](../deployment/docker.md).

## Troubleshooting

| Symptom | Cause and remedy |
|---|---|
| `no Vulkan loader or driver library was found` | Install the loader (`./launcher bootstrap`); on macOS also MoltenVK |
| Only `llvmpipe` is listed | No hardware driver: install your GPU's Vulkan driver (above). llvmpipe is used only when allowed explicitly |
| A device shows `no 64-bit shader integers` | It cannot run the fixed-point step; DSTNS uses another device or the CPU |
| `the world needs a … storage buffer` | The world is too large for that device's limits; it runs on the CPU |
| `Requested layer "VK_LAYER_KHRONOS_validation" failed to load` (Homebrew) | Homebrew's layer manifest names the library without a path. Run with `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`. DSTNS carries on without the layer either way |
| The system log shows `compute.backend.fallback` | Vulkan failed mid-run; the run continued on the CPU without losing a step. `GET /api/v1/system/compute` gives the reason under `last_failure` |
| `auto` stays on the CPU for a large world | It measured the CPU as faster on this machine; `selection_reason` and `calibration` in `/api/v1/system/compute` show the figures. `--compute vulkan` forces the GPU |

The [Vulkan backend](../components/vulkan-backend.md) reference lists every
log event.
