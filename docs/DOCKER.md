# Docker (deprecated)

> **Deprecated in 2.0.0.** The container path is no longer maintained or
> exercised, and it will be removed in a future release. Run DSTNS from the
> operator CLI instead: `./launcher`.

## Why it was retired

The container made sense when DSTNS shipped with a bundled map and had no
network dependency at runtime. That is no longer how it works:

- **Maps are fetched at run time.** A seed resolves to a real city and the core
  downloads that district from the Overpass API on first use. A container
  therefore needs outbound network access, a writable cache volume, and the
  Python fetcher on its path — none of which the image made obvious, and all of
  which fail in ways that look like bugs in the simulator rather than in the
  deployment.
- **Extracts are large.** City extracts run to tens of megabytes each. Inside a
  container they land on a volume whose lifetime rarely matches the run's, so
  either the download repeats on every start or the volume grows unbounded.
- **The CLI is the authority.** Runs are started through the operator CLI, which
  holds the operator token. Reproducing that inside a container added a second
  process-supervision story for no benefit.

## If you are still using it

`Dockerfile` and `docker-compose.yml` remain in the tree and still build. They
copy `scripts/` into the image and create `/app/data/maps`, which a seeded start
requires. Two things to be aware of:

- The container must be able to reach `https://overpass-api.de`, or every
  seeded start fails with `MAP_FETCH_FAILED`.
- Mount `/app/data/maps` on a volume you control, and set `--map-cache` to
  `prune` or `clear` so extracts cannot accumulate.

Neither the image nor `ui-engine/tests/container-browser.mjs` is run as part of
the test suite, so regressions in this path are not caught.

## Supported path

```bash
./launcher                      # interactive operator console
./launcher start --seed 0x4cafe # non-interactive
```

See the [modernization guide](modernization.md) for the current architecture.
