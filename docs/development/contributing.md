# Contributing

Thank you for improving DSTNS. This page describes how changes are made and
what a change needs before it is merged.

## Workflow

1. **Open or find an issue** describing the problem or feature, with a seed
   that shows it where relevant.
2. **Branch** from `main`: `git switch -c fix/short-description`.
3. **Change the code, with a test** that fails before your change and passes
   after it. Confirm the failure; a test that never failed proves nothing.
4. **Run the suites** you touched, then `./scripts/test.sh`.
5. **Update the documentation** in the same change: a behaviour change that
   is not documented is not finished.
6. **Open a pull request** against `main`. CI runs the native, HTTP, observer
   and documentation builds.

## What every change needs

- [ ] Tests that fail without the change.
- [ ] Every new source file has the licence header (`python3 scripts/license-headers.py --fix`).
- [ ] All suites green: `./scripts/test.sh`, and `mkdocs build --strict` for
      documentation changes.
- [ ] Documentation updated: the relevant page, the API reference and
      `docs/api/openapi.yaml` for API changes, the [changelog](../changelog.md).
- [ ] No change to simulation results unless intended. If results change for
      some maps (as fixing an OSM parsing bug can), say which, in the commit
      message and the changelog.
- [ ] No new warnings: the library builds with `-Wall -Wextra -Wpedantic
      -Wshadow`, and tests with `-Werror`.

## Conventions

### C++

- C++20, standard library first. Follow the surrounding file's layout.
- Validate by throwing: `std::invalid_argument` for bad input (400),
  `std::logic_error` for the wrong lifecycle (409), `std::out_of_range` for
  unknown IDs (404). The API maps them; see [API errors](../api/errors.md).
- Never narrow an integer you did not range-check, and never read JSON
  numbers into unsigned types without checking the sign: `nlohmann::json`
  wraps negatives.
- Every random choice comes from a sub-seed through `DeterministicRng`, never
  from `std::rand`, time or addresses. See [Deterministic
  seeding](../concepts/deterministic-seeding.md).
- Hold the engine mutex for state; never hold it across a download or an
  external process.
- Quote every argument passed to a shell.

### TypeScript (observer)

- Strict TypeScript; `npx tsc -b` must pass.
- Components read state from the hooks (`useSimulation`, `useBackpressure`);
  they never hold simulation state of their own.
- Copy: plain, specific, no em dashes, no "no longer" or development-history
  wording in the interface (a test enforces this).

### Commits

Conventional style, describing what changes for the user:

```text
fix(maps): southern-hemisphere cities could never be downloaded

<what was wrong, why, and what the fix does; which tests guard it>
```

Prefixes: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, with an
optional scope (`engine`, `api`, `ui`, `cli`, `maps`, `sumo`, `docker`).

## Reporting bugs

Include:

- the seed, day type and how you started the run;
- what you did, what you expected, and what happened;
- `logs/system.log` around the time, and the output of
  `curl -s localhost:8090/api/v1/system/info`;
- your platform and how you installed DSTNS (source or Docker).

Security problems: see [Security](../deployment/security.md#reporting-a-vulnerability).

## Licence of contributions

DSTNS is AGPL-3.0-or-later. By contributing you agree that your contribution
is licensed under the same terms. See [License](../license.md).

## Review scope and acceptance criteria

Apply the workflow above to the actual change. A documentation-only correction
needs a strict site build, link review and validation of changed commands; it does
not need a synthetic regression test that merely asserts the wording. Runtime
behavior changes need tests that exercise the behavior and demonstrate the defect
where practical. Dependency changes follow [Dependency maintenance](dependencies.md).

A pull request description should state the problem, resulting behavior, affected
interfaces, validation performed and material limitations. Include the commands
and outcomes, and distinguish source inspection from an actual runtime test.
Keep unrelated formatting, regenerated assets and local data out of the diff.

Security-sensitive findings follow the repository's
[security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md).
Do not attach a working exploit to a public issue or dependency review.
