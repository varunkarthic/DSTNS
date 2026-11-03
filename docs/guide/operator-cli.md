# Launcher

`./launcher` is how an operator builds DSTNS, checks that a machine can run it,
starts and supervises simulations, edits the configuration, manages saved seeds,
reads logs and runs the tests. It is also the only supported way to start a
simulation: the server refuses start requests that lack the credential the launcher
holds.

The launcher has a keyboard-driven terminal interface for interactive use, and plain
commands for scripts. Both drive the same operations, so anything one can do the
other can too.

## At a glance

```bash
./launcher                        # open the launcher (in a terminal)
./launcher start --seed 382923    # start a particular run
./launcher test unit              # a scripted command: prints lines, returns a status
./launcher help                   # every command and option
```

`python3 launcher.py` is equivalent to `./launcher`. Both run the Python package
`dstns_launcher`.

## Interfaces

| Interface | When it is used | Needs |
|---|---|---|
| **Terminal interface** | Interactive use in a terminal | Textual and Rich, installed automatically (below) |
| **Compatibility mode** | The terminal interface cannot start, or `--reduced-ui` | Rich if available, otherwise nothing |
| **Plain mode** | `--no-tui`, `TERM=dumb`, or Rich is unavailable | Nothing beyond Python |
| **Scripted output** | Any command run without a terminal, and `test`, `seeds`, `sumo`, `reset`, `ui`, `help`, `version`, `license` | Nothing beyond Python |

The launcher never becomes impossible to start because a richer interface failed. If
the terminal interface cannot start, or stops unexpectedly, the launcher records the
reason in `logs/launcher.log`, says so in one line, and continues in compatibility
mode:

```text
DSTNS Launcher

The enhanced terminal interface could not be started.
Switching to compatibility mode.

Reason:
  The Textual package is not installed.
  Details: logs/launcher.log
```

### Installing the terminal interface

