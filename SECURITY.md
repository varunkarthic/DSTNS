# Security Policy

DSTNS is an open-source traffic simulator. It has a network-facing HTTP API, two simulation engines
behind it (core-ng and core-legacy), a browser observer, a terminal launcher, an interface for
third-party applications (WebFabric) and an interface for AI clients (the MCP Handler). This policy explains how to report a vulnerability, what happens after a
report, what is in scope, and how DSTNS protects itself and the people who use it.

It follows the conventions of
[coordinated vulnerability disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html).

| To… | Go to |
|---|---|
| Report a vulnerability | [Report a vulnerability](https://github.com/varunkarthic/DSTNS/security/advisories/new) (private) |
| See published advisories | [Security advisories](https://github.com/varunkarthic/DSTNS/security/advisories) |
| Read the full security design | [Fabric and WebFabric security](docs/api/security.md) and [deployment security](docs/deployment/security.md) |
| Harden an installation | [Running DSTNS safely](#running-dstns-safely) |
| See what this version protects | [Security in this version](#security-in-this-version) |

**This policy describes** engine 3.13.4 (core-ng 1.2.2), launcher 3.16.1, observer 3.9.0 and API contract 1.13,
on the `v3-core-ng` branch.

---

## Contents

1. [Supported versions](#supported-versions)
2. [Reporting a vulnerability](#reporting-a-vulnerability)
3. [What happens after a report](#what-happens-after-a-report)
4. [Disclosure](#disclosure)
5. [Scope](#scope)
6. [Safe harbor](#safe-harbor)
7. [Security model](#security-model)
8. [Security in this version](#security-in-this-version)
9. [Known limitations](#known-limitations)
10. [Secrets and sensitive files](#secrets-and-sensitive-files)
11. [Network connections DSTNS makes](#network-connections-dstns-makes)
12. [Running DSTNS safely](#running-dstns-safely)
13. [How this repository is protected](#how-this-repository-is-protected)
14. [Security history](#security-history)

---

## Supported versions

| Version | Branch or tag | Status |
|---|---|---|
| **3.13.x** (engine 3.13.4, core-ng 1.2.x, launcher 3.16.x, observer 3.9.x, API 1.13) | `v3-core-ng`, the default branch | **Supported.** Fixes land here first. |
| 3.0.x to 3.12.x | `v3`, tag `v3.0.0` | Reports are accepted; fixes are made on `v3-core-ng` and reach `v3` when it merges. Upgrade to 3.13.x. |
| 2.1.x | `main`, tag `v2.1.0` | Critical and high-severity fixes only, until `v3` merges into `main`. |
| 2.0.x and older | tags before `v2.1.0` | Not supported. Upgrade to the current version. |

Both engines in a supported release are supported, including core-legacy while it is disabled by default.

A report must name the affected revision. Include the output of these commands:

```bash
git rev-parse HEAD
./build/dstns_server --version
./launcher version
```

---

## Reporting a vulnerability

> [!IMPORTANT]
> **Do not open a public issue, pull request or discussion for a suspected vulnerability.** A public
> report gives an attacker the same information as the maintainer, before a fix exists.

Use GitHub's private vulnerability reporting. It is enabled for this repository.

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**, or go directly to
   [the private reporting form](https://github.com/varunkarthic/DSTNS/security/advisories/new).
3. Complete the form with the information below.

This creates a private draft advisory that only you and the repository owner can see. All further
discussion takes place there.

### What to include

A good report lets the problem be reproduced in minutes.

| Item | Details |
|---|---|
| **Summary** | What is wrong, and which component is affected. Use the component names in [Scope](#scope). |
| **Impact** | What an attacker gains, and what they need first: network access to the port, a victim who opens a page, a registered application, local access as the same user. |
| **Version** | The commit hash, the outputs of `dstns_server --version` and `launcher version`, the operating system, the compiler or Docker image digest, and how DSTNS was installed. |
| **Configuration** | How the server was started: `--host`, any proxy or TLS in front of it, and every `DSTNS_*` variable and launcher setting that relates to the problem. **Remove secrets.** |
| **Reproduction** | Numbered steps that use the bundled map (`data/fixtures/real_network.osm.xml`) and a fixed seed, with the exact requests and responses. A script is welcome. |
| **Suggested severity** | Optional. A CVSS v4.0 vector helps. |
| **Suggested fix** | Optional. |

Never include real credentials, `logs/operator.token`, `logs/fabric-apps.json.key`, API keys, private
keys or another person's data. Replace each secret with a placeholder such as `<TOKEN>`.

### Report template

```text
Component:        (for example: Fabric API, WebFabric, launcher console)
Affected version: (commit hash, dstns_server --version)
Environment:      (OS, install method, --host, proxy, relevant DSTNS_* settings)
Prerequisites:    (what the attacker needs first)

Steps to reproduce:
1.
2.
3.

Expected result:
Actual result:
Impact:
CVSS v4.0 vector (optional):
```

---

## What happens after a report

| Step | What happens |
|---|---|
| 1. Receipt | The owner reads the report in the private advisory and confirms receipt there. |
| 2. Triage | The owner reproduces the problem, decides whether it is in scope, and agrees a severity with you, using CVSS v4.0. |
| 3. Fix | The fix is developed privately, in the advisory's temporary fork when that is useful, with a regression test that fails before the fix and passes after it. |
| 4. Release | The fix lands on the supported branch. The commit message names the problem without step-by-step exploit details. |
| 5. Advisory | A GitHub Security Advisory is published for a confirmed vulnerability that affects a published version, with a CVE requested through GitHub when appropriate. It names the affected versions, the first fixed commit, and any workaround. |
| 6. Credit | The reporter is credited by name or handle in the advisory and the changelog, unless they prefer not to be. |

DSTNS is maintained by one person. **There is no guaranteed time to respond or to fix, and there is no
bug bounty.** Reports are assessed as time allows, and the most severe come first. If a report gets no
reply in the advisory after a reasonable time, add a comment to the advisory as a reminder. Do not move
the report to a public channel.

### Severity

| Severity | Typical examples for DSTNS |
|---|---|
| **Critical** | Code execution on the host from the network or from a web page; reading or writing arbitrary files on the host |
| **High** | Bypass of the operator credential, of application capabilities or of Advanced Security; command injection through a request; one application taking another's identity; cross-site scripting in the observer |
| **Medium** | Cross-site request forgery or DNS rebinding that changes a run; a single small request that exhausts memory or crashes the server; a secret written to a log |
| **Low** | Information that helps another attack; a hardening gap with no demonstrated impact |

---

## Disclosure

Please keep the details private until a fix is published. If you intend to disclose publicly, tell the
owner your planned date in the private advisory so that the disclosure can be coordinated. **The default
is 90 days from the report**, or the publication of the fix if that is earlier. Both sides can agree to
another date. A vulnerability that is under active exploitation may be disclosed earlier, with a
workaround.

---

## Scope

### In scope

Vulnerabilities in the code and configuration in this repository.

| Component | Where | Examples |
|---|---|---|
| **Fabric API** | `Fabric/src/` | Bypass of the operator credential; cross-site request forgery; DNS rebinding; CORS that lets another site read a run; a single request that uses unbounded memory or processor time |
| **WebFabric** | `Fabric/src/webfabric/`, `WebKit/src/webfabric/` | One application using another's identity or grants; a capability used without a grant; a forged, altered or replayed signed request; a bypass of the store seal or the audit hash chain; escape from the application frame sandbox |
| **Daemons** | `Daemon/`, `Fabric/src/routes_daemon.cpp` | Reading the daemon queues without a token; changing a daemon without the operator credential; a crafted `config/daemon-alerts.json` that crashes the server |
| **Simulation engine** | `Core/common/src/`, `Core/core-ng/src/`, `Core/core-legacy/src/` | Memory-safety errors, integer wrap-around or out-of-range access from request values, saved seeds, checkpoints (including core-ng's deflated checkpoints) or configuration files; a request sequence that crashes the server or leaves a lifecycle or world job outside its table |
| **Engine governance** | `Core/engines/`, `Fabric/src/gate.cpp`, `config/engines.json` | Running a disabled engine; running an alpha or beta engine without a person's acknowledgment; an approval that outlives its run or can be given by an application; `config/engines.json` making an engine look more stable than its build |
| **Selection policies** | `Core/core-ng/src/selection.cpp` | A `map_selection` (countries, cities, exclusions) that escapes validation, exhausts memory or changes another policy's fingerprint |
| **Map pipeline** | `Core/common/src/osm.cpp`, `Core/common/src/osm_fetch.cpp` | Crashes, resource exhaustion or code execution from a crafted OpenStreetMap file; command injection in the map downloader; writing outside the map cache |
| **SUMO adapter** | `Core/common/src/sumo_bridge.cpp` | Shell injection; writing outside the requested directory |
| **Observer** | `WebKit/src/` | Cross-site scripting or script injection from map tags, news messages, application content, notifications or report content; a crash caused by event or application data |
| **Launcher** | `LaunchKit/` | A bypass of Advanced Security; a model suggestion that runs without the person's confirmation or passes the [suggestion checker](docs/guide/console.md) with a forbidden command; a secret written to a log or a terminal; unsafe temporary files; a process left running after the launcher stops it |
| **MCP Handler** | `LaunchKit/src/modules/mcp.rs` | A tool that changes the simulation while `mcp.allow_writes` is off; a launcher tool that runs while `mcp.allow_launcher` is off or Advanced Security is on; a client changing the settings that limit it, or reading model addresses or keys |
| **Launch codes** | `LaunchKit/src/state.rs` | Reading API keys from a code without its passphrase; a code that applies a value the launcher would refuse; a code that changes a security setting |
| **Reset** | `LaunchKit/src/maintenance.rs` | A reset that deletes outside the repository, or keeps a scope it says it cleared (such as `keys`) |
| **Container image** | `Dockerfile`, `docker/` | Privilege escalation; a secret built into the image; an entrypoint that runs as root |
| **Supply chain** | `.github/workflows/`, lock files | A vulnerable or malicious dependency, workflow or build step that affects a released artifact |
| **Documentation** | `docs/` | An instruction that leads a reader to an insecure configuration |

### Out of scope

| Area | Reason |
|---|---|
| Reading run state from a server you can reach | By design, reads are open. Run state is not confidential. Do not simulate private data on a shared server. |
| A `4xx` refusal logged as a warning | By design since 3.13.2: only `5xx` answers are errors. A refusal that should have been a `5xx`, or the reverse hiding a fault, **is** in scope. |
| Choosing core-legacy after enabling it, or accepting an unstable engine's risk | The operator's decision; the observer and the launcher say what it means |
| Use of the older routes without a credential (`/api/v1/playback/*`, `/api/v1/control/*`, `/terminate`, `/api/v1/world/regenerate`, `/api/v1/system/backpressure`) by a program that can reach the port | Kept for compatibility, and documented. Set `DSTNS_LEGACY_API=off` to close them. Use from another web page **is** in scope. |
| A program on the same machine that sends `X-DSTNS-Host` | The host header stops browsers, not local programs. See [Known limitations](#known-limitations). |
| An attacker who runs as the same operating-system user, or as root | Outside the threat model. Such an attacker can read the files and the process memory. |
| Denial of service by request volume | Needs a rate-limiting proxy. Exhaustion from one small request **is** in scope. |
| An action that a granted capability allows | A grant is trust. The audit log records what the application did. |
| A command that the operator approved | Approval is the protection. Read a proposal before approving it. |
| Content that an application shows inside its own frame | A frame can show anything inside its own rectangle, like any web page. |
| Vulnerabilities in third-party services (OpenStreetMap, the Overpass mirrors, Groq, Ollama, Read the Docs, GitHub) | Report them to those services. |
| Scanner output with no demonstrated impact | Not actionable without a working proof of concept. |
| Missing security headers on the documentation site | The site is static and hosted by Read the Docs. |

---

## Safe harbor

Research that is done in good faith under this policy is authorised. The owner will not pursue legal
action against it, and will say so if a third party asks. Good faith means:

- you test only against an installation that you own and run yourself, never against another person's
  instance;
- you do not access, change, keep or share data that is not yours, and you stop and report if you find
  any;
- you avoid harm: no denial of service against shared systems, no spam, no social engineering, no
  physical attacks;
- you give a reasonable time for a fix before disclosure, as described in [Disclosure](#disclosure).

If you are not sure whether something is allowed, ask in a private advisory first.

---

## Security model

DSTNS is a **single-operator** tool. It is designed for one person on one machine, with the server bound
to loopback. It has no user accounts, no roles and no isolation between tenants. Its protections are
strong against web pages in the operator's browser and against applications that the operator connects.
They do not replace an authenticating gateway when the server is exposed to a network.

### Who can do what

| Caller | How the server recognises it | What it can do |
|---|---|---|
| Anyone who can reach the port | Nothing | Read the run, the map, the list of applications, the audit log and the daemon summary (`GET /api/v1/daemon`) |
| The observer | `X-DSTNS-Host`, from the server's own origin | Control the engine, grant and revoke capabilities, read the daemon queues |
| The operator | `X-DSTNS-Operator` with the operator credential | Everything the observer can do, plus start and prepare runs, and change the daemons |
| An application | `Authorization: Bearer <token>`, and a signature when one is required | Its own surfaces, the daemon queues, and what a person has granted it |
| An application frame | Nothing: it has an opaque origin | Post messages to the observer, each checked against its application's grants |
| An AI client, through the MCP Handler | The launcher's settings | Nothing while `mcp.enabled` is disabled (the default); reads when it is enabled; changes only as `mcp.allow_writes` and `mcp.allow_launcher` allow; never the settings that limit it |
| A person, for an unstable engine | The observer's risk dialog, or `--accept-risk` in the launcher | Accept or reject one run on an alpha or beta engine; the approval lives only on the server and only for that run |

### Controls

| Control | Protects against | Where |
|---|---|---|
| Loopback bind by default (`127.0.0.1`) | Exposure of the API to the network | `Core/server/main.cpp`, `docker-compose.yml` |
| `Host` allow-list while bound to loopback, for reads too (`421 HOST_NOT_ALLOWED`) | DNS rebinding | `Fabric/src/guards.cpp` (`host_allowed`) |
| `Origin` check on every request that changes state (`403 CROSS_ORIGIN_FORBIDDEN`) | Cross-site request forgery | `Fabric/src/guards.cpp` (`same_origin`) |
| CORS only for the server's own origin and `DSTNS_ALLOWED_ORIGINS` | Another site reading a run | `Fabric/src/guards.cpp` |
| Operator credential, 256 bits from the secure generator, or `DSTNS_OPERATOR_TOKEN` | A reachable client choosing what runs | `Core/server/main.cpp`, `Fabric/src/support.cpp` |
| Constant-time comparison of every secret | Timing attacks on tokens and signatures | `Fabric/src/support.cpp` (`same_secret`) |
| Application tokens of 256 bits, stored only as SHA-256 | Recovery of a token from the store | `Fabric/src/webfabric/registry.cpp` |
| HMAC-SHA256 request signing over method, target, timestamp, nonce and body digest; a ±60 s window; single-use nonces of 8 to 128 characters | Altered or replayed requests | `Fabric/src/webfabric/registry.cpp` |
| Signed response digests (`X-DSTNS-Content-SHA256`, `X-DSTNS-Response-Signature`) | Altered responses | `Fabric/src/webfabric/` |
| Store sealed with an HMAC under a key kept apart from it (`fabric-apps.json.key`) | Editing the application store while the server is stopped | `Fabric/src/webfabric/registry.cpp` |
| SHA-256 hash chain over the audit log, with `GET /api/v1/fabric/audit/verify` | Silent rewriting of the record | `Fabric/src/webfabric/registry.cpp` |
| Capabilities checked on the server for every request; sensitive ones only by a person | An application acting beyond what a person allowed | `Fabric/src/webfabric/` |
| `sandbox="allow-scripts"` frames with no same-origin, and a Content Security Policy | An application page reaching the observer or another application | `WebKit/src/webfabric/`, `Fabric/src/` |
| `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `no-store` | Clickjacking, content sniffing, leaked addresses, cached responses | `Fabric/src/guards.cpp` |
| Lookup tables without a prototype, and `Map` for names from events and applications | Names such as `constructor` reaching `Object.prototype` | `WebKit/src/` |
| Request bodies limited to 16 MiB; range checks on every ID, time, count and bound; limits on everything an application can create | Wrap-around, out-of-range values and memory exhaustion | `Fabric/src/`, `Core/common/src/engine.cpp` |
| POST-only shutdown | Shutdown from a link or an image | `Fabric/src/` |
| Single-quoted shell arguments, close-on-exec pipes, a private process group for each child | Command injection through paths; orphaned child processes | `Core/common/src/osm_fetch.cpp`, `Core/common/src/sumo_bridge.cpp`, `LaunchKit/src/process.rs` |
| Download stall limit (200 s, `DSTNS_MAP_STALL_S`) and size limits on maps | A download or a map that never ends | `Core/common/src/osm_fetch.cpp` |
| UTF-8 repair and a JSON serialisation guard | Hostile or corrupt map text in responses and logs | `Core/common/src/utf8.cpp`, `Core/common/src/osm.cpp` |
| Single-line log messages | Log forging | `Core/common/src/logging.cpp` |
| Operator-only changes to the daemons (`403 OPERATOR_REQUIRED`), token-only reads of their queues | An unknown client silencing or reading alerts | `Fabric/src/routes_daemon.cpp` |
| **Advanced Security** (`security.advanced`): the system's own prompt (Touch ID or the password on macOS, polkit or sudo on Linux, Windows Hello or sudo under WSL) before the launcher changes anything; changing the setting itself always asks | A program, or another person at an unlocked machine, changing the launcher | `LaunchKit/src/security.rs` |
| Verification passed only to launchers that the verified launcher starts (`DSTNS_VERIFIED_BY` must name the parent, and the parent must be the same program) | A shell that sets the variable itself | `LaunchKit/src/security.rs` |
| MCP Handler off by default; writes and launcher tools behind separate settings; under Advanced Security, no launcher tool that changes anything, and changes only to Fabric applications | An AI client doing more than the operator allowed | `LaunchKit/src/modules/mcp.rs` |
| `mcp.enabled`, `mcp.allow_writes`, `mcp.allow_launcher`, `security.advanced` and `api.host` changeable only by the person at the machine; model addresses and keys shown to clients as `(kept on this machine)` | An AI client raising its own permissions or learning where models are | `LaunchKit/src/modules/mcp.rs` |
| Engine policy (`config/engines.json`): disabled engines refused with `403 ENGINE_DISABLED`; the build, not the file, decides an engine's channel; `DSTNS_ENGINE_CHANNEL` can mark an engine less stable, never more | Running code the operator turned off, or presenting an unstable engine as stable | `Core/engines/`, `Fabric/src/gate.cpp` |
| Unstable-engine gate: a start on an alpha or beta engine is held (`202 approval_required`), nothing is compiled or downloaded, and everything that would run it is `409 APPROVAL_REQUIRED` until a person accepts; stop and reset cancel it | An unreviewed engine running unattended, or an application approving it | `Fabric/src/gate.cpp`, `WebKit/src/panels/` |
| Lifecycle and world-job tables checked on every transition, and an `ERROR` logged for one outside them | A request sequence leaving the server in an undefined state | `Core/core-ng/src/lifecycle.cpp`, `Core/core-ng/src/world.cpp` |
| Selection policies validated before anything is read or fetched; lists of at most 200 IDs of 1 to 64 characters | Hostile `map_selection` values | `Core/core-ng/src/` |
| Launch-code keys sealed with PBKDF2-HMAC-SHA256 (210,000 rounds) and encrypt-then-MAC; a 4-byte checksum refuses a damaged code; every restored value validated (a speed must be in (0, 10]) | Keys read from a pasted code; a code applying values the launcher would refuse | `LaunchKit/src/state.rs` |
| SUMO can be turned off (`DSTNS_SUMO=0`): its routes then answer `403 SUMO_DISABLED` and the server never looks for SUMO | Running an external toolchain the operator does not use | `Fabric/src/`, `Core/common/src/sumo_bridge.cpp` |
| Model suggestions shown, never run by themselves, and refused if they substitute, redirect, chain with `;` or `\|\|`, use an unknown command, leave, open a shell, edit or write files, change Advanced Security or set the environment | A model's answer turning into an unsafe command | `LaunchKit/src/assistant.rs` (`check`) |
| Non-root container user (UID 10001), no Docker socket | Escalation from a compromised process | `Dockerfile` |
| Optional HTTPS (`-DDSTNS_TLS=ON`, `--tls-cert`, `--tls-key`) | Traffic read on the network | `CMakeLists.txt`, `Core/server/main.cpp` |

The full design, with how to check each control, is in [Fabric and WebFabric security](docs/api/security.md)
and [deployment security](docs/deployment/security.md).

---

## Security in this version

What changed for security between Release 3.0.0 and this version, and how each change was checked.

| Version | Change | Checked by |
|---|---|---|
| Launcher 3.4.0 | An AI client could change, through `launcher_config_set`, the settings that limit it (`mcp.allow_writes`, `mcp.allow_launcher`, `mcp.enabled`, `security.advanced`, `api.host`). Only the person at the machine may now change them | A launcher test that fails when the guard is removed |
| Launcher 3.4.0 | `launcher_config_get` gave model addresses to the AI client. Addresses and credentials now show as `(kept on this machine)` | Launcher tests |
| Launcher 3.5.0 | Launch codes record the world's engine and map rules, so a code can no longer start a world on an engine other than the one it names | Launcher tests |
| Engine 3.5.0 | SUMO is off by default in the launcher; `DSTNS_SUMO=0` refuses its routes | `dstns_http_sumo_switch` |
| Engine 3.6.0 | Engine identity, `config/engines.json` and the unstable-engine gate | `dstns_http_engine_gate` |
| Engine 3.2.1, 3.3.1 | Seven faults in the lifecycle and world job (for example a staged world that could never be installed but read `staged`) | `dstns_lifecycle_ng`, 48 races |
| Engine 3.13.0 | core-legacy disabled by default (`403 ENGINE_DISABLED`); `auto_switch` off, so rejecting an unstable engine only stops | `dstns_http_engine_switch` |
| Engine 3.13.2 | A refused request (`4xx`) is logged as a warning, so the error log holds only faults | HTTP suites |
| Engine 3.13.3 | **Undo or redo after a reset crashed the server** (a null dereference, found under AddressSanitizer). Commands now need a world | `tools/stress/lifecycle.py` under AddressSanitizer, 1,000 requests twice |
| Engine 3.13.3 | Discarding a failed prepared world, and confirming a staged world twice, are now idempotent | The stress tool, in CI |
| Launcher 3.15.0 | A launch code restored an out-of-range speed, which the server refused. Codes now record the tick rate and restore only a valid one | Launcher tests |

The stress tool (`tools/stress/lifecycle.py`) sends paced random requests from four clients and requires no `5xx`,
no `ERROR` in the log and a clean start afterwards. It runs in CI on every push to `main`, `v3` and `v3-*`.

---

## Known limitations

These are limitations of the design. Reports about them alone are out of scope, but a way to exploit them
beyond what is written here is in scope.

- **Reading is open.** Anyone who can reach the port can read the run, the map, the audit log and the
  daemon summary.
- **The older routes have no credential.** They stay open for compatibility. A page from another site is
  still refused, but a local program can use them. Set `DSTNS_LEGACY_API=off` to close them.
- **The host check stops browsers, not programs.** On a shared machine, or with a server bound beyond
  loopback, a program can send `X-DSTNS-Host` and act as the observer.
- **Plain HTTP by default.** HTTPS needs the `DSTNS_TLS` build option, or a TLS gateway in front.
- **Same-user attackers.** A process that runs as the same user can read the store's key, the operator
  token, `config/launcher.env` and the process memory.
- **Storage is not encrypted at rest.**
- **An unstable engine's approval is per run, not per person.** Whoever can reach the observer when a start is held
  can accept it. Keep the server on loopback, or behind a gateway, if that matters.
- **core-legacy is kept for comparison.** It receives fixes to the host it shares, but no new hardening of its own.
- **The audit log is in memory.** It is lost on restart, and the oldest entries leave after 2,000. The
  chain proves consistency, not truth: keep the head elsewhere to detect a rebuilt chain.
- **Advanced Security guards the launcher's ways in, not the files.** It is not a sandbox. A program that
  runs as the same user can still edit the configuration files directly.
- **Frames can do what any web page can,** inside their own rectangle, including showing a convincing form.
- **The launcher keeps typed lines as they are.** Its log and its command history record every line typed
  at the command bar, including any secret in it. See [Secrets and sensitive files](#secrets-and-sensitive-files).

---

## Secrets and sensitive files

None of these files is tracked by Git. Keep them private and never commit them. Secret scanning with
push protection is enabled for this repository as a second line of defence.

| File or variable | Holds | Notes |
|---|---|---|
| `logs/operator.token` | The operator credential | Created at each start, unless `DSTNS_OPERATOR_TOKEN` is set |
| `DSTNS_OPERATOR_TOKEN` | A fixed operator credential | Use a value with at least 256 bits of entropy |
| `logs/fabric-apps.json` | Registered applications: token hashes, signing keys, grants | Sealed; a changed file is refused |
| `logs/fabric-apps.json.key` | The key that seals the store | Keep it apart from backups of the store |
| `config/launcher.env` | Launcher environment, including `DSTNS_GROQ_API_KEY` if one is set | Read by the launcher only |
| `config/apps.json` (or `DSTNS_APPS_FILE`) | The operator's application catalogue | May contain commands and paths; written only by the launcher |
| `config/engines.json` | The engine policy | Not a secret, but it decides which engines may run; the server never trusts its channel or version |
| A launch code made with `--keys` | API keys, sealed with your passphrase | Share the passphrase separately from the code |
| `logs/launcher.log`, `logs/command-history` | The launcher's action log, and every line typed at its command bar | **Lines are kept as typed.** A secret typed on the command line, such as `model key <KEY>` or `env set DSTNS_GROQ_API_KEY=<KEY>`, is written to both. Put keys in `config/launcher.env` with an editor, or in the environment, instead |
| Other files in `logs/` | Run logs, checkpoints and exports | May contain seeds and paths. The server writes no token values to them |

---

## Network connections DSTNS makes

DSTNS makes no connection that the operator did not configure or start. It has no telemetry.

| Connection | When | What is sent |
|---|---|---|
| Overpass API mirrors (`overpass-api.de`, `overpass.openstreetmap.fr`, `maps.mail.ru`, `overpass.private.coffee`) | A city that is not in the cache is prepared | The bounding box of the city extract |
| Groq (`api.groq.com`) | Only with `model.provider = groq` and a key | The plain-language request and the launcher's command catalogue |
| Ollama, or another Chat Completions endpoint | Only if configured, usually on the same machine | The plain-language request, or the facts for Realistic News |
| Apple Foundation Models (`fm`) | On a Mac that supports them, when chosen | Nothing leaves the machine |
| Clients of the server's port | Whoever you allow to reach it | Run state, as [described above](#who-can-do-what) |

---

## Running DSTNS safely

1. **Keep the default `127.0.0.1` bind.** To share a run, put an authenticating reverse proxy with TLS in
   front, block direct access to port 8090, and set `DSTNS_ALLOWED_HOSTS` and `DSTNS_ALLOWED_ORIGINS` to
   the proxy's names only.
2. **Do not run the server as root.** The container already uses an unprivileged user.
3. **Keep the secrets private.** See [Secrets and sensitive files](#secrets-and-sensitive-files).
4. **Close what you do not use:**
   - `DSTNS_LEGACY_API=off` closes the older routes that have no credential.
   - `DSTNS_DISABLE_WORLD_REGENERATION=1` stops viewers from replacing the world.
   - `DSTNS_FABRIC_APPS=off` stops applications from registering.
   - `DSTNS_LAUNCH_PROPOSALS=off` stops applications from proposing how to start them.
   - `DSTNS_DISABLED_CAPABILITIES` lists capabilities that nobody may be granted.
5. **Require signatures** for applications with `DSTNS_REQUIRE_SIGNATURES=on`.
6. **Enable Advanced Security** (`./launcher security on`) on a machine shared with other programs, such
   as an AI client.
7. **Keep the MCP Handler disabled** unless you use it, and enable `mcp.allow_writes` and `mcp.allow_launcher`
   only for a client you trust.
8. **Keep core-legacy disabled and acknowledgment enforced** unless you are comparing engines, so that no engine runs
   that you have not chosen.
9. **Keep SUMO disabled** (`sumo.enabled`) unless you export to it.
10. **Read each launch proposal** before you approve it. An approved command runs as you.
11. **Check the audit chain** now and then with `GET /api/v1/fabric/audit/verify`, and keep its head
   elsewhere.
12. **Keep DSTNS, its dependencies and the container image current.**

The full checklist and the commands to verify a deployment are in
[deployment security](docs/deployment/security.md#hardening-checklist).

---

## How this repository is protected

| Measure | What it does |
|---|---|
| CodeQL code scanning | Analyses the C++, Rust, TypeScript and JavaScript, Python and GitHub Actions code on pull requests, on pushes to `main` and `v3`, and every week |
| Dependabot security updates | Opens pull requests for dependencies with known vulnerabilities |
| Secret scanning with push protection | Blocks a push that contains a known kind of credential |
| `CODEOWNERS` | Requires the owner's review for `SECURITY.md`, `.github/`, `Fabric/`, the map downloader, the SUMO adapter and the container files |
| Licence header check in CI | Every source file carries its SPDX licence identifier |
| Tests in CI | 45 native and HTTP suites (golden fixtures included), the state-machine stress test, launcher and observer suites, replay verification, and a build of the container image, on every push to `main`, `v3` and `v3-*` |
| Least-privilege workflows | Workflows run with `contents: read` unless a job needs more |

---

## Security history

Fixed vulnerabilities and security changes are listed under **Security** in the
[changelog](CHANGELOG.md). Published advisories are on the
[advisories page](https://github.com/varunkarthic/DSTNS/security/advisories).

| Date | Change | Fixed in |
|---|---|---|
| 2026-11-17 | Undo or redo after a reset crashed the server; found by the new stress tool under AddressSanitizer | Engine 3.13.3 |
| 2026-11-14 | core-legacy disabled by default; `4xx` logged as warnings | Engine 3.13.0, 3.13.2 |
| 2026-11-13 | Unstable-engine gate and engine policy | Engine 3.6.0 |
| 2026-11-13 | An AI client could raise its own permissions, and read model addresses, through the MCP Handler | Launcher 3.4.0 |
| 2026-11-12 | Release 3.0.0: an audit of every route closed eight issues; hashed tokens, signed requests, hash-chained audit log, Advanced Security | `v3.0.0` |
| 2026-11-04 | Code scanning alert [#2](https://github.com/varunkarthic/DSTNS/security/code-scanning/2) (`js/unvalidated-dynamic-method-call`): names from events and applications could reach `Object.prototype` in the observer's lookup tables | `302220e`, completed in `4f2a2e2` |
| 2026-10-02 | Security policy published, and CodeQL analysis added (2.1.0) | `v2.1.0` |

---

*This policy is reviewed when the security model changes. Questions about it can be asked in a private
advisory.*
