# Contributing to DSTNS

Thank you for considering a contribution. This page is the short version; the
full guide is [Contributing](docs/development/contributing.md) in the
documentation.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
**Report security vulnerabilities privately**, as described in
[SECURITY.md](SECURITY.md), never in a public issue or pull request.

## Ways to contribute

- **Report a bug** with the [bug report form](https://github.com/varunkarthic/DSTNS/issues/new?template=bug_report.yml).
  Include the seed, the exact steps and the version.
- **Propose a feature** with the [feature request form](https://github.com/varunkarthic/DSTNS/issues/new?template=feature_request.yml)
  before writing a large change, so the approach can be agreed first.
- **Improve the documentation.** Every page has an edit link; see
  [Writing documentation](docs/development/documentation.md).
- **Fix an issue** by opening a pull request.

## Development workflow

```bash
git clone https://github.com/varunkarthic/DSTNS.git && cd DSTNS
git switch -c fix/short-description

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSTNS_BUILD_TESTS=ON
cmake --build build -j
ctest --test-dir build --output-on-failure      # native and HTTP suites
npm ci --prefix ui-engine && npm test --prefix ui-engine
./scripts/test.sh                                # everything, before you push
```

Build and environment details: [Building from source](docs/development/building.md).

## Pull request checklist

1. A test that **fails without your change** and passes with it. Confirm the
   failure; a test that never failed proves nothing.
2. All suites pass: `./scripts/test.sh`, plus `mkdocs build --strict` for
   documentation changes.
3. Documentation updated alongside the code.
4. An entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md), in the
   [Keep a Changelog](https://keepachangelog.com/) categories. If results change
   for any seed or map, say which.
5. Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
   `fix(maps): southern-hemisphere cities could never be downloaded`. The body
   explains what was wrong and why the fix is right.

## Conventions

- **C++20.** The library builds with `-Wall -Wextra -Wpedantic -Wshadow` and tests
  with `-Werror`; keep the build warning-free.
- **Validate by throwing** the right exception type (`std::invalid_argument` for
  400, `std::logic_error` for 409); the API maps them.
- **Determinism.** Every random choice comes from a sub-seed through
  `DeterministicRng`, never from time, addresses or `std::rand`.
- **Security.** Quote every shell argument, range-check every integer taken from
  a request, and never read a JSON number into an unsigned type without checking
  its sign.
- **TypeScript.** Strict mode; components read state from hooks and hold none of
  their own.

## Licence of contributions

DSTNS is licensed under the [AGPL-3.0-or-later](LICENSE). By submitting a
contribution you agree that it is licensed under the same terms.
