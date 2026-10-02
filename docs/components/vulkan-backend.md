# Vulkan backend

The physics step on any Vulkan 1.2 device. This page is the reference for
`src/vulkan/`; the design, determinism argument and failure handling are in
[Compute architecture](../concepts/compute.md), and operation in
[GPU acceleration](../guide/gpu-acceleration.md).

## Source layout

Nothing outside `src/vulkan/` includes a Vulkan header. The rest of DSTNS sees
`include/dstns/compute/vulkan.hpp` (create a backend, run diagnostics) and
`include/dstns/compute/field.hpp`, which mention no Vulkan type. A build
without Vulkan links `src/vulkan/unavailable.cpp` instead, which reports why.

| File | Responsibility |
|---|---|
| `vk.hpp` | Vulkan through volk; `VulkanError`, which carries whether the committed state survived |
| `loader.cpp` | Finds and opens the Khronos loader, or MoltenVK directly, at run time |
| `context.cpp` | Instance (portability enumeration, validation, debug messenger); device enumeration, scoring and selection; logical device |
| `memory.cpp` | `Buffer`: RAII buffer and memory, memory types chosen by property flags |
| `pipeline.cpp` | Descriptor layouts, specialised compute pipelines, descriptor pools, the on-disk pipeline cache |
| `executor.cpp` | Command pool, timeline semaphore, timestamp queries, barriers |
| `gpu.cpp` | `Gpu`: one opened and self-tested device, shared by every workload |
| `backend.cpp` | `VulkanComputeBackend`: the road-network physics step |
| `field.cpp` | `FieldSolver`: structured-grid field kernels |
| `diagnostics.cpp` | `create_vulkan_backend`, `vulkan_diagnostics` |
| `shaders.hpp` | The embedded SPIR-V bundle, generated at build time |

Every Vulkan object is owned by an RAII wrapper, and owners are declared in
dependency order, so destruction is always: world buffers, pipelines,
layouts, command pool, timeline, device, instance. A constructor that fails
halfway destroys what it had created. There is no global Vulkan state except
the loader's entry point, which is process-wide by nature; instance and
device functions live in per-object dispatch tables.

## Shaders

| Shader | Work |
|---|---|
| `node_step.comp` | Rain from the active storms, flood integration; one invocation per node |
| `edge_step.comp` | Edge environment, demand, signals, speed, queue; workgroup reduction of the congestion index; one invocation per edge |
| `scatter.comp` | Applies the host's changed words (`target[offset] = value`) to the inputs or the committed state |
| `self_test.comp` | The start-up self-test |
| `field_diffusion.comp` | One diffusion step on a structured grid |

All include `shaders/include/dstns_glsl.h`, which supplies the integer types
and includes the shared definitions. The workgroup size is specialisation
constant 0, set per device at pipeline creation (128 where the device allows
it, else 64; `DSTNS_GPU_WORKGROUP` overrides), so one SPIR-V module serves
every vendor. No correctness depends on the subgroup size.

The shaders are compiled to SPIR-V at build time with `glslangValidator` (or
`glslc`), for `vulkan1.2`, and embedded in the binary by
`cmake/EmbedSpirv.cmake`, which also records each module's SPIR-V hash and
source hash and the bundle's hash. No shader is compiled or read from disk at
run time.

`shaders/spirv/` holds the same SPIR-V, committed, with `manifest.txt` giving
the source hash it was built from. A build without a shader compiler uses it;
if the GLSL has changed since, the build disables Vulkan with a warning (or
fails, with `DSTNS_VULKAN_REQUIRED=ON`) rather than ship a kernel that
disagrees with the CPU. After changing a shader, refresh it with:

```bash
cmake --build build --target dstns_refresh_spirv
```

## Device selection

Every device is enumerated and judged. It is *usable* with Vulkan 1.2,
`shaderInt64`, timeline semaphores, a compute queue and workgroups of at least
64. Usable devices are scored:

| Property | Score |
|---|---|
| Discrete GPU / integrated / virtual / other / CPU implementation | 1000 / 900 / 500 / 300 / 50 |
| Vulkan minor version | + 10 each |
| Device-local memory | + 5 per GiB, up to 64 GiB |
| Timestamp queries on the compute queue | + 20 |
| synchronization2 | + 5 |
| A compute-only queue family | + 5 |
| A software implementation, when not allowed | − 1000 |

The highest score wins; ties are broken by device UUID, so the choice does not
depend on enumeration order. Integrated GPUs score close to discrete ones
because unified memory spares them transfers. `DSTNS_GPU_DEVICE` overrides
the choice by enumeration index, UUID or name substring; naming a software
implementation explicitly is allowed.

## Per-world resources

Created when a world is installed, after checking that the largest buffer fits
`maxStorageBufferRange` and `maxMemoryAllocationSize` and that the total stays
under half the device's memory budget (`VK_EXT_memory_budget` when present).

