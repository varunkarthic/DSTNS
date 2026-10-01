# Security policy

This policy covers the DSTNS source repository, native server, observer, operator
CLI, distributed container configuration and documentation. It defines how to
report a suspected vulnerability, how reports are assessed, and the deployment
boundaries operators must understand. It is not a security certification or a
service-level agreement.

## Supported versions

| Revision | Security maintenance |
|---|---|
| Current `main` | Primary target for investigation and fixes |
| Latest release derived from `main` | Reports accepted; a fix may require upgrading to a later revision |
| Older releases, historical branches and modified forks | No separate backport commitment; reproduce against current `main` where possible |

Record the exact commit with `git rev-parse HEAD`, the engine version with
`./build/dstns_server --version`, and the affected component. A version label alone
may not distinguish development builds. Reports about an older revision are still
useful when the defect remains present in maintained code.

## Reporting a vulnerability

**Do not publish exploit details, credentials or private data in a public issue,
pull request, discussion, CI log or dependency-bot comment.**

1. Visit the repository's [Security page](https://github.com/varunkarthic/DSTNS/security).
   If **Report a vulnerability** is available, use that private reporting form.
2. If the form is unavailable, contact repository owner
   [Varun Karthic](https://github.com/varunkarthic) through an existing private
   collaborator or organizational channel and request a confidential reporting
   destination. Do not assume a GitHub profile provides private messaging.
3. If no private contact route is available, open only a **non-sensitive request
   for a private security contact** in the repository. Include no affected
   endpoint, exploit, secret or identifying data. Wait for an agreed private
   channel before sending the report.

At policy introduction on 1 October 2026, this repository is private and the
GitHub private-reporting endpoint is unavailable. A private repository issue is
visible to repository collaborators, so it is not automatically an appropriately
restricted vulnerability channel. Confirm the recipients before sharing details.
If the repository becomes public, maintainers should configure private reporting
and update this section. GitHub documents feature availability and setup in
[Configuring private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

### Information to include privately

- A concise description, the affected component and expected security boundary.
- Exact commit or release, operating system, compiler/runtime and installation
  method. For containers, include the image digest if available.
- Deployment topology: loopback, trusted LAN, proxy, VPN or public endpoint;
  relevant settings with secrets removed.
- Minimal reproduction steps using a synthetic or bundled fixture. Explain
  required access, user interaction and the observed impact.
- Sanitized requests, responses, stack traces or screenshots where useful.
- Whether the behavior reproduces on current `main`, and any proposed mitigation.
- Your preferred private contact method and whether you want acknowledgement.

Never include `logs/operator.token`, `DSTNS_OPERATOR_TOKEN`, TLS private keys,
account credentials, personal location histories or another party's data. Replace
secrets with clearly labeled placeholders. Share large or sensitive artifacts only
through a channel agreed with the maintainer.

## Triage and coordinated disclosure

The repository owner coordinates receipt, reproduction, impact assessment,
remediation and disclosure. This is a community-maintained project with no
contractual response or resolution deadline. Maintainers should acknowledge a
report, identify missing reproduction information, and agree on a follow-up date
with the reporter. If no acknowledgement arrives, send a non-sensitive follow-up
through the same contact route.

The expected workflow is:

1. Confirm the affected revision and reproduce in an isolated environment.
2. Assess attacker access, affected data, exploitability and deployment exposure.
3. Agree on immediate mitigations and a private remediation plan.
4. Develop a focused fix and regression coverage without exposing an unpatched
   exploit in public automation.
5. Validate the fix, identify affected versions and prepare upgrade instructions.
6. Coordinate publication with the reporter, crediting them only with consent.
   Publish an advisory when the hosting platform and repository visibility allow.

Prioritize remotely reachable code execution, arbitrary file access, credential
exposure and browser script execution. Evaluate availability failures in terms of
resource use and deployment conditions. Severity depends on actual impact and
prerequisites, not just an automated severity label. There is no blanket embargo
period or guaranteed CVE allocation; coordinate disclosure for the specific case.

## Security model and trust boundaries

DSTNS is a single-operator simulation environment with a shared server state.
It does not provide user accounts, roles, per-user authorization, tenant isolation
or a read-only observer role.

| Boundary | Current behavior | Operator responsibility |
|---|---|---|
| Network access | Reachable clients can read state, change playback and controls, regenerate worlds and terminate the server | Restrict access to trusted users through loopback, firewall, VPN or an authenticated proxy |
| Starting and preparing runs | `POST /api/v1/playback/start` and `/prepare` require `X-DSTNS-Operator` | Protect the credential and the server's local filesystem |
| Browser origins | State-changing browser requests are checked against host/origin rules; Origin-less clients are allowed | Treat this as browser request protection, not network authentication |
| Reverse proxy | The origin guard accepts matching `Host` or `X-Forwarded-Host`, plus configured allowed origins | Overwrite forwarded headers at the trusted proxy and prevent direct backend access |
| Transport | The optional gateway supplies TLS and response headers | Add access control separately and use trusted certificates for remote use |
| Map and report data | OSM attributes and user-supplied configuration enter parsers and browser/report code | Treat imported data as untrusted; report injection and parsing defects |
| External tools and exports | SUMO export/simulation can write to caller-selected directories with server permissions | Use a restricted service account and avoid sensitive writable mounts |
| Run state and logs | Readable over permitted interfaces; CORS permits cross-origin reads | Do not store confidential information in a generally reachable instance |

The native server defaults to `0.0.0.0`. The supplied Compose file publishes the
backend port on host interfaces; enabling its TLS profile does not remove the HTTP
port. TLS alone does not prevent an unauthenticated client from controlling a run.
See [deployment security](docs/deployment/security.md) for source references and
configuration guidance.

## Deployment requirements

- Bind local instances explicitly to `127.0.0.1`, or configure the launcher host
  accordingly. Use a trusted private network or authenticated proxy for remote
  access, and close direct access to the backend.
- Run under a dedicated unprivileged account. Limit writable directories to logs,
  maps and deliberate export locations. Do not mount the Docker socket.
- Protect the logs directory and token file. The server sets `operator.token` to
  owner read/write; establish restrictive directory permissions before startup.
- Keep `DSTNS_ALLOWED_ORIGINS` limited to necessary observer origins. Do not use it
  as an access-control mechanism. Non-browser clients can omit `Origin`.
- Disable world regeneration with `DSTNS_DISABLE_WORLD_REGENERATION=1` when that
  workflow is unwanted. This does not disable other mutating endpoints.
- Apply current dependency fixes, rebuild containers and validate before rollout.
  Keep reproducibility artifacts when changing model or parser versions.
- Bound resource use externally where needed. The project does not promise
  protection against arbitrary request volume or large workloads.
- Keep credentials, private maps and sensitive logs out of Git, reports and
  public build artifacts. Review backups for secrets before sharing them.

## Credential handling and incident response

The server writes `<logs>/operator.token` on startup. By default it generates a
fresh credential; if `DSTNS_OPERATOR_TOKEN` is supplied, it uses that value. The
credential protects start and prepare only and is not a general API bearer token.

If compromise is suspected:

1. Restrict network access and stop the affected instance if needed. Preserve
   necessary diagnostic evidence in a restricted location.
2. Determine which files, export paths, containers and host permissions were
   accessible. Do not assume rotating the operator token revokes all API access.
3. Restart with a newly generated credential, or replace the configured
   `DSTNS_OPERATOR_TOKEN` in its protected configuration before restarting.
   Update local clients; do not print the token into a shared terminal or log.
4. Rotate any other exposed secrets and remove them from accessible artifacts.
   Deleting a committed secret does not invalidate copies or Git history.
5. Apply a validated fix or mitigation, restore only trusted artifacts, and verify
   network isolation and behavior before resuming normal access.

Changing the token file alone does not rotate the active server's credential,
which is captured when its API handlers are initialized.

## Dependency and supply-chain maintenance

Review automated updates against the complete diff and upstream release notes.
Install from committed lockfiles, run relevant tests and production builds, and
verify repository CI against the reviewed commit before merging. Security scanner
results are evidence for triage, not a guarantee of safety. Do not run a blanket
force-update command to resolve a focused advisory.

See [Dependency maintenance](docs/development/dependencies.md) for the inventory,
review procedure, commands and post-merge checks. Inspect npm packages,
documentation tooling, vendored native code, container images and CI actions;
coverage of one dependency ecosystem does not imply coverage of the others.

## Responsible testing

Test only systems and data you own or have explicit permission to assess. Prefer
local instances with the bundled map. Avoid disruption, data extraction, social
engineering and testing against third-party map services or unrelated deployments.
Stop if you encounter another person's data and report the circumstances privately.
This policy does not grant permission to access third-party systems or promise a
bug bounty. Infrastructure exposure outside the intended deployment model may be
an operator configuration issue, but reports revealing an implementation defect
are still welcome.

## Related documentation

- [Deployment security](docs/deployment/security.md): implementation and hardening.
- [Operations runbook](docs/deployment/operations.md): readiness, backups and recovery.
- [Contributing](docs/development/contributing.md): review and validation workflow.
- [Testing](docs/development/testing.md): security and API regression suites.
