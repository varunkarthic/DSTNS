# Security Policy

DSTNS is an open-source simulator with a network-facing control API. This policy
explains how to report a vulnerability, what is in scope, and where to find hardening
guidance for anyone running it. It follows the conventions of
[coordinated vulnerability disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html).

## Version covered

This policy covers the code on the `main` branch. Include the output of
`git rev-parse HEAD` and `./build/dstns_server --version` in a report so the affected
revision is unambiguous.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a suspected
vulnerability.** A public report gives attackers the same information as the author
before anything can be done about it.

Use GitHub's private reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Fill in the form with the details listed below.

This creates a private advisory visible only to you and the repository owner.

### What to include

A good report lets the problem be reproduced quickly:

- **Summary.** What is wrong and which component is affected (server, API, observer,
  operator CLI, map downloader, SUMO adapter, container image, documentation site).
- **Impact.** What an attacker gains, and what they need first: network access, a
  victim visiting a page, local access.
- **Version.** Commit hash, `dstns_server --version`, operating system, compiler or
  Docker image digest, and how it was installed.
- **Deployment.** How the server was started, in particular its `--host`, whether a
  proxy or the TLS gateway was in front, and any `DSTNS_*` settings (with secrets
  removed).
- **Reproduction.** Numbered steps using the bundled map
  (`data/fixtures/real_network.osm.xml`) and a fixed seed, with the exact requests and
  responses.

Never include real credentials, `logs/operator.token`, private keys or another person's
data. Replace secrets with placeholders.

## How reports are handled

Reports are read and assessed as time allows. There is no guaranteed response or fix
time and no bounty. A confirmed vulnerability is fixed on `main`; if it affects a
published release, a GitHub Security Advisory is published once a fix is available, and
the reporter is credited by name or handle unless they prefer not to be.

Please keep the details private until a fix is published. If you intend to disclose
publicly, tell the repository owner your date through the private advisory so the
disclosure can be coordinated; a default of 90 days from the report is reasonable.

## Scope

### In scope

Vulnerabilities in the code and configuration in this repository, including:

| Area | Examples |
|---|---|
| HTTP API (`src/api.cpp`) | Authentication bypass on `playback/start` or `playback/prepare`; cross-site request forgery; DNS rebinding; unbounded memory use from a single request |
| Input handling | Memory-safety errors, integer wrap-around, injection or path traversal through request bodies, query strings, saved seeds or configuration files |
| Map pipeline | Crashes, resource exhaustion or code execution from a crafted OpenStreetMap file; command injection in the map downloader |
| SUMO adapter | Shell injection, writing outside the requested directory |
| Observer | Cross-site scripting or script injection from map tags, news messages or report content |
| Operator CLI and container | Credential exposure, unsafe temporary files, privilege escalation in the image or entrypoint |
| Supply chain | A vulnerable or malicious dependency, workflow or build step that affects released artifacts |

### Out of scope

| Area | Reason |
|---|---|
| Control of a run by anyone who can reach an exposed port | By design there are no user accounts; restrict network access (see [deployment security](https://dstns.readthedocs.io/deployment/security/)) |
| Reading run state from a server you can reach | Run state is not confidential; do not simulate private data on a shared server |
| Denial of service by request volume | Needs a rate-limiting proxy; resource exhaustion from a single small request is in scope |
| Findings that need physical or root access to the host | Outside the threat model |
| Vulnerabilities in third-party services (OpenStreetMap, Overpass, Read the Docs, GitHub) | Report to those services |
| Scanner output without a demonstrated impact | Not actionable without a working exploit |

## Safe harbor

Researchers who act in good faith under this policy will not be pursued. Good faith
means:

- you test only against your own installation, never someone else's instance;
- you do not access, modify or retain data that is not yours, and you stop and report
  if you encounter any;
- you avoid disruption: no denial of service, no spam, no social engineering;
- you allow reasonable time for a fix before disclosing.

## Security model in brief

DSTNS is a **single-operator** tool. It has no user accounts, roles or tenant
isolation. The protections it provides are:

| Control | Protects against | Where |
|---|---|---|
| Loopback bind by default (`127.0.0.1`) | Exposure of the API to the network | `apps/dstns_server/main.cpp`, `docker-compose.yml` |
| `Host` header check on loopback | DNS rebinding | `src/api.cpp` (`host_allowed`) |
| `Origin` check on state-changing requests | Cross-site request forgery | `src/api.cpp` (`same_origin`) |
| CORS only for the server's own and allowed origins | A web page reading a local run | `src/api.cpp` |
| Operator credential for `start` and `prepare` | A reachable client choosing what runs | `apps/dstns_server/main.cpp`, `src/api.cpp` |
| POST-only shutdown | Shutdown triggered by a link or image | `src/api.cpp` |
| Range-checked IDs, times, counts and bounds | Wrap-around and out-of-range values | `src/api.cpp`, `src/engine.cpp` |
| Quoted shell arguments, close-on-exec pipes | Command injection through paths | `src/sumo_bridge.cpp`, `src/osm_fetch.cpp` |
| UTF-8 repair and JSON serialisation guard | Hostile or corrupt map text reaching responses and logs | `src/utf8.cpp`, `src/osm.cpp` |
| Single-line log messages | Log forging | `src/logging.cpp` |
| Non-root container user, no Docker socket | Escalation from a compromised process | `Dockerfile` |

## Running DSTNS safely

1. Keep the default `127.0.0.1` bind, or put an authenticating reverse proxy with TLS
   in front and block direct access to port 8090.
2. Do not run the server as root; the container already uses an unprivileged user.
3. Keep `logs/operator.token` private, and never commit it.
4. Set `DSTNS_DISABLE_WORLD_REGENERATION=1` if viewers should not be able to replace
   the world.
5. Keep dependencies and the container image current.

The full checklist is in [Deployment security](https://dstns.readthedocs.io/deployment/security/#hardening-checklist).
Fixed vulnerabilities are listed under **Security** in the [changelog](CHANGELOG.md).
