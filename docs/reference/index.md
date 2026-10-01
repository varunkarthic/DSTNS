# Reference

Look-up material: exact commands, variables, paths and limits; the internal design of
each component; the design specifications and the decisions behind them; how DSTNS is
built, tested and verified; and the release history.

## Operating reference

| Page | Use it to look up |
|---|---|
| [Command-line tools](command-line-tools.md) | Every executable the build produces, its arguments, output and exit codes |
| [Environment variables](environment-variables.md) | Every `DSTNS_*` variable, which program reads it, and its default |
| [Files and directories](files-and-directories.md) | What DSTNS writes where, what is safe to delete, and what must stay private |
| [Limits and ranges](limits.md) | Every bound the engine enforces, in one table per area |

For configuration files, see [Configuration](../guide/configuration.md) and
[Observer configuration](../guide/observer-configuration.md). For HTTP routes, see the
[API reference](../api/reference.md).

## Internals

| Page | Covers |
|---|---|
| [Components](../components/index.md) | Per-class design notes for the core, the SUMO adapter and the observer |
| [Design decisions](../design/decisions.md) | Why the system is built the way it is, decision by decision |
| [Design specifications](../design/index.md) | The original mathematical, architectural and API specifications |

## Engineering

| Page | Covers |
|---|---|
| [Building from source](../development/building.md) | Build options, targets, sanitizers and editor setup |
| [Testing](../development/testing.md) | Every test suite, what it proves, and how to run it |
| [Quality assurance](../development/quality-assurance.md) | Quality gates, review method and the defect register |
| [Building the documentation](../development/documentation.md) | Previewing and building this site |

## Releases and licensing

| Page | Covers |
|---|---|
| [Release notes](../changelog.md) | What changed in each version, including changes that affect results |
| [License](../license.md) | The AGPL terms, the network source offer and map data licensing |