| Buffer | Memory | Contents |
|---|---|---|
| Static tables | device-local | Node and edge constants, uploaded once |
| Inputs | device-local | Controls, couplings, overrides, signal phases |
| State A, state B | device-local | Committed and candidate state; they swap roles every step |
| Partial sums, counters | device-local | Reduction results |
| Parameters, input updates, state patches, dispatch sizes | host-visible, coherent | Written by the host each step |
| Readback | host-visible, cached | What the host reads each step |
| Staging | host-visible, cached | Full uploads and downloads |

Memory types are chosen by flags, never by vendor: device-local memory the
host cannot see where it exists (on a discrete GPU, host-visible device memory
is the small BAR window), host-visible coherent memory for uploads, and
host-cached memory for readback (invalidated before reading when not
coherent). On unified-memory devices these resolve to the same memory. Each
buffer has its own allocation. About ten per world is far below any limit,
which is why VulkanMemoryAllocator, built for thousands of short-lived
allocations, was not adopted. Both state buffers are zero-filled at creation,
padding included.

## The step

Two command buffers, one per parity of the state pair, are recorded when the
world is installed and resubmitted every step. A step re-records nothing
unless a host buffer had to grow. Each contains:

1. A barrier ordering this step after all earlier work.
2. Two indirect dispatches of `scatter`: changed inputs, then patches to the
   committed state. The dispatch sizes are written by the host; zero
   workgroups when nothing changed.
3. Clear the counters; barrier.
4. `node_step`; barrier (the edge pass reads the node results).
5. `edge_step`; barrier.
6. Copy the three host-facing edge fields, the partial sums and the counters
   to the readback buffer; barrier to host reads.

with timestamp queries between the passes where supported. The host writes the
parameters and changed words into mapped buffers, submits once (signalling
the next timeline value), waits for that value with a timeout, reads the
readback buffer, and only then swaps the state pair. There is no
`vkQueueWaitIdle` or `vkDeviceWaitIdle` in the step; `vkDeviceWaitIdle` is
used only when the device is destroyed.

Barriers use `vkCmdPipelineBarrier2` when the device supports
synchronization2 (core in 1.3, or the extension), otherwise
`vkCmdPipelineBarrier`, with the narrowest stage and access masks.

## Pipeline cache

`data/cache/vulkan/<vendor>-<device>/<driver>-<version>/pipeline.cache`
(`--compute-cache` or `DSTNS_VULKAN_CACHE_DIR` move it; empty disables it). The
file begins with the shader bundle's hash, and the driver's own header
(vendor, device, cache UUID) is checked before use. Anything that does not
match or parse is discarded and rebuilt. The cache only speeds up start-up
(about 0.5 s cold against 15 ms warm on an Apple M4) and is never a
correctness dependency.

## Validation

With `validation_layers` (or `DSTNS_VULKAN_VALIDATION=1`), the instance enables
`VK_LAYER_KHRONOS_validation` with synchronisation validation, names its
objects through `VK_EXT_debug_utils`, and reports every message through the
system log. The test suites run under the layers on MoltenVK, KosmicKrisp
and llvmpipe and require zero messages: no errors, no synchronisation
hazards, no leaked objects. Normal operation does not need the layers.

## Log events

Written to `logs/system.log` under the `compute` component:

| Event | When |
|---|---|
| `compute.backend.detected` | Vulkan brought up: device, driver, API version, workgroup, time taken |
| `compute.backend.unavailable` | Vulkan could not be brought up, and why |
| `compute.backend.selected` | Which backend runs a world, and why |
| `compute.calibration` | auto mode's measured CPU and Vulkan step times |
| `compute.backend.fallback` | Vulkan failed; the run continues on the CPU |
| `compute.recovery` | State rebuilt on the CPU after a lost device |
| `compute.device_lost` | The device was lost during a step |
| `compute.verify` | A verification mismatch, with the first differing words |
| `compute.vulkan.validation` | A validation-layer message |
| `compute.vulkan.pipeline_cache` | A cache was discarded or could not be written |

## Build options and dependencies

| CMake option | Default | Meaning |
|---|---|---|
| `DSTNS_ENABLE_VULKAN` | `ON` | Build the Vulkan backend |
| `DSTNS_VULKAN_REQUIRED` | `OFF` | Fail configuration if it cannot be built, instead of building CPU-only |
| `DSTNS_BUILD_SHADERS` | `ON` | Compile the shaders when a compiler is found; otherwise use `shaders/spirv/` |

| Dependency | Version | Licence | How |
|---|---|---|---|
| Vulkan-Headers | 1.4.357 | Apache-2.0 or MIT | Fetched by CMake, pinned by SHA-256 |
| volk | 1.4.357 | MIT | Fetched by CMake, pinned by SHA-256; `volk.c` compiled into the core |
| glslang | any recent | BSD-3-Clause and others | Build time only, optional |
| A Vulkan loader and driver | 1.2+ | — | Run time only, optional: the system's, or MoltenVK on macOS |

No Vulkan SDK is required to build or run DSTNS.
