# Dependency maintenance

This procedure applies to automated Dependabot pull requests and manual dependency
updates. A bot-created PR is a proposed change and requires the same review as a
human contribution. Keep dependency changes separate from unrelated runtime work.

## Dependency inventory

| Surface | Source of dependency information | Main validation |
|---|---|---|
| Observer | `ui-engine/package.json` and `package-lock.json` | Clean install, Vitest, TypeScript and Vite build |
| Operator CLI | `dstns-operator-cli/package.json` and `package-lock.json` | Clean install and CLI tests |
| Documentation | `docs/requirements.txt` | Strict MkDocs build and OpenAPI validation |
| Native core | `CMakeLists.txt`, vendored headers and system libraries | Native and HTTP suites on supported build hosts |
| Container | `Dockerfile`, gateway Dockerfile and base images | Image build and bundled-map startup |
| CI | `.github/workflows/` | Review action permissions, versions and actual job results |

The npm lockfiles record resolved package versions and integrity metadata.
`npm ci` installs from that committed state and fails when manifest and lockfile
requirements are incompatible. Avoid an unrelated `npm update` during a focused
patch review: it can upgrade other packages and obscure the original change.

## Review the proposed change

1. Confirm the target repository, base branch, bot identity and exact PR commit.
2. Read the entire diff, including manifest metadata, transitive versions,
   registry URLs, integrity hashes and new install scripts.
3. Read upstream release notes and any linked advisory. Trace how the project
   uses the package; an indirect dependency may still affect shipped behavior.
4. Check compatibility with the project's runtime and lockfile. A patch version
   does not by itself prove compatibility or security.
5. Validate the exact reviewed commit in an isolated checkout. Re-check if the
   bot rebases or otherwise changes the PR head.

DOMPurify, for example, is brought in by jsPDF in the observer dependency tree.
The PDF report tests and production build are relevant coverage; inspect
`npm ls dompurify --prefix ui-engine` to confirm the installed path and version.

## Observer update validation

Run from the repository root in the dependency PR checkout:

```bash
npm ci --prefix ui-engine
npm ls dompurify --prefix ui-engine
npm test --prefix ui-engine
npm run build --prefix ui-engine
npm audit --prefix ui-engine
```

`npm ci` checks the committed installation. `npm ls` shows the dependency chain.
Vitest exercises observer behavior and report generation. The build runs TypeScript
and creates the browser bundle. `npm audit` checks the installed dependency graph
against the registry's advisory database at that time; zero findings does not
prove that all packages are free of vulnerabilities. Audit requests require network
access and share dependency metadata with the configured registry.

For CLI changes, install its own lockfile and run the relevant tests:

```bash
npm ci --prefix dstns-operator-cli
node --test tests/cli/*.test.mjs
python3 tests/cli/test_seeds.py
python3 tests/cli/test_fetch_osm.py
```

These cover artifact rebuild detection, saved-seed handling and map-download
behavior. A change affecting process supervision or startup also needs the
launcher integration workflow documented in [Testing](testing.md).

## Merge and follow-up

Merge only when the diff is understood, relevant local checks pass, required
repository checks are green for the reviewed head, and there are no unresolved
compatibility or security concerns. Do not bypass a failing check or approve a
package solely because its author is Dependabot. Record any accepted limitation
with a concrete explanation and follow-up owner.

After merging, verify the new default-branch commit and its CI results. Confirm
that the installed version matches the lockfile. If a regression appears, prepare
a revert or a fixed update with the same validation; consider the exposure of the
previous version before reverting a security fix.

## Handling an advisory

Assess the affected versions, reachable code path, attacker prerequisites and
available fixed version. Treat reproducible code execution, unauthorized file
writes, secret exposure and script execution as urgent. Avoid copying private
exploit details into public PRs. The
[security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md)
describes reporting, triage and coordinated disclosure.

Automated update scheduling and security-alert settings are separate controls.
The presence of one Dependabot PR does not establish that every ecosystem is
monitored. Maintainers should review repository settings and supported ecosystems
when adding new dependencies.
