# Quality assurance

How DSTNS is verified before a change is accepted, how defects are classified, and
the register of every defect found by code review together with its fix and the test
that now guards it. For the test suites themselves see [Testing](testing.md); for
behaviour that is known and accepted rather than defective see
[Known limitations](../limitations.md).

## Quality gates

Every change to `main` passes the same gates, locally through `./scripts/test.sh`
and in continuous integration on Ubuntu 24.04.

| Gate | Tool | Fails when |
|---|---|---|
| Compilation | CMake, GCC or Clang with `-Wall -Wextra -Wpedantic -Wshadow`; test targets add `-Werror` | Any warning in a test target, any error anywhere |
| Native suites | CTest (14 targets) | Any assertion fails, including determinism and invariant checks |
| HTTP contract | `tests/api/api_smoke.py`, `hardening_smoke.py`, `loading_smoke.py`, `termination_smoke.py` against a real server | A route, status code, error code or security control deviates from the documented contract |
| Reproducibility | `dstns_replay_verify` | Two independent runs of one seed differ in any hash or in the full runtime snapshot |
| Operator CLI | Python and Node suites under `tests/cli/` | The downloader, saved-seed store or launcher misbehaves end to end |
| Observer | `tsc` in strict mode, Vitest, a production `vite build` | A type error, a failing component test, or a bundle that does not build |
| Documentation | `mkdocs build --strict`, OpenAPI validation | A broken link or anchor, a page missing from navigation, an invalid OpenAPI description |
| Container | `docker build`, then a run against the bundled map | The image does not build, or does not reach a running simulation |
| Licensing | `scripts/license-headers.py --check` | A source file lacks its SPDX identifier and copyright line |
| Static analysis | CodeQL (C++, JavaScript and TypeScript, Python, GitHub Actions workflows) | A new high-confidence finding in DSTNS's own code |
| Memory safety | `-DDSTNS_ENABLE_SANITIZERS=ON` (AddressSanitizer, UndefinedBehaviorSanitizer) | Run on demand before releases; any report is a defect |

## Review method

Code review complements the automated gates. A review covers the engine
(`src/engine.cpp`), the HTTP layer (`src/api.cpp`), the SUMO bridge, the OSM loader
and downloader, the logger, the server entry point, the observer's API client,
polling, dialog state and Auto Focus, and the operator CLI's validation, process
management and server launch. It proceeds in four steps:

1. **Baseline.** Configure from clean and run every suite, so that pre-existing
   failures are known before anything changes.
2. **Read.** Read each component line by line against its specification and its
   documentation, looking for undefined behaviour, unchecked conversions, missing
   branches, lock scope, resource lifetimes and trust boundaries.
3. **Prove.** For every suspected defect, write a test that fails on the unfixed code
   and passes on the fix. A test is run against the original source to confirm it
   detects the defect; where a test is impractical (shell quoting, lock scope) the
   fix is verified by inspection and recorded as such below.
4. **Re-verify.** Re-run every suite after each group of fixes.

## Severity

| Severity | Meaning | Examples |
|---|---|---|
| **High** | A security weakness, data loss, or a feature unusable for a class of users | Cross-site request forgery; command injection; a quarter of cities failing to download |
| **Medium** | Wrong results or a broken feature | An undo that does nothing; a SUMO run reported as successful when it failed |
| **Low** | Edge cases, diagnostics and hygiene | A port number that wraps; an imprecise error message |

## Defect register

Every defect below is fixed in engine 2.1.0 and observer 2.3.0, the first public
release. Identifiers are stable and are referenced from the
[release notes](../changelog.md).
The prefix names the area: **U** observer, **P** HTTP platform, **S** SUMO adapter,
**E** engine, **O** OSM loader, **M** map cache, downloader and logging, **C** CLI and
server binary, **T** tools, **D** delivery.

### Observer interface