The terminal interface uses two Python packages, [Textual](https://textual.textualize.io/)
and [Rich](https://rich.readthedocs.io/). The first time `./launcher` is used
interactively, it creates a private environment, `.venv-launcher/`, and installs the
pinned versions listed in `dstns_launcher/requirements.txt` into it. Nothing is
installed into your system Python. Later starts use the environment directly.

In a checkout that a cloud client syncs (OneDrive, iCloud Drive, Dropbox, Google
Drive), the environment is created in the local cache instead -
`~/Library/Caches/DSTNS/venv-launcher-<id>` on macOS, `~/.cache/dstns/` elsewhere -
because the client evicts files it has uploaded and every import would then wait
on the network. `DSTNS_LAUNCHER_VENV` chooses the location outright.

If the installation cannot complete (no network, no `venv` module, an unwritable
directory) the launcher continues in compatibility mode. Set
`DSTNS_LAUNCHER_NO_INSTALL=1` to prevent the installation altogether. To install by
hand:

```bash
python3 -m venv .venv-launcher
.venv-launcher/bin/pip install -r dstns_launcher/requirements.txt
```

Scripted commands never install anything.

## The terminal interface

![The launcher's dashboard](../assets/screenshots/launcher.png){ .screenshot }

```mermaid
flowchart LR
    Splash["Splash and startup checks"] -->|"all required checks pass"| Dash["Dashboard"]
    Splash -->|"a required check fails"| Fix["Check results: Retry · Diagnostics · Exit"]
    Dash --> Start["Start simulation"] --> Run["Running simulation"] --> Done["Completed"]
    Done --> Dash
    Dash --> Other["Saved seeds · Configuration · Diagnostics<br/>Logs · Tests · Tools · About"]
```

### Splash

The DSTNS wordmark is generated from the same SVG outlines as the documentation
logo, preserving its open-sided D and rounded letter shapes. It uses Unicode
half-block characters, with a smaller rendering for narrower terminals and plain
`D S T N S` when the artwork cannot fit or Unicode is unavailable. No special
font, image protocol or graphics library is required.

The splash shows the version, licence and real startup checks for **at least three
seconds**. The reading time overlaps the checks: a five-second check does not add
another three-second delay. When checks finish early, the animation stops and a
static completion message remains until the display time ends. Keyboard input
and resizing stay responsive.

Passing checks lead to the dashboard (or the requested run). A required failure
opens the detailed results and remedies. Checks are not repeated during this
transition. `--no-splash` skips the splash and its minimum display time, then runs
the same checks on the environment screen.

### Loading feedback

The splash, environment check, simulation preparation, tests and tools share an
ASCII activity indicator. It advances four times per second only while work is
active on the visible screen. The label names the current step; it stops when
the operation completes or fails. Environment checks also show the actual number
of completed checks. Percentages are never simulated; only the opening splash has
the three-second minimum display time described above.

During a map download, the launcher shows received MiB. A progress bar appears
only when the server provides a positive byte total. When the total is unknown,
the activity label remains visible without a percentage. Once the world is ready,
the running screen switches to actual simulation progress.

```bash
./launcher --no-animation              # keep status text; disable terminal motion
./launcher --no-splash                 # go directly to environment checks
./launcher --no-tui start --no-open \
  --seed 382923 --osm-file data/fixtures/real_network.osm.xml
```

The first command retains the full keyboard interface with a static `[working]`
marker. The second removes only the opening splash. The third uses plain output
and the bundled real OSM extract, so map acquisition does not need a network
connection; missing build dependencies may still require installation. Plain
mode and redirected output do not emit animation frames.

### Environment check

The splash runs these real checks concurrently and reports their completion
count and the latest check. They also run on the environment screen when
`--no-splash` is used, or when retrying failed checks:

| Check | Required | Fails or warns when |
|---|---|---|
| Host platform | Yes | Not macOS or Linux (warning) |
| Python | Yes | Older than 3.10 (warning) |
| Build tools | Yes | The core is not built and CMake or a C++ compiler is missing |
| Configuration | Yes | `config/defaults.json` or `config/ui-config.json` is invalid |
| Workspace | Yes | The logs directory is not writable |
| Map downloader | Yes | `scripts/fetch_osm.py` is missing or does not compile |
| Map cache | Yes | `data/maps/` is not writable |
| Simulation core | Yes | The binary is missing (warning: it is built on start) |
| Node.js | No | Missing or older than 20; needed only to rebuild the observer |
| Licence | No | `LICENSE` is missing or not the AGPL text |
| Observer settings | No | `config/ui-config.json` has values the observer ignores |
| Observer bundle | No | Not built, or older than its sources (rebuilt on start) |
| API port | No | Informational: in use by a running server, or free |
| SUMO | No | Installed but does not start |

Each state is shown with a symbol **and** a word: `○ Pending`, `◌ Checking`, `✓ OK`,
`! Warning`, `✗ Failed`, `- Skipped`. If every required check passes, the launcher
continues to the dashboard; warnings stay visible there. If one fails, it explains why
and what to do, and offers **Retry**, **Diagnostics**, **Continue to the dashboard**
and **Exit**.

These startup checks validate configuration, compile-check the map downloader,
probe the core executable and installed tools, inspect the observer bundle, and
check workspace access and the API port. They are readiness checks, not the full
regression suite. Run **Tests**, or enable suites in **Diagnostics**, for native,
HTTP and observer test cases. Scripted commands do not add splash delays.

### Dashboard

The menu on the left, details of the highlighted item on the right, and the server's
live state in the header (`✓ READY`, `◌ RUNNING`, `✗ NOT READY`). When a simulation is
running, **Running simulation** appears at the top of the menu.

| Item | Opens |
|---|---|
| Start simulation | The start form |
| Saved seeds | Saved configurations: start, inspect or delete |
| Configuration | The editor for `config/defaults.json` |
| Diagnostics | Every check, optionally with the test suites; server, terminal and path details |
| Logs | The system log and the API, operator-event and lifecycle journals |
| Tests | The test stages, with live output |
| Tools | The SUMO toolchain check, rebuilding the observer, resetting runtime data |
| Documentation | This site, in your browser |
| About | Version, copyright, licence and map-data attribution |
| Exit | Leaves the launcher, stopping a simulation it started after confirmation |

### Start simulation

| Field | Meaning |
|---|---|
| Seed | Empty for a fresh seed, or decimal or `0x` hexadecimal up to 128 bits |
| Day type | Weekday or weekend |
| Map | Chosen by the seed, a cached city, the bundled offline district, or another file |
| Speed | Initial speed, greater than 0 and at most 5 |
| Save as, Description | Optionally save the configuration as a [saved seed](saved-seeds.md) |
| Open observer | Open the observer in your browser when the run starts |

Values are checked with the same rules as the command line, and problems are shown
beside the field. **Ctrl+S** or **Start simulation** begins.

### Running simulation

While the world is prepared the screen shows what is actually happening: each build
step, the server starting, and, for a seed-selected city, the map download with its
real size when the server knows it. Then it shows the engine's own figures, refreshed
four times a second:

| Shown | Source |
|---|---|
| Place, seed, day | The loaded world |
| Simulation time and progress | `GET /api/v1/playback/status` |
| State and speed | The same |
| Vehicles (modelled), halting | `GET /api/v1/view/traffic` |
| Congestion and its 15-minute average | `GET /api/v1/view/congestion` |
| Flooded and closed roads, active storms | `GET /api/v1/view/traffic` |
| CPU and memory | Measured with `ps`, for a server this launcher started only |
| Time until the day ends | Remaining virtual time divided by the current rate, while running |

Below them is the live log: the launcher's own messages and new lines of the server's
`system.log`. The terminal does not attempt to draw the city; the observer does that.
Polling never touches the simulation, so watching from the terminal cannot change a
run.

| Key | Action |
|---|---|
| Space or p | Pause or resume |
| o | Open the observer |
| s | Stop the simulation, after confirmation |
| Esc or b | Back to the dashboard; the simulation keeps running |
| f | Toggle following the newest log line |
| c | Clear the visible log (the log files are untouched) |
| End | Jump to the newest log line |

**Stopping** asks first. It requests a graceful shutdown, shows *Stopping
simulation…*, waits up to ten seconds, and only then terminates a server the launcher
started. It reports that the simulation stopped only once the server has actually
exited.

### Completed

When the virtual day reaches 24:00:00 the launcher shows the run's summary and offers
**Open the observer** (where **Save Report** produces the PDF), **Restart the same
day**, **Run another simulation** and **Back to main menu**.

### Configuration

Edits `config/defaults.json`, grouped as **Run**, **Map**, **Modules**, **Weather**
and **Server**. Only settings that the launcher or the engine actually read are
listed; see [Configuration](configuration.md) for every key. Each value is validated
as you type, with the reason shown beside it, and invalid values are never written.

The header shows `! UNSAVED` while there are changes. **Ctrl+S** saves. Leaving with
unsaved changes asks **Save and continue**, **Discard changes** or **Cancel**.

### Errors

A recoverable error stays inside the interface. It says what happened, what to do,
and where the details are, and offers the next steps:

```text
╭─ Unable to start the simulation ─────────────────────╮
│ could not fetch the map                               │
│                                                       │
│ Check the network, VPN or proxy, or set               │
│ DSTNS_OVERPASS_ENDPOINTS to a reachable instance.     │
│                                                       │
│ Details have been written to: logs/launcher.log       │
│                                                       │
│ > Retry                                               │
│   Diagnostics                                         │
│   Return to menu                                      │
╰───────────────────────────────────────────────────────╯
```

Python tracebacks are shown only with `--debug`.

## Keyboard

| Key | Action |
|---|---|
| ↑ ↓, or k j | Move |
| Home, End | First or last item |
| Enter | Select |
| Tab, Shift+Tab | Next or previous control |
| Esc | Back, or close a dialog |
| ? | Help for the current screen |
| q | Quit (from the dashboard and the environment check) |
| Ctrl+C | Quit safely: if a simulation this launcher started is running, it asks first |

The selected item always carries a `>` marker, so selection is visible without colour.
A mouse works but is never needed.

## Terminal size and capabilities

| Class | Size | Layout |
|---|---|---|
| Large | At least 100 × 30 | Sidebar and content, full wordmark, full key hints |
| Medium | At least 70 × 22 | Narrower sidebar, shorter hints |
| Small | At least 50 × 15 | One column: the menu above the content |
| Too small | Below 50 × 15 | A notice with the current and minimum size; R switches to compatibility mode |

Resizing reflows the screen and keeps the current screen, the selection, form values
and a running simulation. Menus and status summaries adapt to the available
width. Log panes support scrolling when previously rendered output is wider than
the resized terminal.

In the small running layout, the place, seed, simulation time, state and speed
remain visible alongside progress and live output. The additional network and
process metrics return when the terminal is enlarged; the browser observer also
provides the network details.

The launcher assumes only the terminal's own monospace font: no Nerd Fonts, no
ligatures, no images. Colour degrades from truecolour to 256 and 16 colours to none
(set `NO_COLOR=1` or pass `--no-color`), and every state is also written as a word.
It works over SSH and in IDE terminals.

## Commands

| Command | Does |
|---|---|
| *(none)* | In a terminal, opens the launcher. Without one, starts a run, like `start` |
| `start` | Build what changed, start or reuse the server, start a run. In a terminal, shows it on the running screen |
| `console` | Opens the launcher's dashboard |
| `seeds save\|list\|inspect\|delete [ID]` | Manage saved seeds, printing JSON; see [Saved seeds](saved-seeds.md) |
| `ui open\|dev\|build\|install` | Open the observer, run its Vite development server, build its bundle, or install its dependencies |
| `logs [system\|api\|event\|playback]` | Print a log. Without a source, in a terminal, opens the log viewer |
| `config` | Opens the configuration editor; without a terminal, prints the current values |
| `test [all\|unit\|api\|replay\|benchmark\|sumo\|ui]` | Run test stages and print a summary; the exit status is non-zero if any fails |
| `sumo` | Check the SUMO toolchain on a synthetic grid, outside the server |
| `reset [--yes]` | Delete runtime logs, the journal, checkpoints and temporary files, after confirmation |
| `apps [list\|add\|set\|show\|remove\|run\|status\|logs\|doctor\|proposals\|approve\|reject]` | The applications this launcher can start; see [Applications](#applications) |
| `fabric [status\|capabilities\|grant\|settings\|audit]` | Look at and act on a running server through the Fabric API |
| `fastboot [download\|status\|clear]` | Download every city in advance for [Fast Boot](#fast-boot) |
| `demo [--no-open] [--no-music] [--no-fullscreen]` | [Demo Mode](#demo-mode): the film on a loop, until Ctrl+C |
| `help`, `version`, `license` | Usage, version and licence notice, the licence text |
| `--mode=server` | Run `dstns_server` in the foreground with the configured host and port |

### Run options

For `start` and `seeds save`:

| Option | Range | Meaning |
|---|---|---|
| `--seed N` | Decimal or `0x` hex, up to 128 bits | The seed. Omitted: a fresh 64-bit seed |
| `--saved-seed ID` | | Run a saved configuration; excludes `--seed` |
| `--save-seed ID` | | Save this run's configuration under `ID` |
| `--description TEXT` | | Note stored with `--save-seed` |
| `--day-type weekday\|weekend` | | Day type |
| `--duration S` | Integer 60 to 3600 | Wall-clock seconds per virtual day at 1× |
| `--speed X` | 0.01 to 5 | Initial speed multiplier |
| `--max-nodes N` | Integer 2 to 50000 | Graph size cap |
| `--osm-file PATH` | Existing file | Pin a map instead of letting the seed choose |
| `--default-settings` | | Open the observer with its settings at their defaults, forgetting what this browser had chosen. `launcher.default_settings` in `config/defaults.json`, also under Configuration, does this on every launch. |
| `--open`, `--no-open` | | Open the observer in a browser. Default: when a desktop is present |
| `--narrator MODE` | `auto`, `fm`, `off`, `http://HOST:PORT`, `unix:/PATH` | [Realistic News](narration.md). Default: `narration.mode` in `config/defaults.json`, else `auto` |

### Narration

Before it starts a server, the launcher decides whether
[Realistic News](narration.md) can be written, and reports Apple's on-device
model in one of three states:

| State | Meaning |
|---|---|
| **Available** | `fm` is installed, the model is ready and Apple's terms are accepted: Realistic News is on |
| **Unavailable** | Wanted (`auto` or `fm`) but missing, unsupported, not ready or not agreed to: Standard news, with the reason |
| **Disabled** | Turned off (`--narrator off`), or another model chosen with an endpoint |

`auto` and `fm` are checked in order: macOS, the `fm` command, `fm available`, and
`fm license --status`. An endpoint must answer `/v1/models`. When the model cannot
be used the server is started with `--narrator off` and the launcher says why and
what would fix it:

```text
 [OK]    Apple Foundation Models: Available  Realistic News on: news written on this Mac from each event and its context
 [WARN]  Apple Foundation Models: Unavailable  the on-device model is not available (Apple Intelligence is turned off).
         Turn on Apple Intelligence in System Settings and let the model finish downloading. Using Standard news.
 [INFO]  Apple Foundation Models: Disabled  turned off; Standard news
```

Once the run has started it reports what the server's narrator actually did -
**Realistic News ready**, or a warning if the model stopped answering - and the
**Apple Foundation Models** environment check shows the same state. Attaching to a server
that is already running reports that server's narration, which was fixed when it
started. `--narrator` lasts for one invocation; set `narration.mode` (in the
**Server** section of the configuration screen) to change the default.

### Interface options

| Option | Effect |
|---|---|
| `--reduced-ui` | Use compatibility mode |
| `--no-tui` | Use plain mode |
| `--no-color` | No colour (`NO_COLOR` is also honoured) |
| `--no-splash` | Skip the splash; retain environment checks |
| `--no-animation` | Disable terminal animation while keeping activity labels |
| `--debug` | Verbose launcher log, tracebacks, and diagnostics on standard error for scripted commands |
| `--verbose`, `-v` | Show command output while builds and tests run |
| `--yes`, `-y` | Do not ask for confirmation (`reset`) |

## Applications

![Applications in the launcher](../assets/screenshots/launcher-apps.png){ .screenshot }

![Choosing what to start, applications included](../assets/screenshots/launcher-start.png){ .screenshot }

The launcher can start your own programs alongside a simulation. Each application has one or more commands. All but the last must finish successfully, and the last is the application, which stays running.

```sh
./launcher apps add org.example.planner \
    --name "Route planner" \
    --command "python3 -m pip install -q -r requirements.txt" \
    --command "python3 planner.py --url {url}" \
    --required --autostart

./launcher start                                # starts it, because of --autostart
./launcher start --apps org.example.planner     # or name which to start
./launcher start --no-apps                      # or none at all
```

### When things happen

1. The engine is built and started, and the observer opens on its film.
2. The chosen applications start, all at once. The observer says "Starting applications" and how many are ready.
3. **Once they are all ready, the simulation starts**, and the observer goes on to the dashboard as usual.

An application that fails stops the simulation from starting only if it is `--required`. Otherwise the launcher says what went wrong and the run goes ahead without it. Its output goes to `logs/apps/<id>.log`, and an application that has been started this way stops when the launcher does.

### Options

| Option | Means |
| --- | --- |
| `--command CMD` | A command. Repeat it for several. `{url}`, `{port}`, `{id}` and `{root}` are filled in |
| `--name NAME` | What to call it |
| `--cwd DIR` | Where to run it, relative to the checkout |
| `--env KEY=VALUE` | An environment variable. Repeat it for several |
| `--ready HOW` | `fabric`: it reports itself active (the default). `process`: it stays up for a second. `delay:5`: after five seconds. Or a URL that answers |
| `--timeout S` | How long to wait for it to be ready, 1 to 600 seconds, 60 by default |
| `--restart POLICY` | `never` (the default), or `on-failure`, which tries five times, waiting longer each time |
| `--required`, `--autostart` | As above. `--no-required` and `--no-autostart` turn them off |
| `--grant CAPABILITY` | A permission to give it when it registers, so that you are not asked each time |
| `--setting KEY=VALUE` | A setting to give it when it registers |

There is no shell: a command is one program and its arguments, so what is in the catalogue is exactly what runs. Use `--cwd` and several commands instead of `cd` and `&&`. An application gets `DSTNS_URL`, `DSTNS_PORT` and `DSTNS_APP_ID` in its environment, and never the operator's credential.

To be ready, an application calls `PUT /api/v1/fabric/apps/{id}/state` with `{"state": "active"}`. `Fabric/examples/hello_app.py` is the smallest whole one. An application that needs the road network has to wait for it, since the world is not loaded until after it is ready: subscribe to the `lifecycle` topic and draw on the map once the run has started.

### Looking after them

| Command | Does |
| --- | --- |
| `apps list`, `apps show ID` | What is set up. `--json` for a script |
| `apps set ID ...` | Change one, with the options above. Only what is given changes |
| `apps doctor [ID]` | Find what would stop them from starting, such as a program not on `PATH` |
| `apps run ID...` | Start these with a server that is already running, and look after them until Ctrl+C |
| `apps status` | What the server knows of each: its state, requests, refusals and any permissions it is waiting for |
| `apps logs ID` | Its output |

In the terminal interface, **Applications** on the dashboard does the same, and **Start simulation** lists each with a switch.

### Through the Fabric API

An application or the operator can propose how to start one, through the [Fabric API](../api/fabric-api.md#starting-applications-with-the-launcher). A proposal is only ever that. Nothing runs until a person has read exactly what it would run and approved it:

```sh
./launcher apps proposals
./launcher apps approve org.example.planner     # shows the commands, and asks
./launcher apps reject org.example.planner
```

The catalogue, `config/apps.json`, belongs to the person at the machine, is not committed, and only the launcher writes it. `DSTNS_APPS_FILE` moves it.

### Without a simulation

`./launcher apps run [ID ...]` (or `apps start`) starts applications on their own. If no server is running, one is
started, waiting for a simulation, and stopped again when you press Ctrl+C. With no IDs, it starts those set to
start by themselves.

### Web applications

An application with a web interface of its own can say where it is:

```sh
./launcher apps add org.example.planner --command "npm run dev" --ready http://127.0.0.1:5173/ \
    --web http://127.0.0.1:5173/ --web-label "Open planner"
```

The observer then offers a button that opens it in a new tab. An application can also declare `web` in its own
manifest.

### Reloading

A person can reload an application from the observer. Its link with the server ends at once, and the launcher
starts it again. Each process it starts is given a one-time key, in `DSTNS_FABRIC_LAUNCH_KEY`, which it presents in
`X-DSTNS-Launch-Key` when it registers, so it comes back as itself and keeps what a person granted it.
`Fabric/examples/hello_app.py` shows how.

## Settings for every feature

`./launcher config` lists every setting by category, and the terminal interface's Configuration page edits
them. They're kept in `config/defaults.json`, and reach the server as it starts, so a change applies from the
next start of the server. The observer reads them back from `GET /api/v1/system/features`.

| Category | Setting | Default | What it does |
|---|---|---|---|
| Fabric | `fabric.applications` | on | Programs may connect through the Fabric API |
| | `fabric.legacy_api` | on | The older `/playback` and `/control` routes answer. They have no credential |
| | `fabric.launch_proposals` | on | Applications may propose how to start them |
| | `fabric.require_signatures` | off | Every application must sign every request |
| | `fabric.world_regeneration` | on | The observer may ask for a new world |
| | `fabric.allow_frames`, `allow_dialogs`, `allow_camera`, `allow_layers`, `allow_control`, `allow_notifications`, `allow_messages`, `allow_storage` | on | Whether that capability can be granted at all |
| WebFabric | `webfabric.enabled` | on | Applications appear in the observer |
| Startup | `startup.fast_boot` | off | Use maps downloaded in advance, and don't make the film play to its end |
| | `startup.force_animate` | on | The film plays to its end before the map. Fast Boot turns it off |
| Presentation | `presentation.music` | off | Original music during the start-up film |
| | `presentation.fullscreen` | off | Open the observer full screen |
| | `presentation.music_volume` | 0.6 | From 0 to 1 |
| Demo | `demo.music`, `demo.fullscreen` | on | The same, in Demo Mode |

Full screen and music need a page to have been interacted with, so when either is on, the launcher opens the
observer in a window of its own from a Chromium-based browser, with a profile of its own, where both are allowed
from the start. Without such a browser, the usual one opens it, and the observer asks for a click.

### Fast Boot

Fast Boot is off by default. `./launcher fastboot download` downloads every city's district once, from
OpenStreetMap's Overpass API, and keeps each compressed in `fastboot/` in the map cache. It pauses between
downloads to be fair to the service, so it takes a while; it can be stopped with Ctrl+C and picks up where it left
off, and `--cities berlin,london` or `--limit N` download fewer. `fastboot status` says what's there, and
`fastboot clear` deletes it.

With `startup.fast_boot` on, the server unpacks a city from there rather than downloading it. A city that isn't
there, or whose file is damaged, is downloaded as usual. The film then doesn't have to play to its end: once the
world is ready, it gathers into the name and goes to the map. `startup.force_animate` off does the same without
Fast Boot.

### Demo Mode

`./launcher demo` plays the start-up film on a loop with four more scenes about the rest of DSTNS, full screen
and with music, until Ctrl+C. It starts a server of its own with no simulation, on another port if one is already
running, which it leaves alone. `demo.music` and `demo.fullscreen` turn either off for good, and `--no-music` and
`--no-fullscreen` for once. The music is written for DSTNS and generated by the browser as it plays, so there is
nothing to license or download. A small button at the bottom right of the page mutes it. The terminal interface has a Demo and Fast Boot page for both.

## What happens when a run starts

1. **Validate.** `config/defaults.json` and the options are checked against the same
   bounds the engine enforces, and the start request is assembled (see
   [Configuration](configuration.md#precedence)).
2. **Build what changed.** The launcher fingerprints the core's sources
   (`CMakeLists.txt`, `src/`, `include/`, `apps/dstns_server`) and the observer's, and
   rebuilds each only when its fingerprint differs from the one stored beside the last
   build (`.launcher-source`).
3. **Find a server.** If the port (`DSTNS_API_PORT`, else the last one recorded in
   `logs/launcher.json`, else `api.port`) answers `/health` as a current DSTNS server,
   the launcher attaches to it. If something else holds the port, or an older DSTNS, it
   uses the next free port. Otherwise it starts `dstns_server --host H --port P --logs L`
   and waits up to 15 seconds for it to be healthy.
4. **Open the observer**, when requested, and wait for it to load, so the world's
   preparation is watched in the browser rather than behind a blank tab.
5. **Start the run.** `POST /api/v1/playback/start` with the operator credential from
   `logs/operator.token`, following the map download for a seed-selected city.
6. **Confirm the world.** The launcher reads the topology, checks that a real
   OpenStreetMap network loaded, and reports the city, the coordinates, whether the map
   was downloaded or cached, and the size of the network.

If a run is already in progress on the server and no run options were given, the
launcher shows that run instead of starting another.

Without a terminal, `start` then follows the server it started and exits with its
status: 0 when the server stops normally, 1 otherwise. A server it attached to is left
running.

## Ending a session

Leaving the launcher stops a server it started, after confirmation in the interface. A
server it attached to keeps running. When the launcher is ended by `SIGTERM`, `SIGHUP`
(the terminal closed) or Ctrl+C in scripted use, it stops a server it started before
exiting. Cancellation during startup also reaches build commands and their
descendants, prevents a cancelled build from being marked complete, and stops a
server created by the pending startup. **Stop** on the running screen requests
server shutdown; it is separate from pausing simulation time.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | A launcher, configuration, environment or simulation failure, or a failed test stage |
| 130 | Interrupted with Ctrl+C |
| 143 | Terminated with `SIGTERM` |

## Checkouts in OneDrive, iCloud Drive or Dropbox

Sync clients evict files they have uploaded, and some refuse the burst of file
creation a build makes; CMake then fails with "Could not create ...", and
anything reading an evicted file times out. When the checkout is in a synced
folder, the launcher keeps everything it generates on local disk and leaves only
the sources in the synced folder:

| What | Where (macOS; XDG state and cache directories elsewhere) |
|---|---|
| C++ build | `~/Library/Caches/DSTNS/checkout-<id>/build/` |
| Observer build (a local mirror of `WebKit/` and `config/`) | `~/Library/Caches/DSTNS/checkout-<id>/source/` |
| Downloaded city extracts (when `map.cache_dir` is the default) | `~/Library/Caches/DSTNS/checkout-<id>/maps/` |
| Server logs, journal and credential | `~/Library/Logs/DSTNS/logs-<id>/` |
| Launcher log | `~/Library/Logs/DSTNS/launcher.log` |
| Terminal-interface environment, Python bytecode | `~/Library/Caches/DSTNS/` |

`<id>` names the checkout, so two checkouts never share a build.
`DSTNS_BUILD_DIR` and `DSTNS_LOGS_DIR` choose those directories outright. The
server is told where the observer is with `DSTNS_UI_DIST`. Saved seeds stay in
`data/seed-store/`, with the checkout.

If the observer cannot be built - most often because Node.js is missing or no
longer starts - the launcher says why and starts the simulation anyway, serving
the previous observer build if there is one.

## Diagnostics

The launcher writes its own log to `logs/launcher.log` (rotated at 1 MB, two backups;
in a cloud-synced checkout, `~/Library/Logs/DSTNS/launcher.log` on macOS or
`~/.local/state/dstns/launcher.log` elsewhere):
the version, Python and operating system, the terminal's capabilities, environment
check results, server starts and stops, fallbacks to compatibility mode, and the full
traceback of any unexpected error. It never records the operator credential or
environment values. Run with `--debug` for more detail, and for tracebacks on screen.
If the log cannot be written, logging stops quietly for the session; it never
interrupts the launcher.

**Diagnostics** in the dashboard re-runs every check, optionally with the core, HTTP,
loading and observer test suites, and shows the running server's version and SUMO
status, the terminal's size and capabilities, and the paths in use.

## Failure messages

| Message | Meaning and remedy |
|---|---|
| `playback.tick_rate must be in (0, 10]` | `config/defaults.json` asks for a speed the engine refuses |
| `Seed must be a decimal integer or 0x hexadecimal, within 128 bits` | Malformed `--seed` |
| `--seed and --saved-seed are mutually exclusive` | Pick one |
| `OSM data unavailable; provide --osm-file PATH` | A pinned map path does not exist |
| `MAP_FETCH_FAILED …` | The seed's district could not be downloaded. The launcher lists maps already on disk and the command to run one offline |
| `Server did not become healthy within 15s` | See [Troubleshooting](../troubleshooting.md#health-check-timeout-during-start-up) |
| `The server did not load a usable real OSM network.` | The run started but the topology is empty or synthetic |
| `Unknown option: …`, `Unknown command: …` | See `./launcher help` |

More in [Troubleshooting](../troubleshooting.md#the-launcher).
