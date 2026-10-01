# Security Policy

DSTNS is an open-source simulator with a network-facing control API. This policy
explains how to report a vulnerability, what you can expect in response, what is
in scope, and where to find hardening guidance for operators. It follows the
conventions of [coordinated vulnerability disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html)
and GitHub's [security policy format](https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository).

## Supported versions

Security fixes are made on the `main` branch and released from it.

| Version | Supported |
|---|---|
| `main` (latest commit) | Yes |
| Latest tagged release | Yes, by upgrading to a later release |
| Older releases, other branches and forks | No separate backports |

Include the output of `git rev-parse HEAD` and `./build/dstns_server --version`
when you report, so the affected revision is unambiguous.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a suspected
vulnerability.** Public reports give attackers the same information as the
maintainers before a fix exists.

Use GitHub's private reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Fill in the form with the details listed [below](#what-to-include).

This creates a private advisory visible only to you and the maintainers, where
a fix can be developed and a CVE requested if warranted.

If the **Report a vulnerability** button is not shown, open an issue titled
**Security contact request** containing no technical detail, and the maintainer
will reply with a private channel. Do not describe the vulnerability in that
issue.

### What to include

A good report lets a maintainer reproduce the problem in minutes:

- **Summary.** What is wrong and which component is affected (server, API,
  observer, operator CLI, map downloader, SUMO adapter, container image,
  documentation site).
- **Impact.** What an attacker gains and what they need first: network access,
  a victim visiting a page, local access.
- **Version.** Commit hash, `dstns_server --version`, operating system,
  compiler or Docker image digest, and how you installed it.
- **Deployment.** How the server was started, in particular its `--host`,
  whether a proxy or the TLS gateway was in front, and any `DSTNS_*` settings
  (with secrets removed).
- **Reproduction.** Numbered steps using the bundled map
  (`data/fixtures/real_network.osm.xml`) and a fixed seed, with the exact
  requests and responses.
- **Suggested fix**, if you have one.

Never include real credentials, `logs/operator.token`, private keys or
another person's data. Replace secrets with placeholders.

## What to expect

DSTNS is maintained by individuals, not a company, so these are targets rather
than contractual commitments.

| Stage | Target |
|---|---|
| Acknowledgement of your report | 5 business days |
| Initial assessment (accepted, needs information, or declined, with reasons) | 14 days |
| Fix or mitigation for a confirmed high-severity issue | 30 days |
| Fix for other confirmed issues | 90 days |
| Public disclosure | After a fix is released, coordinated with you |

If you hear nothing within the acknowledgement window, add a comment to your
private advisory; do not disclose publicly. We will keep you informed of progress
and tell you if a target will be missed.

### Disclosure

We practise coordinated disclosure with a default maximum of **90 days** from
your report to publication. We will publish a GitHub Security Advisory, request
a CVE identifier for confirmed vulnerabilities in released versions, and credit
you by name or handle unless you ask us not to. If you intend to publish
independently, tell us your date so we can coordinate; we ask that you give us
a reasonable chance to release a fix first.

## Scope

### In scope

Vulnerabilities in the code and configuration in this repository, including:

| Area | Examples |
|---|---|
| HTTP API (`src/api.cpp`) | Authentication bypass on `playback/start` or `playback/prepare`; cross-site request forgery; DNS rebinding; request smuggling; unbounded memory use from a single request |
| Input handling | Memory-safety errors, integer wrap-around, injection or path traversal through request bodies, query strings, saved seeds or configuration files |
| Map pipeline | Crashes, resource exhaustion or code execution from a crafted OpenStreetMap file; command injection in the map downloader |
| SUMO adapter | Shell injection, writing outside the requested directory |
| Observer | Cross-site scripting or script injection from map tags, news messages or report content |
| Operator CLI and container | Credential exposure, unsafe temporary files, privilege escalation in the image or entrypoint |
| Supply chain | A vulnerable or malicious dependency, workflow or build step that affects released artifacts |