| ID | Severity | Defect | Fix | Guarded by |
|---|---|---|---|---|
| U1 | Medium | `closeDialog()` schedules the open dialog to be cleared after its 180 ms exit transition. The completion screen called it and then opened the next dialog, so the pending clear removed the new one: "Generate a new world" flashed its confirmation and lost it, and any dialog opened within 180 ms of another closing behaved the same way. | The pending clear is held in a ref; every dialog opens through `openDialog`, which cancels it. "Restart same simulation" asks through the reset confirmation, and a confirmed reset of a finished day plays immediately. | `appShell.test.tsx`: both completion actions assert the confirmation is still present 400 ms later, because `findByRole` polls and would accept a dialog that existed for 180 ms. |
| U2 | Low | The API client parsed JSON before checking the status, so a non-JSON error response (a proxy's 502, an empty 404) was reported as "unreadable response". | Non-JSON error responses report `Request failed (<status>)`. | `api.test.ts` |
| U3 | Low | Dialogs, including About, slid under the header: the workspace is its own stacking context, so the scrim's `z-index` could not lift it above the header. | The workspace is lifted while a dialog is open. | `stacking.test.ts`; visual check |
| U4 | Low | About showed "No run" and coordinates 0.000000, 0.000000 for a pinned map. | Shows "Pinned map", with coordinates marked unavailable. | `appShell.test.tsx` |

### HTTP platform and security

| ID | Severity | Defect | Fix | Guarded by |
|---|---|---|---|---|
| P1 | High | Cross-site request forgery. CORS allowed any origin and no request was checked for where it came from, so any web page the operator visited could pause, seek, override roads or shut the server down with an ordinary form post or `fetch`. | State-changing requests (anything but `GET`, `HEAD`, `OPTIONS`) that carry a browser `Origin` must match the `Host` (or `X-Forwarded-Host`) they were sent to, or appear in `DSTNS_ALLOWED_ORIGINS`; otherwise HTTP 403 `CROSS_ORIGIN_FORBIDDEN`. Clients that are not browsers send no `Origin` and are unaffected. The TLS gateway forwards `X-Forwarded-Host`. | `hardening_smoke.py` |
| P2 | High | `GET /terminate` and `GET /api/v1/system/terminate` shut the process down. A GET can be triggered by an `<img>` tag on any page, without CORS having a say. | Termination is `POST` only. | `hardening_smoke.py` |
| P3 | Medium | Path IDs were parsed with `std::stoul` and narrowed to 32 bits, so `/control/edges/4294967296/override` silently overrode edge 0; signal and node routes behaved likewise. | `path_id()` parses into `uint32_t` and rejects overflow with HTTP 400. | `hardening_smoke.py` |
| P4 | Medium | `time_value` range-checked signed JSON integers only. A non-negative JSON number is parsed as unsigned, so `{"target_time": 999999}` skipped the `[0, 86400]` check and was truncated. | Unsigned values are range-checked too. | `hardening_smoke.py` |
| P5 | Low | `since_news_id` and the log `limit` used `std::stoull`, which accepts `-1` and wraps it to 2⁶⁴ − 1. | `unsigned_parameter()` rejects signs and non-numeric input with HTTP 400. | `hardening_smoke.py` |
| P6 | Medium | `duration_virtual_minutes` was converted from `double` to `uint32_t` unchecked; negative or very large values are undefined behaviour. | Checked as a double, in `[1, 1440]`. | `hardening_smoke.py`, `world_tests.cpp` |
| P7 | Low | `sumo-simulate` accepted any `begin_s` and `end_s`, including an end before the start. | Both are virtual-day times; `begin_s < end_s <= 86400` is required. | `hardening_smoke.py` |
| P8 | Medium | nlohmann::json converts a negative number to an unsigned type by wrapping it, so `POST /control/undo {"count": -1}` reached the engine as 4294967295 and undid the entire history. | The count is read signed and must be in `[1, 10000]`. Other unsigned fields wrap to values their own range checks already refuse. | `hardening_smoke.py` |
| P9 | High | The server bound every interface by default, answered `Access-Control-Allow-Origin: *`, and accepted any `Host`, which together exposed a local run to the network, to any web page, and to DNS rebinding. | Loopback bind by default; CORS only for the server's own origin and `DSTNS_ALLOWED_ORIGINS`; on loopback, unknown `Host` names receive 421 `HOST_NOT_ALLOWED`. | `hardening_smoke.py` |

### SUMO adapter

| ID | Severity | Defect | Fix | Guarded by |
|---|---|---|---|---|
| S1 | High | Command injection. The bundle directory comes from the request body of `/export/sumo` and `/system/sumo-simulate` and was concatenated unquoted into `popen` command lines for `netconvert` and `sumo`. | Every argument is single-quoted for `/bin/sh`, using the same function as the OSM downloader. | Inspection |
| S2 | Medium | SUMO counted as available whenever the binaries existed. On a host where `netconvert` could not start (for example after a package upgrade removed a library it links), `/system/info` reported `available: true` and every simulate call failed with 500. | Both tools must answer `--version` with exit status 0. | `api_smoke.py`, whose SUMO step runs only when SUMO is available |
| S3 | Medium | Exit statuses were ignored. A failed SUMO run returned `ok: true` with zero vehicles, and a stale `network.net.xml` from an earlier run satisfied the "netconvert succeeded" check. | Exit statuses are checked, a failed run raises an error, and the old network file is removed before `netconvert` runs. | Inspection |
| S4 | Low | A fixed home-directory path was used as an installation path and as a fallback `SUMO_HOME`. | Removed. `SUMO_HOME`, the standard prefixes, then `PATH` are searched, and `sumo_home` is derived from the binary found. | Inspection |
| S5 | Medium | `sumo_simulate` held the engine mutex for the entire external SUMO run, which can take minutes, freezing playback and every other API call. | The scenario is copied under the lock and SUMO runs without it. | Inspection |
| S6 | Medium | SUMO runs on real maps failed with `Invalid position for busStop`: stops ended at `max(5 m, position)` on edges that can be shorter, and `netconvert` shortens lanes at junctions. | Positions are clamped to the edge, with `friendlyPos="true"`. | `test_main.cpp` checks every exported stop |
| S7 | Low | SUMO release versions were reported incorrectly: the version pattern missed `Version 1.15.0` and matched the "GPLv2" in the licence text. | The development tag and the release form are each matched exactly. | Verified in the `WITH_SUMO=1` image |

### Simulation engine

| ID | Severity | Defect | Fix | Guarded by |
|---|---|---|---|---|
| E1 | Medium | Undoing a signal toggle did nothing to the signal. `toggle_signal` records a `signal_toggle` command, but `apply_command` had no branch for that type, so undo removed it from history and left the junction forced. | `apply_command` restores the prior phase, or removes the override when the signal was on its own timing plan (recorded as a null phase). | `world_tests.cpp`: toggle, undo, redo |
| E2 | Medium | A backwards seek erased operator edge overrides. `restore_to` reloads whole edge states from a checkpoint; a checkpoint taken before an override has none, so the override vanished while history still listed it as applied. Signal overrides and surges were unaffected. | Manual multipliers and closures are carried across the restore, so overrides stand until undone. | `world_tests.cpp` |
| E3 | Medium | Seeking to 24:00:00 left the run `RUNNING` or `PAUSED`; only playing to the end produced `COMPLETED`. Seeking was also accepted while `TERMINATING` or `PREPARING`. | Reaching the end of the day by any route completes the run, and seeking in those two states is a lifecycle conflict. | `world_tests.cpp` |
| E4 | Medium | Surges accepted any factor and radius (a negative factor produced negative demand), and `virtual_s + duration_s` could wrap `uint32_t`, giving a surge that ended before it started. | Factor in `(0, 10]`, radius in `(0, 20000]` m, duration in `[1, 86400]` s; the end time is computed in 64 bits and capped at midnight. | `world_tests.cpp`, `hardening_smoke.py` |
| E5 | Low | Manual rain longer than a day overflowed its end time. | Duration capped at 1440 virtual minutes. | `world_tests.cpp` |
| E6 | Low | Undoing or redoing a tick-rate change re-anchored the wall clock without first advancing to it, so the new rate applied retroactively from the last anchor. | `catch_up_to_wall_clock()` runs before every rate change: set, undo, redo and ASB governance. | Inspection |
| E7 | Low | The traffic catalogue's `mean_vehicle_speed_mps` summed speeds over traversable edges but divided by all edges, understating it on maps with one-way roads. | Divides by the number of edges summed. | Inspection |
| E8 | Low | `global_view` indexed nodes by a weather epicentre without a bounds check, unlike `snapshot`. | Checked. | Inspection |

### OSM loader

| ID | Severity | Defect | Fix | Guarded by |
|---|---|---|---|---|
| O1 | Medium | Untagged roundabouts were never one-way. Way tags were read with `std::map::operator[]`, which inserts an empty value for a missing key, so reading `tags["oneway"]` created the key and the following "roundabout without a oneway tag" test was always false. The inserted empty `oneway`, `junction` and `access` tags were also exported with every edge. | Tags are read with `find`. | `test_main.cpp` with `tests/fixtures/roundabout.osm.xml`, which fails on the unfixed parser |
| O2 | Low | A node tagged `shop=mall` was classified as a mall and then overwritten as a store by the generic `shop` rule. | The store rule excludes `shop=mall`. | `test_main.cpp` |

### Map cache, downloader and logging

| ID | Severity | Defect | Fix | Guarded by |
|---|---|---|---|---|
| M1 | Low | A downloader killed at session termination leaves its `.progress` sidecar, and nothing removed it, so stale files accumulated in `data/maps`. | The start-up cache sweep removes `.progress` files alongside `.part` files, collecting paths before deleting rather than deleting during iteration; both are ignored by git. | `map_sourcing_tests.cpp` |
| M2 | Low | The downloader's pipe was not close-on-exec. Any other child started meanwhile (a SUMO run) inherited the write end, so the read waiting for the downloader's end-of-file also waited for that child. | `FD_CLOEXEC` on both ends; `dup2` onto the child's stdout and stderr clears it where it is needed. | Inspection |
| M3 | Low | Log forging. The system log wrote request paths and error text verbatim, so a URL containing `%0A` could append forged entries. | Newlines in a message are flattened to spaces. | Inspection |
| M4 | High | Southern-hemisphere cities could never be downloaded on Python before 3.13 (Debian, Ubuntu, the container). The bounding box was passed as `--bbox -33.9,…`, and `argparse` read the leading minus sign as an option. 25 of 181 cities, about one seed in seven, always failed with `MAP_FETCH_FAILED`. Python 3.13 and later accepted it, which hid the defect on newer systems. | `--bbox=VALUE` and `--output=VALUE` are passed as single arguments. | `map_sourcing_tests.cpp` records the downloader's argv through a stub interpreter |

### Operator CLI, server binary and tools

| ID | Severity | Defect | Fix | Guarded by |
|---|---|---|---|---|
| C1 | Medium | The CLI validated `playback.tick_rate` and `--speed` against `(0, 10]` while the engine refuses anything above 5, so a configuration the CLI approved failed when the run started. | A single `MAX_TICK_RATE = 5`, matching the engine's `kMaxTickRate`. | `node --check`, CLI suites |
| C2 | Low | `dstns_server --port 70000` wrapped to 4464 and listened there. | Ports outside `[1, 65535]` are refused. | Manual check |
| C3 | Low | An unused helper in `src/geo.cpp` produced a warning on every build. | Removed. | Clean build |
| T1 | Low | `dstns_replay_verify` accepted only hexadecimal seeds, although users see decimal ones, and parsed `--help` as a seed. | Decimal seeds and `--help` are accepted. | Manual check |

### Delivery

| ID | Severity | Defect | Fix | Guarded by |
|---|---|---|---|---|
| D1 | Medium | The container path was untested and its image was 6.5 GB. | A supported multi-architecture image of about 234 MB, with auto-start, `dstns-run` and an optional TLS profile. | CI container job: offline run; manual checks of online download, SUMO, TLS and cross-origin refusal |
| D2 | Low | The OpenAPI description contained a malformed operation: an unquoted description split into an invalid key. | Corrected; the description is validated in CI. | Documentation job |

## Behaviour changes resulting from fixes

Some fixes change behaviour a user or client may have relied on. Each is also listed
in the [release notes](../changelog.md).

| Change | Caused by | What to do |
|---|---|---|
| Graphs containing untagged roundabouts change: their reverse edges become `synthetic_reverse`, so `graph_hash`, `scenario_hash` and every result downstream change for that map | O1 | Nothing, unless you compare results with an earlier build for such a map; maps without untagged roundabouts are unaffected, and the replay suite confirms the shipped fixtures are unchanged |
| A browser client served from another origin must be allow-listed | P1, P9 | Add its origin to `DSTNS_ALLOWED_ORIGINS`. The Vite development server proxies `/api`, so the default development setup needs nothing |
| Shutdown is `POST` only | P2 | Replace `curl http://…/terminate` with `curl -X POST http://…/terminate` |
| The server listens on `127.0.0.1` unless told otherwise | P9 | Pass `--host 0.0.0.0` or set `DSTNS_BIND`, after reading [Deployment security](../deployment/security.md) |
| "Restart same simulation" asks for confirmation | U1 | None |

## Verification record

Every suite passes on the 2.1.0 release, on macOS (arm64, Apple Clang) and on
Ubuntu 24.04 (GCC) in continuous integration. The counts below are from the macOS
run:

| Suite | Result |
|---|---|
| CTest, 14 targets including `dstns_http_hardening` | All passed |
| `dstns_tests` | 726 assertions passed |
| `tests/api/hardening_smoke.py` | 14 tests passed |
| `tests/api/api_smoke.py` | 134 assertions passed |
| `tests/api/loading_smoke.py`, `termination_smoke.py` | Passed |
| Observer (Vitest) | 24 files, 286 tests passed |
| `tests/cli/test_fetch_osm.py`, `test_seeds.py`, `artifacts.test.mjs` | Passed |
| `tests/cli/launcher_integration.py` | Passed against a real OpenStreetMap district of 1,196 junctions |

The SUMO step of `api_smoke.py` runs only where a working SUMO is installed, and is
exercised in the `WITH_SUMO=1` container image.
