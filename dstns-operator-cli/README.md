# DSTNS Operator CLI

Modern terminal operator interface for DSTNS using the real `@poppinss/cliui` package.

## Placement

Copy this folder into the DSTNS repository root as:

```text
DSTNS/
├── dstns-operator-cli/
│   ├── dstns.mjs
│   └── package.json
├── build/
├── config/
├── ui-engine/
└── ...
```

The CLI resolves the DSTNS project root as the parent directory of `dstns-operator-cli`.

## Install

```bash
cd dstns-operator-cli
npm ci
```

## Run

From the repository root, `./launcher` (or `python3 launcher.py`) checks that the CLI dependencies load and installs them if needed. Direct Node execution requires the install step above.

```bash
npm start
```

Or make the launcher executable and invoke it directly:

```bash
chmod +x dstns.mjs
./dstns.mjs
```

## Useful commands

```bash
./dstns.mjs start
./dstns.mjs logs system
./dstns.mjs logs api
./dstns.mjs config
./dstns.mjs test all
./dstns.mjs test unit
./dstns.mjs test ui
./dstns.mjs test all --verbose
./dstns.mjs sumo
./dstns.mjs reset
./dstns.mjs reset --yes
./dstns.mjs --mode=server
```

The C++ process remains the simulation authority. The Node launcher is only the operator/presentation layer.