### Out of scope

| Area | Reason |
|---|---|
| Control of a run by anyone who can reach an exposed port | By design there are no user accounts; restrict network access (see [deployment security](docs/deployment/security.md)) |
| Reading run state from a server you can reach | Run state is not confidential; do not simulate private data on a shared server |
| Denial of service by request volume | Needs a rate-limiting proxy; resource exhaustion from a single small request is in scope |
| Findings that need physical or root access to the host | Outside the threat model |
| Vulnerabilities in third-party services (OpenStreetMap, Overpass, Read the Docs, GitHub) | Report to those services |
| Missing security headers on `localhost` development servers; automated scanner output without a demonstrated impact | Not actionable without a working exploit |
| Social engineering of maintainers or contributors | Out of scope |

## Safe harbor

We will not pursue or support legal action against researchers who act in good
faith under this policy. Good faith means:

- you test only against your own installation, never someone else's instance or
  our infrastructure;
- you do not access, modify or retain data that is not yours, and you stop and
  report if you encounter any;
- you avoid disruption: no denial of service, no spam, no social engineering;
- you give us reasonable time to fix the issue before disclosing it.

This policy does not offer a bug bounty. We are grateful for reports and will
credit them.

## Security model in brief

DSTNS is a **single-operator** tool. It has no user accounts, roles or tenant
isolation. The protections it does provide are:

| Control | Protects against | Where |
|---|---|---|
| Loopback bind by default (`127.0.0.1`) | Exposure of the API to the network | `apps/dstns_server/main.cpp`, `docker-compose.yml` |
| `Host` header check on loopback | DNS rebinding | `src/api.cpp` (`host_allowed`) |
| `Origin` check on state-changing requests | Cross-site request forgery | `src/api.cpp` (`same_origin`) |
| Operator credential for `start` and `prepare` | A reachable client choosing what runs | `apps/dstns_server/main.cpp`, `src/api.cpp` |
| POST-only shutdown | Shutdown triggered by a link or image | `src/api.cpp` |
| Range-checked IDs, times, counts and bounds | Wrap-around and out-of-range values | `src/api.cpp`, `src/engine.cpp` |
| Quoted shell arguments, close-on-exec pipes | Command injection through paths | `src/sumo_bridge.cpp`, `src/osm_fetch.cpp` |
| UTF-8 repair and JSON serialisation guard | Hostile or corrupt map text reaching responses and logs | `src/utf8.cpp`, `src/osm.cpp` |
| Single-line log messages | Log forging | `src/logging.cpp` |
| Non-root container user, no Docker socket | Escalation from a compromised process | `Dockerfile` |

If you expose DSTNS beyond your own machine, read
[Deployment security](docs/deployment/security.md): it explains how to put
authentication and TLS in front of it, what the operator credential does and
does not do, and a hardening checklist.

## Security updates

Fixed vulnerabilities are announced through
[GitHub Security Advisories](https://github.com/varunkarthic/DSTNS/security/advisories)
and summarised in the [changelog](CHANGELOG.md) under **Security**. Watch the
repository (**Watch → Custom → Security alerts**) to be notified.

Dependencies are monitored by Dependabot, and the code is analysed by CodeQL on
every push and pull request. See
[Dependency maintenance](docs/development/dependencies.md).

## Hardening guidance for operators

The short version:

1. Keep the default `127.0.0.1` bind, or put an authenticating reverse proxy
   with TLS in front and block direct access to port 8090.
2. Do not run the server as root; the container already uses an unprivileged user.
3. Keep `logs/operator.token` private, and never commit it.
4. Set `DSTNS_DISABLE_WORLD_REGENERATION=1` if viewers should not be able to
   replace the world.
5. Keep dependencies and the container image current.

The full checklist is in [Deployment security](docs/deployment/security.md#hardening-checklist).
