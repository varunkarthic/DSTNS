# Changelog

All notable changes to DSTNS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
DSTNS uses version numbers that identify three independently versioned parts:
the engine (`DSTNS_VERSION`, set in `CMakeLists.txt`), the observer (`VERSION` in
`WebKit/src/App.tsx`) and the HTTP API contract (`/api/v1`). Each release is
tagged on GitHub as `v` and the engine's version, and says which versions of the
other two it carries. Changes that
alter simulation results for an existing seed or map are called out explicitly,
because the [reproducibility guarantee](https://dstns.readthedocs.io/concepts/reproducibility/) holds
only within one version.

## [Unreleased]

## [3.0.0] - 2026-11-12

**Release 3.0.0. Engine 3.0.0, observer 3.1.0, API contract 1.4.** Results for a seed are unchanged from engine 2.1.0, and
every existing endpoint behaves as before, 155 recorded calls being replayed to prove it, with one deliberate
widening: `tick_rate` now accepts up to 10. Results for a seed do not depend on the rate. `api_version` in
responses reads `1.4`. The observer's folder is renamed from `ui-engine/` to `WebKit/`. The launcher is now a
Rust program, every test is C++, Rust or TypeScript, and nothing in DSTNS needs Python to build, run or test.

### Safer resets, quieter logs, and images from every push

- `./launcher reset` refuses while a server is running, since it would delete the journal and checkpoints that
  server is writing, and without a terminal to ask at it needs `--yes`. The Tools page and the console's reset
  follow the same rule.
- The launcher no longer writes the chosen district's coordinates to its log; the district is named instead
  (CodeQL `rust/cleartext-logging`).
- Building the launcher shows a progress bar that fills as each crate is compiled, with the time taken; without a
  terminal, cargo's own output is shown.
- A push to `v3` now builds, tests and publishes a container image, tagged `:v3` and `:sha-<commit>` on the edge
  channel; only `main` and the release tag move `stable` and `latest`.

### The knowledge graph page, redesigned

- One sidebar holds the search and three tabs: **Explore** (the parts of DSTNS with their share of it, questions to
  try, the kinds of thing), **Filters** (with a count of what is shown and Reset) and **Guide** (how to use it, the
  questions it understands, its keys). Results take the sidebar's place while a search is open. It hides to give the
  map the whole page.
- The map's controls (zoom, show everything, names on or off) sit together at the bottom right, and the card for the
  chosen item opens at the top right.
- A new set of icons, drawn as one family, for the kinds of thing, the kinds of link, the tabs and the controls.
- Standard types and borrowed symbols (`string`, `json`) are no longer named on the map unless chosen or found.
- On a phone the sidebar and the card open as sheets over the foot of the map.
- Every control has a tooltip in the page's own style, which comes at once when moving from one to the next. The
  sidebar, the search results and the card open and close with motion, and results and questions to try have more
  room.

### The launcher's menus, and the observer's tooltips

- The launcher's main menu is in sections, **Simulation**, **Set up**, **Inspect** and **Help**, with Exit
  last, as Configuration's categories are. Headings sit level with the selection marker and the keys pass over
  them; a heading stays in view above its first item when a long list scrolls.
- Every page's list is the same width and widens for a long label instead of cutting it ("Delete downloaded
  cities", "Clock, units and news"), and lines up at the same column on every page.
- Each panel beside a list is titled with what is chosen (a task, a log, a saved seed, an application), where
  some had an untitled rule and a heading inside.
- Applications lists what is registered and what asks to join under their own headings, and says `running` in
  words rather than with a dot.
- A log page's message that it has nothing yet wraps instead of being cut, and narrow rows in Diagnostics stay
  on one line.
- Tooltips show the control's keyboard shortcut as a key cap, following the keys set in Settings, and give it
  to screen readers. The name and its sentence are clearer apart, sentences break evenly, and a tooltip stands
  a little further from its control.

### State machines, reviewed

Every explicit and implicit state machine is now set out in **State machines** (Design), with its states,
transitions and guards. The review fixed:

- A stop while a world was still being prepared, the first or the next, no longer lets it arrive afterwards and
  start (or wait paused) by itself; a stop after termination began no longer reads as Stopped.
- A WebFabric application that was unloaded can no longer revive itself by reporting a state; a report counts as
  checking in; resuming one that has stopped checking in shows it as not answering; one reloading reads Reloading.
- A reload asked while a supervised application is still preparing no longer fails it.
- The launch test expected the server's features without `music_track`, which the music change had added.
- WebFabric's list of applications in Settings: an application's initial was stretched into a wide blur and its
  description ran out of the panel; an application's own settings drew sliders centred and indented. Both now sit
  in the column as the rest of Settings.
- The screenshots in the README and the documentation are retaken from this version, at Retina resolution.

### The documentation site, redesigned

- The observer's look carried over: one radius family, the section tabs as a capsule with the current one a
  tinted pill, a navy glass header, sidebars where a section is a small heading and the current page a tinted
  row, and contents on a hairline track that marks the section being read.
- Pages keep a readable measure; tables are one rounded card with a tinted head; notes are tinted cards; code
  sits in rounded wells; previous and next are two cards at the foot.
- The home page opens with its promise, the figures as one strip, and a card with an icon for each part.
- The Graph frames the whole map beside the welcome panel on a first visit, instead of behind it.
- Nothing scrolls sideways on a phone.

### The launcher's settings, in sections

- The Configuration page groups every category under a heading: Simulation, Start-up, Observer, Server,
  Applications, Intelligence and Launcher. The arrows pass over the headings; Home and End go to the first and
  last category, never a heading.
- The **Observer** section is new: thirty-seven of the observer's operator defaults (theme, colour vision, reduce
  motion, notifications, Auto Focus, playback jumps, clock, data sizes, news style, the layers shown at first,
  the tutorial, backpressure reporting), held to the same limits the observer applies. They are kept in
  `config/ui-config.json`, which is written only when one of them changes, and travel in launch codes like
  every other setting.

### Time Control, High Contrast and the observer's panels

- **Time Control**, from the clock: go to a time earlier or later in the day, jump by any number of hours and minutes
  either way, and choose 12- or 24-hour time. Holding the clock switches 12- and 24-hour time at once.
- **A jump you can follow.** Its particles gather speed and slow to a stop on gentle curves, and the clock in its label
  runs towards where it lands.
- **High Contrast**, in Accessibility (`accessibility.high_contrast`): text at full strength, firmer edges and
  outlines, thicker focus rings and solid surfaces.
- **Panels that keep their shape.** The notification opens on a spring as the dock's panels do; it and the collapsed
  telemetry strip keep their rounded corners all the way. The dock's panels are as tall as the dock, the strip's
  panels are as tall as the strip and no taller, and Network shows its figures two by two with the system beneath.
- **Telemetry folds without spilling.** Its contents are cut to the panel as it narrows into the strip, and the
  panel settles without bouncing, so the strip never squeezes thinner than itself on the way.
- **Time Control, tidied.** It has a close button and the day's progress in its heading; Go and Jump sit beside
  their fields; the distance reads "earlier than now" or "later than now"; scrolling over a field steps it. Menus
  from the bar clear the whole bar rather than its button.
- **Empty states with a drawing**: a quiet junction with nothing to report, a sun not yet up, an empty timeline, a
  mast with nothing to send, a filter nothing passes, a plug short of its socket, a row of empty tiles, a glass over
  the map and a pin with nowhere to land, drawn as DSTNS's own line figures in one hand, each with one small motion
  that stops for reduced motion.
- **One dialog.** Every dialog is the same wide card: a figure on a plate at its left that acts out what it is about,
  and beside it a title, a few words, and the answers side by side, the way out first and the action named with its
  icon. About is two panes, who made it on the left and this run on the right. A dialog comes forward on a spring and
  leaves as smoothly, shrinking a little and softening as its scrim lifts.
- **Figures that answer.** The line figures lean a few degrees toward the pointer, their subject a little further than
  the rest, and draw themselves again when pressed.
- **New World beside the seed** is a labelled button tinted like Terminate, and so is the action that confirms one.
- **A found building is outlined.** Choosing a place in Search traces round the walls of its building, or the building
  it stands in, and lights it; a place with no building gets a ring the size of its marker.
- **Even edges.** A panel's cards sit 8px inside it with corners concentric to its own, in the strip's side panel too;
  Queue's view and category and Notifications' filters are a bar across the top of their card, and a pop-up menu
  lines up with the edge of the control that opened it. Scrolling lists blur a little as they pass under a panel's
  lower edge.
- **A Stack that fills its card.** Its rows share the deck's height, each with the last minute of its figure drawn
  beneath it; on a short window they keep to their bars.
- **One name between worlds.** Generating a new world flies the old roads into the name, and the new world's film
  carries on from that name as it stands, instead of blowing it into a mist and forming it again.
- **WebFabric for planners.** A `qr` widget draws a code a phone's camera reads, from the observer's own encoder; an
  application that declares a `web` page gets a button in its bar that shows that page's code in a sheet inside its
  panel. Widgets in a tab can sit side by side on the grid, an application's sidebar scrolls within itself, and the
  capabilities list names every widget the observer draws. The bus planner example follows a documented planner
  template: a tab per algorithm, a replay of the network being built, and a journey picked on the map and planned by
  both Dijkstra and A*.
- **A report in six parts.** The PDF is organised as At a glance, The city, Traffic, Disruptions, How it ran and
  Reference, each beginning its own page under a band that says what it covers. The executive summary opens with the
  day in one sentence and whole-run figures rather than the moment of export, follows them with the day's congestion,
  numbered findings labelled by their source, and the network as a map. Road classes are drawn as a ring, and the
  event timeline counts peaks in demand by hour instead of listing each one, which took it from nine pages to two.
- **Knowing the link.** The interface estimates how fast its link to the server is from what it already downloads,
  through Resource Timing, with no requests of its own, and says about how long a new world's map will take to load
  when that wait is long enough to mention.
- **Put away first.** Regenerating, terminating or starting over first closes whatever is open (Settings, Search,
  a menu, a strip panel, the notifications), and asks only once it has gone.
- **A new Time Control.** The day is a line to put a finger on: now is marked, a press or drag chooses a time, and the
  head says where that lands and what part of the day it is before it is chosen. Times of day, typed hours and quick
  jumps either way sit beneath it.
- **Cards that say what happens.** Start over, New World and Terminate each say what they are about, ask, and set out
  what confirming does as three facts before the answers.
- **Smoother edges.** Panels divide without an outline, a panel begins to bud as the pointer reaches its icon, lists
  have no scrollbars and no blur under their edge, a deck tab's content comes in with its pill, and the bottom bar
  keeps its session controls together at its end.
- **Tampering noticed before a start.** With Advanced Security on, the launcher keeps digests of the settings and the
  server program, refuses to start a server when any changed outside it, and `security accept` is the override: it
  asks, then records who accepted what in `logs/security-audit.log`.
- **No storm of warnings.** A daemon saying the same thing again while its notification is still showing, as a memory
  reading wavers about its threshold, updates that one notification and counts up instead of adding another.
- **No crash on expand.** Expanding telemetry while its strip panel was opening sent the interface into a render loop;
  the panel now goes at once, and a division that is stopped part way leaves nothing drawn behind it.
- **One body dividing.** A panel stays joined to what it grows from while it swells, and parts only once it is nearly
  its own size; the shape casts the panel's soft shadow instead of an outline, and a pill-shaped menu keeps its corners.
- **Space plays.** Space and every other shortcut work after clicking a button; Space presses a control only when the
  keyboard brought the focus to it (how the focus arrived is recorded as it moves, since the browser's own signal for
  this turns on at the key press itself).
- **No flash on close.** A panel that has finished closing stays hidden instead of showing whole for a frame, closing
  ends on its own momentum rather than leaving a bead at the edge, and opening leaves the edge at once.
- **Small questions.** Start over, New World and Terminate are compact: an icon, the question, one line of what happens,
  and one thing worth knowing (the seed to come back to, or exporting the report first).
- **Time Control, refit.** The time to go to is one capsule of hours, minutes and Go that divides into a capsule per
  part while it is edited; times of day and jumps are two even rows beneath.
- **Reset asks in place.** Reset all settings turns into its own question in the same card, then into what was done,
  then back.
- **One material for list controls.** Queue's view and category and Notifications' filters share one height, tint and
  edge, with room around them, and a list's menu matches them.
- **About, refit.** Its facts sit in two columns with long ones across both, and the licence is a section of its own
  rather than a fold that showed as a line.
- **Small fixes.** A row's time on the right is never cut off, and an incident's rings can no longer be drawn with a
  negative size (which threw) when the page's clock is behind the snapshot's.
- **The day is complete, celebrated.** A ring for the day fills with a sun travelling round it and turns into a check;
  the figures count up in comfortable tiles, and the next steps sit in clear rows with the seed to come back to.
- **Starting over rewinds.** The day visibly streams back to 00:00 for at least a moment, however quick the jump.
- **The report has the screen.** Saving a report first puts away the finished day's card and any open panel, and brings
  them back once the report is saved.
- **Roomier questions, a centred status.** New World and Terminate have more space and settle in part by part; Online
  is a centred pill like its neighbours.
- **Liquid division.** The dividing shape is drawn through a goo filter (blurred, then its edge sharpened again), so
  the bead, the neck and the panel meet in one continuous curve and a thin neck pinches off by itself; it holds 60 fps.
- **Everything a ticketing app needs.** WebFabric adds `seats`, `combobox`, `player`, `form`, `countdown`, `notice`,
  `code` and `empty` widgets and icons on buttons, so every element of the group-08 bus planner's portal, dashboard
  and control room has a widget drawn in the observer's design; the WebFabric page maps each one.
- **Launch codes.** `./launcher launch-code [--world] [--keys]` prints the launcher as one code and `./launcher launch
  CODE` becomes it and starts from where it was: with `--world`, the same moment, play state, speed and the operator's
  own changes, made again at the moments they were made; with `--keys`, the API keys sealed with a passphrase. The
  engine's change history now includes what each change set.
- **Your own music.** `presentation.music_file` and `demo.music_file` take an MP3, M4A or WAV file (up to 64 MB) for
  the start-up film and Demo Mode, served at `GET /api/v1/system/music` with ranges; it loops with the score's fades,
  volume and mute, and falls back to the written score if the browser can't play it.
- **Lighter division.** The liquid filter is used only while bead, neck and drop are joined, the content fades without
  a blur, per-frame state is written only when it changes, and the map draws one frame in three while a panel divides.
- **A lighter map.** Vehicles are drawn without closing each shape by hand, which had been the map's largest cost.
- **Panels divide from what opened them.** Settings and Search bud from the dock, the collapsed telemetry
  strip's panel from the strip, and the bar's menus from the bar:
  a bead, a neck that thins and parts, and a drop that grows into the panel; closing runs it backward, and either can
  interrupt the other.
- **A tour that waits its turn.** A tutorial set to open at start-up comes in once the roads have landed and the panels
  are at rest, eased in over them, and Auto Focus does not move the map first.
- **A start that runs in order.** A world ready while the title's logo is being taken apart waits for it to become the
  film's name, and a new world's mist has no hole at its middle.
- **Dynamic Fastboot** removes a used world's city, and what was kept beside it, once a world in another city takes
  over.

### The knowledge graph

- **A map of the code**, on the documentation's new **Graph** tab: every file, class, function and documentation
  section, and what contains, calls, imports and refers to what, laid out as islands of what belongs together. It is
  built by [graphify](https://github.com/safishamsi/graphify)'s AST extraction (no model, no key) on every
  documentation build, laid out at build time, and served as one compact file, so it draws at once.
- **Searched in plain words**, in the page and with no model: code names split, typos forgiven, DSTNS's own terms
  widened, and questions read as relations (*who calls physics_step*, *what is inside App.tsx*, *functions in the
  launcher*). Results come as you type, a best match first and the rest grouped by kind, with the words typed marked
  in each name; a member is found after the class it belongs to, not before it, and no one file fills the list. A
  question the graph has no answer to says so and shows what has that name.
- **A card** that says in one sentence what an item is and where, opens it on GitHub at its line, and lists what it
  holds, calls, depends on and is used by, each row going to that item. The chosen item's links flow from what uses
  to what is used.
- **Laid out as the observer is**: a search bar at the top, a dock of tools on the left with Filters (everything,
  code or docs; kinds; parts; a folder; kinds of link; quiet items), Colours and How to use it, solid panels and
  groups tinted by the part they belong to.
- Files that share a name with another (`apps.rs`, `index.md`, `motion.ts`) are files in the graph, not symbols.
- **In a clone too**: `data/graph/dstns-graph.json`, which the new **Knowledge graph** workflow rebuilds after every
  push. `./launcher graph` asks it, the MCP Handler offers it as `graph_ask`, `graph_show`, `graph_relations` and
  `graph_path`, and a **Claude skill** (`skills/dstns-graph`, and a download on the Graph page) asks it from Claude.
- **Questions answered in the launcher**: one typed at the prompt, or to `ask`, is answered in a few sentences from what
  the graph says, by the launcher's model where there is one, each naming the file and line it comes from.

### The command bar's output

- Each command is a card: what ran, `✓ done` or `✗ exit N` and how long it took, and what it printed beside a rail.
- The wheel scrolls the output when the pointer is over it, as do PgUp/PgDn and Shift+↑ ↓, with a scrollbar and a foot
  that says where you are; Ctrl+Home and Ctrl+End go to the oldest and newest.
- Its top edge is a handle: drag it, or press Ctrl+↑ ↓, to size the output, and it keeps that size.

### Long jumps that keep answering

- **A long jump through the day no longer freezes the run.** It is worked out in slices that let go of the engine
  between them, as playback does, so status, snapshots and the daemons keep being answered: a jump to 16:00 that
  left status unanswered for 13 s now answers it within 75 ms. A jump forward sent while one is under way sends it on.
- **Restricted**, a new runtime status: a jump of half an hour or more lands at 0.25× and doubles back to the chosen
  speed every two seconds, with map motion reduced, so a day's burst of state reaches the interface at a pace it can
  draw. `GET /api/v1/system/backpressure` says why in `restriction`.
- **The jump's clock follows the server** while it is worked out, easing towards how far it has really got, so it
  never stops short of the target and waits. A jump's request no longer gives up after 15 s.

### The report

- **System Resources**, a new section: the server's memory over the observation and the interface's heap, processor
  use, the change over the observation, and the system's parameters. `GET /api/v1/system/resources` reads the
  server's memory cheaply; `/api/v1/system/info` reports `rss_bytes` beside the peak.
- **Restricted, degraded and offline periods** say why each happened, and **Jumps through the day** lists every
  jump and whether the run was Restricted after it.
- Each section opens with a still line drawing of what it covers.
- Before the export film, the map is brought to show the whole network, so the cover is made from all of it.

### Fixes

- A new world starts with an empty notification tray: the last run's news was briefly read as the new one's
  backlog, and kept as "Before this session".
- The expanded notification has no close button, which did nothing; it closes with its head. An error keeps its own.
- An empty Incidents or Notifications view fills the panel, with its drawing in the middle.

- A WebFabric panel opened before its application may show it, such as a frame waiting for its grant, stays open
  and appears once allowed, rather than closing at the next update from any other application.
- A dropdown opens under or over its field, even inside a panel full of controls, instead of beside the panel.
- The notification's count reads "3 more" rather than "+3".
- The documentation's graph is built with graphify 0.9.102, which no longer lets a Fortran file include files from
  outside the folder being read (GHSA-pcc4-rvhr-2pr8).
- The container image builds again: its build stage copies the daemons and the alerts they build in.
- An application that has unregistered, or been unloaded, can no longer change its interface (`409 APP_NOT_ACTIVE`),
  rather than being told it had.
- A server without a narrator reports the narrator's status with every field, so the API contract holds on Linux.

### The launcher, rewritten in Rust

`./launcher` keeps its commands, options, exit codes, words and screens, and is now one Rust program in `LaunchKit/`,
built by the `launcher` script the first time and again only when its sources change (about a minute once, a few
milliseconds after). It needs Rust 1.89 and nothing at run time; `.venv-launcher/`, Textual and Rich are gone.

- **A console's look.** A black field with one blue accent, a status line along the top (the page, its state, the
  version and the time), sections named on thin rules instead of boxes, single-line fields on a quiet band, and a
  prompt always at the foot. Text wraps or is clipped with `…`, and the status line shortens its right side, so nothing
  overlaps or runs off at any size from 50 × 15 up.
- **A dashboard of readings.** Engine (state, port, the server's pid, uptime and memory), Simulation (state, clock, the
  day as a bar, seed), Next world (Dynamic Fastboot's city and whether it is on disk) and System (checks, applications,
  MCP, the terminal), with the tail of `system.log` beneath.
- **A running page to match.** World, Clock, Traffic and Engine sections, a full-width bar for the day or the map
  download, and the live log under its own rule.
- **A start-up sequence.** The wordmark assembles itself from particles that curve in and land left to right, a band of
  light passes across it, the full name types itself out, and the real checks read out as a timestamped boot log
  under a progress bar: about three and a half seconds at 30 frames a second, overlapping the checks.
- **A first-launch setup** of seven steps (start-up, looks and sound, performance presets, Fabric, MCP, and a review),
  remembered as `DSTNS_SETUP_COMPLETE=1` in `config/launcher.env` and forgotten by a reset. `./launcher setup` runs it
  again.
- **Every setting renamed and redescribed** to say what it does and when it applies, and **settings that conflict are
  never on together**: the adaptive film and the whole film, Fast Boot and the whole film, the MCP permissions and the
  MCP Handler, WebFabric and applications. Wherever one changes (the Configuration page, the setup, `config set`,
  compatibility mode or an AI client), the other follows, and the launcher says so.
- **`./launcher ui PAGE`** opens the interface on any page; `ui demo` opens it with Demo Mode running.
- **Fixed: a run with applications never started.** The supervisor took a lock it already held before starting each
  application.

### The console

Command lines as a Unix shell reads them, joined by `|`, `&&`, `||` and `;`, with quotes kept, exit statuses as a
shell's, and 127 for a command that does not exist.

- **Looking inside:** `json PLACE [PATH]` (and `view`) prints any of the launcher's state, or the running server's, as
  indented JSON, coloured at a terminal and plain through a pipe: `settings` (with every default), `stored`, `ui`,
  `env`, `seeds`, `apps`, `next-world`, `eta`, `launcher`, `status`, `world`, `system`, `features`, `endpoints`, a
  file, or `-` for its input, with a path such as `.api.port`, `-k` for keys and `-c` for one line.
- **Changing almost everything:** `set KEY VALUE` and `unset KEY`, with the same checks and rules as the Configuration
  page; `env set NAME=VALUE` and `env unset NAME`, kept in `config/launcher.env`; `edit settings|ui|env|apps|FILE`,
  in your editor, saved only if it still reads; and `api [METHOD] PATH [BODY]`, any route as the operator.
- **`ps -a`:** every DSTNS server, map download and launcher on the machine, not only this one's.
- **The command bar colours what is typed** (commands, operators, quoted text, options) and the JSON it prints, keeps
  indents when a line wraps, and lends the terminal to `edit`.
- **Everywhere:** in the command bar (`:` or `/`), with `./launcher -c 'LINE'`, with `./launcher shell`, and one
  command at a time from your own shell, which can pipe it: `./launcher ps | grep server`.
- **Readers** of the launcher's state as plain text (`ls`, `cat`, `tail`, `head`, `ps`, `get`, `env`, `uptime`,
  `about`, `docs`) and **filters** for what is piped to them (`grep`, `head`, `tail`, `wc`, `sort`, `uniq`, `cut`,
  `tee`, `echo`). Every other word is one of the launcher's commands, run with its output captured so it pipes too.
- **The command bar** suggests and completes, walks its history (now kept between sessions in
  `logs/command-history`), runs a chained line as `dstns-launcher -c` so a long pipeline never holds up the interface,
  and shows the server's live readings at the right of the prompt: port, state, clock, processor and memory.
- **Fixed: Up and Down in the command bar** walked a recalled command's suggestions instead of the history.

### The daemons

- **Watchers inside the server, each on a thread of its own** (`Daemon/`): the **Resource Control Subsystem** (each
  module's memory and processor against its α, β and γ: below α a quiet note that something may be off, over β a
  warning, over γ an alert), **memory** and **disk** (warnings, and emergencies when critical), **stall** (a running
  clock that has stopped), and the **auto cache handler** (the map cache kept to its budget, abandoned downloads and
  stray files cleared, never the running world's city or the next one). Nothing is said until a condition has held
  for its sustain time, so a spike is not an alarm.
- **Two queues**, handled by the daemon gateway: **daemonEmergencyQueue** (alerts and emergencies, for every
  application to act on) and **daemonNotificationQueue** (the rest). `GET /api/v1/daemon` tells anyone what runs;
  the queues are read with a cursor and a long-poll by the observer, the operator and applications by their tokens,
  and emergencies can be acknowledged. Every message is a template from `Daemon/messages.json`; the alerts are in
  `config/daemon-alerts.json`. Both are built into the server.
- **The operator turns daemons on and off and changes their settings** through the launcher (`daemon.*`, `rcs.*`,
  `cache.*`, `./launcher daemon …`) or `PUT /api/v1/daemon/{name}`; the launcher reports its own and its applications'
  processes to the Resource Control Subsystem.
- **What they say** is in the launcher's log, a toast in the interface for a warning or worse, and a notification from
  System in the observer.

### The launcher, further

- **Asking in plain words:** a request typed at the prompt (or after `ask` or `?`) is turned into commands by the
  launcher's own model, checked as a console line, and put on the prompt to be run with Enter, never by itself.
  `model.provider` chooses Apple's Foundation Models (automatic on Apple silicon with macOS 27 or later), Ollama or
  Groq; `./launcher model` says which, and `model key` keeps a Groq key. The MCP Handler offers the same as
  `launcher_suggest`.
- **Simplified Launch Control:** a terminal smaller than 70 × 22 pauses the start-up and asks whether to use it or
  leave: the launcher on a few lines, with no command bar, for starting and stopping a run, opening the observer and
  the settings that matter most. `launcher.small_terminal` decides without asking.
- **The first page is revealed** from the top down as the start-up ends, behind a fringe of its particles.
- **Scrolling:** `launcher.scroll_lines` and `launcher.natural_scrolling`.
- **Everything a person does is logged:** each page, question and answer, command, setting changed (from what to
  what) and choice.

### Advanced Security

- **`security.advanced`** (off by default): the person at the machine confirms it's them, with the system's own
  prompt, before the launcher can be changed. Touch ID or the password on macOS, through LocalAuthentication and a
  small Swift program the launcher builds once; polkit or sudo on Linux; Windows Hello under WSL. The interface and
  `./launcher shell` ask as they open; a single command asks only if it changes something; turning it on or off
  always asks.
- **The MCP Handler under it** reads, but offers no launcher tool that changes anything, and changes only Fabric's
  applications routes. Fabric and WebFabric work as before.
- `./launcher security [on|off|verify]` and the Configuration page's **Security** section.

### Dynamic Fastboot

Only the very first start downloads while anyone waits. While a world runs, the server chooses the next one, in another
city, and fetches that city in the background; a new world takes it, and so does the launcher's next start, so either
is ready in seconds. On by default (`startup.dynamic_fastboot`, or `DSTNS_DYNAMIC_FASTBOOT=0`).

- **Fixed: `data/maps/next-world.json` was committed,** though it is each checkout's own state, written as Dynamic
  Fastboot works. It is now ignored with the rest of the map cache.
- The next world is named in `next-world.json` in the map cache, so it outlives the server, and the cache sweep at
  start-up keeps its city whatever the policy. `GET /api/v1/world/status` reports it as `data.next`.
- A world that wants a city still being fetched waits for that download rather than starting another, and every
  downloader the server runs, foreground or background, stops when it terminates.

### New worlds prepared ahead

With Fast Boot or Dynamic Fastboot on, asking for a new world in the observer starts preparing it the moment the
dialog opens, while the current world keeps running. **Generate** puts it in at once; **Cancel** forgets it. On screen
the old world's ending plays, its particles gather back into the name, and the name becomes the new map.

- **A new world asked for while the next city is still downloading takes a city already in the cache,** rather
  than wait for that download; the city on its way stays next.
- **Fixed: the name held for four seconds with nothing under it** when a new world was still being built. It moves
  on to the film as soon as it has formed.
- **Fixed: a frosted band hung across the top of the screen** as a new world landed: the shell's own colour,
  showing where the header had been. And the logo flew to where the arriving header was, half off the screen,
  instead of where it comes to rest.
- **The adaptive film has no progress bars under its steps** on a first start or a new world, as it has no fixed
  length.
- **Fixed: a new world's map arrived before the particles had built its roads,** when the observer had been opened on
  a run already going: it took a reload's quicker timing. A new world now lands as a first start does, and the name
  that re-forms goes straight on to the map, without the film's opening caption.
- `POST /api/v1/world/regenerate` takes `{"stage": true}`; `POST /api/v1/world/regenerate/commit` and
  `POST /api/v1/world/regenerate/discard` are new. The world job has a new state, `staged`.

### The adaptive start-up film

The film plans itself by when the world will be ready (`startup.dynamic_particles`, on by default): as many scenes as
fit, in a new order every time, WebFabric only once every other has played, always opening and closing on the name and
the flight into the map. A world from the cache goes from the name straight to the map; one that is ready sooner than
planned cuts back to the name within a moment. It has no progress dashes, since it plays no fixed list.

- **Ready mid-scene, it goes back to the name at once and smoothly:** a scene left before it had arrived is carried
  into the next, so each particle sets off from exactly where it was.
- **A jump through the day shows itself:** faint particles streaming the way it goes, denser and faster from a minute
  to an hour, and how far, while the server works it out.
- **The start-up and Demo Mode show the source,** varunkarthic/DSTNS on GitHub, quietly at the top right.
- **An unreachable server is asked again every five seconds,** and Demo Mode loses and regains its server as a run
  does, with the same ending.
- **Fixed: a new world's old roads jumped to the top-left corner** as the new world's map was set up; and the small
  corner logo no longer shows on a new world.
- **The server says how long a world will take:** `eta_s` and `eta_confident` on the playback, engine and world status.
  The estimate comes from the download as it goes, or the build alone for a cached city, and otherwise from how long
  the last ones took, kept in `preparation-times.json`. The film plans only by a confident one, so a long Overpass
  request no longer leaves it resting on the name until the download ends.
- **`startup.force_animate`** (Play the whole film) is now off by default, and can't be on with the adaptive film.
- **Fixed: "Server Unreachable" could show before the ending had played.** Its words and light were timed from when
  the screen appeared, not from when the particles began, and a page in the background draws no particles. The
  ending now waits until the page is seen, the panels leave before the map as they do when a session is terminated,
  and the words come once the particles have scattered.

### Scrolling menus

- **Fixed: a frosted strip hung at the top and bottom of every scrolling menu** (About, Settings, Layers, the
  feeds). The edges are now a fade on the scroller itself, which grows with what is beyond the edge, rather than a
  blurred band over the content. The bands also took a gap each in menus laid out with gaps, adding 16 px of empty
  space, and stayed half shown on a list that scrolled only a little.

### Demo Mode

- **New scenes, about what sets DSTNS apart:** Time control (playing, fast-forward and rewind along the day, with its
  checkpoints), Many worlds (one seed growing districts of every kind) and AI ready. Seeking, backpressure, the report,
  Fabric, What if and the newsroom are gone.
- **`demo.scenes` chooses which scenes play, and in what order,** edited in the launcher as a list (Space turns one on
  or off, Shift+↑↓ moves it) and passed to the observer as `demo_scenes`.
- **Nothing on screen but the film,** its captions and the licence line.
- **A new score:** an original theme in the manner of a cinematic hero's, with driving strings, timpani, brass and a
  horn line of its own, building and breaking down.

### MCP Handler

`./launcher mcp serve` speaks the Model Context Protocol (2025-06-18, 2025-03-26, 2024-11-05) over standard input and
output, so that an AI client can call DSTNS. Every route in the server's endpoint index is a tool, as are a generic
request and the launcher's own status, settings, seeds, applications, start and stop. No agent is included, and it is
closed by default: `mcp.enabled` lets a client read, `mcp.allow_writes` change things, and `mcp.allow_launcher` start
and stop runs. Every call is logged. `./launcher mcp tools` and `mcp client-config` show what a client would get.

- The endpoint index now lists every route (130), so that each is a tool.
- `GET /api/v1/system/info` reports the server process: `pid`, `uptime_s`, `peak_rss_bytes` and `cpu_s`.

### Every test in C++

- **Fixed (code scanning): an incident's type was looked up on a plain object,** so a type named like one of its
  properties (`constructor`, say) would have been called and thrown. The wordings are now a `Map`.

- **The HTTP suites, the downloader's tests and the release checks are C++ programs** in `tests/http/`, on one harness
  (a server on a port of its own, requests, programs run and watched, stand-in upstreams). ctest runs them under their
  old names, `dstns_http_<name>`, alongside the engine's: 31 suites in all. `launcher_apps` drives the Rust launcher
  end to end, with the test program itself as the applications it starts. New: `api`, `fetch_osm`, `release` and
  `dynamic_fastboot`.
- **`dstns_release`** replaces the image metadata, publishing, image smoke test and licence-header scripts, and is
  tested against a stand-in `docker`. CI builds and runs it, and the launcher's 58 tests, without Python. CodeQL now
  analyses the Rust too.
- **Fixed: the server listened with a backlog of five,** so a burst of connections (an observer, its applications and
  a round of polls) could be dropped before a thread took them. It is now 128.
- **Fixed: a server ended by a signal left its map download running.** `SIGTERM`, `SIGINT` or `SIGHUP` (a
  `docker stop`, Ctrl+C, a closed terminal) killed the server at once, and the downloader, in a process group of its
  own, carried on without it. The server now stops its downloads first, then ends by the same signal.
- **Fixed: a failed HTTP test left its servers running.** A failed check exits without unwinding, so nothing stopped
  them; the harness now stops every process it started before it exits.

### Removed

- The Python launcher (`dstns_launcher/`, `launcher.py`), its requirements and its private environment.
- Every Python test (`tests/api/`, `tests/cli/`, `tests/launcher/`, `tests/docker/`), replaced as above.
- `scripts/image-metadata.py`, `publish-image.py`, `license-headers.py` and `launcher-logo.py`, and the redundant
  `scripts/run.sh` and `scripts/reset.sh` (`./launcher --mode=server` and `./launcher reset` do the same).
- The Python client examples in `Fabric/examples/` and `docs/development/example_app.py` remain, as examples of an
  application written in Python; any language that speaks HTTP will do.

### Faster, and configurable

Results are unchanged: a snapshot is the same JSON to the byte, and a replayed day ends in the same state.

- **Snapshots in less than half the time,** written directly as text rather than built as a JSON document first. As the
  observer asks for them, with three demand causes a road (`?causes=3`), one is a sixth of the time and half the bytes.
- **The physics takes about 30% less time:** demand no longer rereads every place's roads while nothing anywhere is
  raining, flooded or closed, and works out each kind of place's daily rhythm once a second.
- **Snapshots and the topology are compressed at a level you choose,** fast by default.
- **A hidden observer asks every 5 seconds,** and at once when it's shown again.
- **Settings for all of it,** under Performance in `./launcher config`: compression, API and engine threads, the map's
  frame rate, its render scale, and the film's particles.
- **Fixed: the integrity digest of a compressed response was of the compressed bytes,** which a browser can't see. It's
  now of the body as the client reads it, as documented.
- **Fixed: a snapshot asked for while a world was being prepared answered 400.**
- **Fixed: speed errors gave the wrong limit,** saying 5 or 20 where the limit is 10. The docs said 20 in places too.
- **On macOS the server links the system's libcurl,** not a package manager's.

### No Python at run time

- **The engine downloads maps itself.** `scripts/fetch_osm.py` is replaced by `dstns_server --fetch-osm`, with the same options, failover between Overpass mirrors, progress, atomic writes, manifest and messages. The engine runs it in a process of its own, as before. It needs libcurl to build. `DSTNS_PYTHON` is replaced by `DSTNS_FETCHER`.
- **The container needs no Python.** `dstns-run` is now `dstns_server --run`, the health check is `dstns_server --probe`, and the image no longer installs Python.
- **Fast Boot opens as a reload does:** the name alone, waiting with a light passing across it, then the roads.

### A setting for every feature, web applications, Fast Boot and Demo Mode

- **A setting for every feature.** `./launcher config` and the terminal interface's Configuration page now cover Fabric (applications, the older API, launch proposals, signatures, each capability), WebFabric, start-up, music, full screen and Demo Mode. They reach the server as it starts, and `GET /api/v1/system/features` reports them. With `fabric.legacy_api` off the older routes answer `410 LEGACY_API_DISABLED`; with applications off, registering answers `403 APPLICATIONS_DISABLED`; a capability turned off answers `403 CAPABILITY_DISABLED`.
- **Applications without a simulation.** `./launcher apps run` starts applications on their own, with a server waiting for a simulation if none is running, and stops it again afterwards.
- **Web applications.** An application may name its own web interface, as `web` in its manifest or with `./launcher apps add --web`. The observer offers a button that opens it.
- **Reloading an application.** From the observer, or `POST /api/v1/fabric/apps/{id}/reload`. Its token stops working at once and the launcher starts it again; it registers with a new one-time launch key and keeps what a person granted it. An application nobody launched is unloaded instead.
- **The WebFabric panel is a canvas.** Widgets are placed on a grid of up to 12 columns with `layout.columns` and each widget's `area`. New widgets: metric, card, chart, link, divider, status and timeline. With several applications, a menu at the top chooses between them, and each has Reload and Turn off. Settings can turn off one, several or all at once. An application that goes leaves the panel with an animation, and so does its panel when open.
- **Fast Boot, off by default.** `./launcher fastboot download` downloads every city's district once, compressed, into the map cache. With `startup.fast_boot` on, the server unpacks a city from there instead of downloading it, in under a second, and the film need not play to its end: once the world is ready it gathers into the name and goes to the map. `dstns_server --list-cities` and `--city-of-seed` list what there is to download.
- **`startup.force_animate`.** Off, the film behaves as with Fast Boot even when maps are downloaded as needed. Fast Boot turns it off. (Now off by default; see the adaptive film above.)
- **Demo Mode.** `./launcher demo` plays the film on a loop, full screen, with scenes of its own after the usual eleven (see Demo Mode above). It has a server of its own, and leaves one already running alone.
- **Music.** Original music, generated in the browser as it plays, for Demo Mode, and for the ordinary film when `presentation.music` is on. A small button at the bottom right mutes it, and the choice is remembered. It fades out as the map arrives. Full screen and music are off by default outside Demo Mode.

### Security fixes from an audit of the API

Found by reading every route, and by sending hostile values to all of them. `tests/http/robustness.cpp` now does that on every run.

- **Fixed: a deeply nested JSON request crashed the server.** JSON may now nest 64 levels.
- **Fixed: no limit on the size of a request.** It's now 16 MiB.
- **Fixed: another site could put the observer in a frame,** and trick someone into clicking its controls. It now sends `frame-ancestors 'none'`, `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy`.
- **Fixed: anyone could get a response signed.** Sending a made-up signature with a chosen nonce got a real signature over that nonce, which could pass one response off as the answer to another request. Only a request that verifies now gets one.
- **Fixed: a stolen token could turn signing off,** by registering again without it. Updating an application that requires signatures must now be signed.
- **Fixed: taking up an ID someone had left handed over what they kept,** including storage and queued events. It now starts empty, and keeps only what a person chose for its settings. **Applications that want to keep their storage must keep their token.**
- **Fixed: SUMO export wrote wherever a request said.** It's now confined to `data/`, unless the request has the operator's credential. **A deliberate change:** a client passing another directory now gets `403 DIRECTORY_NOT_ALLOWED`.
- **Fixed: the audit log could be flooded or bloated.** Parameters over 2 KiB are recorded as truncated, and a refused request to direct the view counts against the limit.
- **Fixed: programs that had gone could use up every place for an application,** and a stop's ID above 32 bits wrapped to another junction.
- SUMO failing is now `503 SUMO_FAILED`, and not `500`.

### Applications can direct the view: Fabric 1.4

An application asks, and the observer decides. Nothing here changes a person's settings, is saved, or outlives
the application. All of it is additive, and every recorded call behaves as it did.

- **Where the map looks.** With `ui.camera`, granted by a person: `POST .../view` to centre on a point, a junction or a road, fit an area, zoom in or out, or show the whole network, with `span_m` for how much to show. It moves with the map's own springs and within its own limits. A person who has just moved the map keeps it for 8 seconds, and the tutorial, dialogs and arrival come first. The application is told what became of each request.
- **What the map shows.** With `ui.layers`, granted by a person: `PUT .../presentation` holds layers and kinds of place on or off. It's laid over a person's choices, and is not one of them. The Layers and Places panels name who holds what and offer a way back, a person's own change wins, and reduced detail under load can't be undone by an application. It ends when the application leaves, is suspended, stops checking in or loses the grant.
- **How a path looks.** `style` is solid, dashed, dotted or flow, where dashes run along the line. `glow` adds a soft light. `color` is `auto`, a stable colour from the palette, or `#RRGGBB`, which is moved until it can be seen on the map in the current theme and gives way to a colour vision mode.
- **All of it is limited and on the record:** 2 a second with a burst of 4, closed lists and ranges, and each request in the audit log, refusals too.
- **A security guide.** [Fabric and WebFabric security](https://dstns.readthedocs.io/api/security/) sets out who can do what, what each protection does and doesn't do, and how to check it.

### The report and the film

- **A new cover for the report.** A dark page in the observer's colours, with the run's own map behind the words as a flat drawing, in focus through the upper middle and softening and dissolving down the page. It's worked out from the run: which way the main roads go, how busy each street is now, which roads are in trouble, and a tint for the simulated hour. The name stands low on the page, over what the run came to and what identifies it. It's painted at 300 dpi, and a long name or seed is set smaller and isn't cut off.
- **Making a report now feels like the start of the film.** The map's own roads brighten as the interface softens behind them, lift off as particles, ride one current together, and land on the same roads as the cover draws them. The cover fades in under them, the file saves, and they go back the way they came. It runs at full frame rate, with the work on a worker.
- **The WebFabric scene has been redrawn, and is abstract now.** A rippling fabric of fine threads is the simulation. One at a time, points of colour arrive above it and let a strand fall. Where each touches, a ring of its colour spreads through the whole cloth and a thread of it is woven in.
- **Particles cross between scenes as one body.** A timed move, with no sudden start or stop in speed or in the change of speed, in place of a spring. A front crosses each scene from a direction of its own, a shared current carries them, and they dim a little while in flight, so that the crossing is a veil and not a blaze.
- **The camera moves more deliberately.** One move over 2.5 seconds, again with no jolt at either end, drawing back a little on the way. Its slow drift comes in only after it has arrived. Fixed: a jump in distance of up to 5% at each change of scene.

### A tab in the background is not a failing tab

- **Fixed: coming back to the simulation found it suspended.** Opening the report in a new tab and returning a while later found ASB at 100% and the interface suspended. A hidden page draws nothing and has its timers throttled, which looked exactly like one failing to keep up. The page now says it is away, nothing it reports meanwhile counts against it, and on its return it has a moment to catch up with a note saying so. Failing while visible is still acted on.

### The launcher starts your applications too

- **Applications start alongside a simulation.** Set one or more commands for each with `./launcher apps add`, or in the terminal interface, and choose which to start with `--apps`, with a switch for each when starting a run, or by setting it to start every time.
- **The simulation waits for them.** The engine comes up, the observer opens, the applications start, and only when all are ready does the simulation start and the observer go on to the dashboard. The observer says what it is waiting for. A required application that fails stops the run, with the reason; an optional one does not.
- **They are looked after.** Each has its own process group and log, can restart with a growing wait, and stops with the launcher. There is no shell, and an application is never given the operator's credential.
- **The launcher is made of modules.** A module adds commands and dashboard pages, and the command line, its help and the dashboard are built from what they add. `./launcher apps` and `./launcher fabric` are the first.
- **The terminal interface has been redesigned** to match the observer: its colours, one rounded card for one thing, a summary across the top of the dashboard, keys that look like keys, and forms without wasted lines.

### The engine moves under Fabric, and Fabric is secured

**Every older route still works, and 155 recorded calls replay with no differences.**

- **The engine's controls are in the Fabric API,** at `/api/v1/fabric/engine`, where changing anything needs the operator or the observer. The observer and the launcher use them. The older `/api/v1/playback` and `/api/v1/control` routes still answer, and now say they are legacy, in the body and in `Deprecation` and `Warning` headers.
- **Tokens are hashed.** The server keeps only a hash, and a store from before this is converted when it is next read.
- **Requests can be signed** with HMAC-SHA-256 and a nonce and timestamp, which stops a changed or replayed request. An application can require it of itself, so that a stolen token is not enough, and it can replace its credentials at any time. Signed requests get signed responses, and every Fabric response carries a digest.
- **TLS,** in a build configured with `DSTNS_TLS`, with `--tls-cert` and `--tls-key`. A server that is asked for it and cannot provide it refuses to start. The default build is unchanged and does not link OpenSSL.
- **The audit log is a hash chain,** which can be checked, and **the store of applications is sealed**: one that has been changed is set aside and not believed.
- **A frame comes only from where the manifest says,** if it says, and asking for more origins asks the person again.
- **The launcher can be told how to start an application** through the API. It is only ever a proposal, and nothing runs until a person approves it at the launcher.

### More for applications: Fabric 1.3

Everything here is additive, and every recorded call behaves as it did.

- **Applications can follow the simulation.** `PUT .../subscriptions` chooses what arrives as events: lifecycle, a new world, the news or one category of it.
- **Timers on the simulation's clock,** once or repeating, which mean the same at any speed and start again when the day is reset.
- **A store of the application's own,** kept across restarts of either side, within limits that are refused rather than silently enforced.
- **Messages between applications,** for those that asked to use them.
- **Atomic batches** of UI changes, so that nothing appears half-updated.
- **Health,** per application: requests, refusals, rate limiting, lease lapses, events waiting and dropped, and what it has declared. It shows on the application's page in Settings.
- **Discovery,** `GET /api/v1/fabric/capabilities`, says what the server offers rather than leaving it to be assumed.
- **New components:** tables, gauges, bars and key and value lists, each drawn in the interface's own shapes.

### Stadiums, a film that explains itself, and a fuller report

- **One look, not one radius.** Bars and controls a line tall are true stadiums, led by the bottom bar, and each is sized to sit concentrically in what holds it. Panels are 26, cards 8 px inside them 18, and so on inwards. Round things sit centred in a stadium's end, and map markers are circles.
- **Lists are one card with divider lines,** rather than a stack of rounded rows, and a row lights up to the card's edge.
- **Scrolling menus end softly.** Content goes under a progressive blur rather than being cut off by a line, and it clears when there is nothing more.
- **Tooltips** lost their pointer and come out of the control they describe. **The tour's outline** now follows the curve of what is actually drawn on each step. The licence disclosure's divider is straight, and the hover on the collapsed telemetry strip follows the strip.
- **Travel demand** is a neighbourhood from above: trips leave the homes, queues grow back from the doors of what draws them, and a column over each roof shows how much it is drawing.
- **Rush hour** is a ridgeline of the day: each line is a road's traffic from midnight to midnight, and a curtain of light raises the two rush hours as it crosses them.
- **Repeatable worlds** says "exact copy" as a mirror. Two seeds fall from opposite sides and meet at a seam of light; a ripple goes out, and a skyline rises with its exact twin rising downwards, window for window and car for car. A second pair of seeds turns both into another city, still alike.
- **WebFabric** shows what it is: an open book with code on one page and the interface on the other. As each coloured line is typed a stream of that colour goes across, and what it declares builds itself in the interface: a route on the map, a gauge, a chart, a notification.
- **The pointer** moves through the particles like a hand through water, rather than punching a hole in them.
- **The particles stay on the roads** as the map moves over for the panels. They stood still before, which looked like a misalignment.
- **The last screen** says "Server Terminated". The name draws in on itself and bursts, with a shock ring going out through the particles and the mint light released with them, then settling.
- **The speed slider tells the truth when ASB holds it back.** The thumb travels to the speed being applied, and a line stays on your target.
- **What only reports moves like what can be moved.** Every read-only bar slides smoothly, and keeps its rounded end as it does.
- **Fixed: a button kept its outline after a keyboard shortcut.** Focus rings now appear only for people moving with Tab.
- **The report no longer stops the interface,** and making one is a single movement. The screen blurs back, a sheet grows out of the button along a curve, the map's roads stream on to it in their own shape to make the cover, the cover turns aside for the panels to make a page, and they close up and return to the button as the file saves. It all follows the worker's real progress.
- **Fixed: a report could silently never arrive.** A button that did nothing for a minute looked frozen. Waiting for an off-page image could hang, and anything that takes too long now says so.
- **The report's cover** is a survey sheet: all of the district inside a frame with nothing cut off, on a grid of real distances, with coordinates, a scale, north and a key counting the roads in each state. Under it stand the name of the place, a ruled title block, and the author's name, copyright and licence.
- **The report's pages** keep a heading with what it introduces, and a block that would mostly land on the next page goes there whole. Tables do not leave one row alone on a page. About and Contents share a page.
- **The report says more:** traffic by road class, the places drawing extra traffic, a Signal Control section, and the map on white in print colours rather than a screenshot of the dark one.
- **The report's file** carries proper metadata: author, title, subject, keywords, language, creation date, bookmarks for every section, and an XMP record of the seed, run, state and versions.

### No words in the particles, a map in the middle, rounder corners

- **The particles only ever spell the name.** Rush hour marks its two peaks with a small caret, and its axis has ticks but no times.
- **Road incidents replaces Run reports** in the film: a collision on a dual carriageway, and the queue growing back up the road from it, while the other side keeps moving. A report is a useful feature, but not what the film is for.
- **The map lands in the middle.** It was centred on the room beside the panels before they had arrived, which left it about 220 px off to the left. Alone on screen it now sits in the middle of the window, within a pixel on a real city, and it moves over as the panels come in. Fit also ignored the header and centred on road junctions alone, so it now takes the free space and the land around the roads into account.
- **Zooming belongs to the person doing it.** Every wheel event zoomed by a fixed 10%, so a little trackpad scroll hit the limit at once, and the map then jumped back to the middle when it stopped. Zoom now follows the size of the gesture. Zooming out draws the map back to the middle as it comes into view, and nothing moves once the gesture has stopped.
- **Fixed: moving the map did not hand back the camera.** Auto Focus's prompt has always said any manual pan or zoom returns control, but it only cancelled the glide then under way, and the next event took the camera again. Panning, zooming or pressing Fit now turns Auto Focus off.
- **A calmer tour.** No more motes circling the spotlight or streaming across the screen. A few drift out and fade as the tour opens a new part of the interface, on 7 of its 32 steps, and the other steps simply glide.
- **Fixed: a note explaining reduced speed could go unseen.** It ranked below any warning, and only lasts a few seconds, so with a warning on screen it came and went without being shown. Only something critical now goes ahead of it. It could also fire falsely for a moment after a change of speed, and then not again on that page when it was true.
- **Fixed:** the last screen could fall back to another typeface, because a font first needed after the server has gone can no longer be fetched.

### Applications on the road, and plain words

- **WebFabric can draw and drive.** A `route` or `path` with `draw_s` draws itself along the road. A `path` with `drive` gets the map's own driving: pulling away, braking, keeping its distance in a convoy of up to 12, brake lights, and waiting at red signals. Sequences of junctions must still be adjacent, or the element is refused.
- **Words, not identifiers.** News and the Queue showed the core's own text, such as `way/137004057`, `Node 524`, `Edge 12`, `entity 4` and `Signal 292 → A amber`. They now name the place or road, and which way the signal serves. Reports do the same.
- **The tour's** arrow keys now work on its last step: right starts the simulation.

### The film's scenes, the title and the end

- **Redesigned scenes.** Mapped streets is now a real-looking district: quarters on their own grids, arteries, a river with bridges, parks and buildings, drawn in order. Signal timing has lanes, stop lines, zebra crossings, three-lamp signals on a proper cycle, queues that release from the front, vehicles turning, tail lights and people crossing. Travel demand uses the map's own icons, with homes sending trips to them and their demand filling up. Rush hour is a stream of traffic through the day that swells at each peak, with no sun. Auto Focus flies over the map to one event and then the next inside a steady viewfinder.
- **The title comes apart** in a sweep, each letter turning to particles as it is reached, then grows into the film.
- **Reloading during a run** now shows the name, then the roads, map and panels in about a second and a half. It used to show nothing and then the dashboard, because the scene restarted on a dead canvas.
- **The end** plays as the arrival backwards: panels first, then the map goes from under its roads and the roads fly into the name.
- **Fixed:** the runtime status flashed Degraded just after a page loaded, and then took ten seconds to clear.

### A world waits for its start-up

- **The simulation does not run on behind the film.** While an observer is showing its start-up, a world that finishes stays at its first second and starts when the panels have arrived. It carries on by itself within 4 seconds if the observer closes or disconnects or its tab is hidden. With no observer, nothing waits, and an observer connecting during a run changes nothing. `POST /api/v1/system/observer` and `observer_hold` in the playback status are new.

### Pulling at the end of a list

- **A pull at the end of a list now answers.** It gave up after two shrinking wheel events, which a real finger produces all the time, so pulling often did nothing and felt unresponsive. The content now comes with the pull, ever less the further it goes, and springs back on release. Momentum still gets one motion, and a pull that carries on after a fast arrival is picked up from where the bounce has reached.

### Start-up film, arrival and traffic

- **Eleven different scenes, moving throughout.** No scene shares a layout now: a city with a river and ring roads, one junction with queues and red and green signals, a skyline rising, stacked bars under a moving sun, a stepping dial, a storm, a globe with continents, two identical trees from two seeds, a viewfinder locking on, and a rippling weave. Colours hold in both themes.
- **The particles build the map.** They gather into the name, fly out and build the roads from the middle outward, the end of a session played backwards. Then the map fades in under them, and the header, sidebar, telemetry and bottom row slide in from their edges. Generating a new world does the same.
- **Fixed: in light mode the map stayed hidden until the end of the handover,** behind a background that never faded.
- **Vehicles on the map drive.** They follow the shape of the road, carry on through junctions instead of vanishing, keep their distance, stop at red signals with brake lights, and fade when the core's counts change. They are drawn every frame while the machine can afford it. They still stand for the core's aggregate figures, not individually tracked vehicles.

### Light and dark, gone through surface by surface

- **All text now meets WCAG AA contrast in both themes.** Light mode had 30 kinds of text below it, because its faint text and its accent, green, amber and red were too pale, especially on their own tints. The Terminate dialog's title was a pale red meant for dark surfaces. Colour-vision palettes keep to the same standard.
- **About's licence card** is one card: its head fills the top when pointed at, instead of a pill inside it, and its text lines up.
- Switches that are on are solid in light mode, Settings content scrolls under a line, and a notification's details read the same in the capsule and the history.

### Scrolling

- **Fixed: lists did not scroll with the pointer on text.** A rule applied to every element told clipped text, which is a scroll container too, not to pass a scroll on. Over a row's title, tag or details the list did not move at all; only its icon and padding scrolled. The rule now applies only to regions that really scroll.
- **The bounce runs off the main thread.** Its whole curve is worked out once and played by the compositor, frame and all, so it stays smooth while the page is busy. It starts just before the limit, so the content no longer stops and waits for it.
- **Fixed: a second bounce after a stall.** Wheel events held up behind a busy page read as a new gesture. They are now timed by when the input happened.
- **The map keeps moving** while something scrolls and while a dialog is open. It used to pause, which there was no longer any need for.
- **Map zoom and pan drop far fewer frames.** The canvas font was set once per place, and each change to a page-wide `:has()` rule restyled the whole interface. Style work during a zoom falls from about 1,400 ms to about 30 ms.
- Removed work nothing used: the scroll fade, whose masks had already gone, measured every list on every scroll and watched every row.

### Map downloads

- **A silent download now fails.** With no new data for 200 seconds (`DSTNS_MAP_STALL_S`), the download stops and says so. It could previously wait about half an hour across mirrors and retries.
- **Mirrors that answer.** `overpass.kumi.systems` was an old name for `overpass.private.coffee`, and `overpass.osm.jp` no longer accepts connections. They are replaced by `maps.mail.ru` and `overpass.openstreetmap.fr`.
- **Faster downloads.** Responses are compressed in transit. A busy mirror is left for the next at once, and a silent one after 10 seconds without a connection or 60 without data, and an error from one mirror no longer ends the attempt. Maps are written and checked as they arrive rather than held in memory.
- **Try another city.** A failed world, at start-up or when regenerating, offers a button that tries a different city. `POST /api/v1/world/regenerate` now also accepts a request after a failed first start. With an observer open, the launcher keeps the server running for this.
- Regenerating a world uses the same screen as starting up: what is happening on the left, its details on the right.

### Finding things, and reading them

- **A place chosen from search is marked on the map:** it flashes three times and stays lit until the map is next touched.
- **Hovering an incident shows its details,** ahead of anything under it, and works whichever of the two incident layers is on.
- **Rows that are cut off open.** Click a row in Stack, News, Queue or Incidents to read all of it.
- **Show important on top,** a new setting that is on by default (`notifications.important_first`). The capsule shows the most important event and counts the rest. Severity now outranks the focused event and system explanations, and the capsule returns to the most important event after being closed.
- **Corners are concentric.** An inner radius is its outer radius less the gap between them, checked in the browser suite.
- The regeneration screen no longer shows the seed.

### Scroll limits behave like a scroll view

- **Edge resistance now follows how scroll views work.** Content carries on past a limit at the speed it arrived, with how far it travels limited by a rubber-band curve, and a critically damped spring brings it home. It used to stop dead and then make a small, unrelated movement. One gesture gets one motion, however unevenly its momentum fades, and the spring acts on the position shown, so the return is one curve. A region's frame now stays still while what is inside it moves.
- **Fixed:** turning reduced motion off replayed the map's arrival, flashing it through a blur.
- The notification history is one surface with one column of details. Settings headings, rows and the title share one left edge. Copying the seed has a new animation. Decimal units read `KB`.

### Generating a new world is one continuous animation

The particles lift off the current map's roads, form the name, blast apart, recollect into the name, and the film carries on, with progress along the bottom, until they land on the new world's roads. There is no title screen. It takes about 11 seconds at its fastest. A failed generation still shows its message with Retry and Return to current world, and the current world is untouched.

### Scrolling redesigned

- **Scrolling is more responsive everywhere.** Under 4× CPU throttle at 10× speed on a Retina-scale window, on the About page, median input delay fell from 92 to 35 ms, the worst case from 203 to 68 ms, and main-thread paint from 766 to 23 ms.
- The status pulse no longer repaints the page on every frame, and the day's progress and the backpressure monitor no longer run per-frame loops.
- Fade masks, custom scrollbars and blur behind panels are gone. Panels are solid and scrims are a plain dim.
- **Fixed: rules removing blur and masks did nothing in Chrome,** including Reduce Transparency. The minifier dropped the standard property when a `-webkit-` version was written beside it. Only the standard property is written now, the prefix is generated, and a test keeps it that way.
- Flow markers wait while anything scrolls or a dialog is open, and rows do not restyle under the pointer during a scroll.
- **The coordinates, scale and OpenStreetMap credit** now sit centred between the notifications and Roads, Places and Layers.
- **Settings:** Keyboard, Applications and Reset are one design with even spacing.

### Scrolling, map performance and the start-up film

- **Scrolling never waits for the page.** Edge resistance used to block every wheel event on the main thread and move every child of a list. It now only listens, and moves the region as a whole with one compositor transform, by at most 12 px. Under 4× CPU throttle at 10× speed, scrolling at a limit went from 42 to 54 fps and map zoom from 52 to 59 fps.
- **The map draws in tiles and layers.** Roads and buildings are grouped by tile and style, what changes with a snapshot is drawn once per snapshot, and only rain, incident pulses and flow markers run per frame. Names and markers follow zoom and importance, within a budget, and names wait until the camera stops.
- **Degraded no longer touches the interface.** It reduces only the map's data and animation. It no longer closes panels, moves the camera or turns off interface motion.
- **Runtime status is steady.** Degraded must hold for 4 seconds and recovery for 10, and ASB waits longer each time a release has to be taken back.
- **The film plays through once,** with "Finishing setup" if the world is ready sooner. After that the screen leaves as soon as the world is ready. Copy no longer implies anything is real or live.
- **Smoother handovers,** from title to particles and from particles to map, and a short particle ending when the server stops.
- **Notifications close without a snap,** and the Auto Focus menu opens as a fluid panel.

### Latest interface round

- **Speed is capped at 10×.** The engine, API and launcher all refuse more.
- **Keyboard shortcuts,** shown and changeable in Settings. A key already in use swaps. Resetting them, or all settings, returns the defaults.
- **Start-up:** the title's logo dissolves into the particle wordmark, the first wait is one second, and all headlines are one or two words. Signals and Auto Focus replace the earlier 86,400, closure and backpressure scenes.
- **The day's progress** is now the sun's path, with a moon after dark.
- **Search** has filters, including Modelled, and scrolls properly. **Places** groups kinds by whether they affect traffic.
- **Roads, Places and Layers** are one connected control. **The telemetry panel** is wider, so `99+` counts fit.
- **About** is redesigned, with GitHub and documentation links and no reset. **The Auto Focus menu** is redesigned.
- **Appearance now defaults to Auto,** following the device. **The launcher** can open with default settings: `--default-settings`, or `launcher.default_settings`.
- **Light mode:** hovering no longer turns controls dark. Edge resistance returns within about 150 ms.

### Latest changes to start-up, backpressure and the tray

- **The map no longer empties under backpressure.** ASB's reset used to turn off every layer but signals. Roads and
  buildings now stay, and detail returns as soon as the interface is back in sync.
- **Speed reductions are explicit.** The slider keeps its thumb on your target and marks the speed applied, and the bar reads
  for example `ASB 5×/10×`.
- **Intentional system design** notes are now notifications in the tray, which Do Not Disturb does not silence.
- **The opening:** a still title first, then the film, with stages paced so a fast start can still be seen. The launcher
  waits 4.5 seconds after the observer loads before requesting a world. Five new scenes, including words in 3D particles, and
  shorter captions.
- **The minimum window is now 1280 × 640,** so the whole bottom bar fits with its labels.
- **Notifications stop when the day ends.** The tutorial covers WebFabric, and the Apps tab is always present.
- **The launcher** no longer reports a server it can see running as gone because it missed some polls.
- The completion dialog is redesigned, edge resistance returns faster, the tutorial outlines the runtime status as it is,
  and OpenStreetMap attribution sits with the coordinates and scale.

### Fixed: seeds that could never start

- A seed whose coordinates fell on an isolated pocket of road failed with "mostly water or unmapped", even inside
  a dense city such as Singapore. The district now grows from the nearest road belonging to a network large
  enough. Those seeds now run; **results for every seed that already worked are unchanged**.
- The launcher no longer advises checking the network when a map downloaded correctly but cannot be used, and the
  observer no longer says such a failure clears by itself.

### Added in the latest interface round

- **Start-up film.** A WebGL2 particle scene re-forms into the wordmark, streets, a city, traffic, weather, a
  world of seeds and the WebFabric weave, with captions. Stage progress runs along the bottom. When the map is
  ready, the particles fly to its real roads and give way to it.
- **`ISDHandler`** (Intentional System Design Handler). A notification when the system does something on purpose
  that looks like a fault: Async, Restricted, a held or reduced speed, held reduced motion, a window that is too
  small, stepped movement above 5×, and an application that stopped checking in.
- **WebFabric on the road network.** Overlay features `marker` (on a node), `entity` (on an edge) and `route`, and
  an animated `path` over adjacent nodes with loop, bounce, speed, dwell, delay, spring and reveal options. New
  refusal: `422 NOT_ON_NETWORK`. New widgets: `route` and `sparkline`.
- **WebFabric on the collapsed telemetry strip**, opening the panel where applications show their content.

### Changed in the latest interface round

- **Bottom bar:** a flexible 24-hour timeline with a playhead replaces the top progress line, and the bar is 56 px tall.
- **Live Telemetry:** figures are one compact row, leaving more room for the detail below.
- **Places** is now the same panel as **Layers**, opening above the bar. Both have labelled icon actions.
- **WebFabric settings** are redesigned, with waiting applications first and permissions grouped by what they need.
- **The tutorial** matches the interface, is grouped by chapter, and its text is rewritten.
- **Settings:** colour vision options explain what each means and preview their colours. Data units read
  `kB, MB, GB` or `KiB, MiB, GiB`.
- **Curvature** is one scale across the interface, enforced by a test.
- **The reduced motion icon** moves continuously between its wave and flat states.

### Fixed in the latest interface round

- A closed notification was pushed out of its box by its body's padding.
- Technical details in a notification now open as the card does, and hovering them no longer looks wrong.
- Edge resistance paused after scrolling, since it waited for trackpad momentum to end. It now returns at once.
- The clock's second line left its box on hover.
- The location in the header was not centred on the header's line.
- Opening the WebFabric panel from the collapsed strip would have thrown, because its heading looked up an icon that
  was not there.
- `browser-webfabric.mjs` failed on a second run, because it inherited the registrations of the first.

**Results change for some seeds.** A signal whose compiled offset rounded up to a
whole cycle made the engine read past the end of that signal's phase table (found
with AddressSanitizer). The offset now wraps to the start of the cycle. Seeds
without such a signal are unchanged, and no scenario hash changes, because the
compiled offsets themselves are untouched; but a run that hit the over-read
behaved according to whatever memory followed the table, so its results were
undefined before and differ now.

### Added

- **Accessibility settings**: light mode; colour-vision palettes for protanopia, deuteranopia,
  tritanopia and monochrome; reduce transparency; and an advanced mode which, off, removes
  demand multipliers, radii, identifiers and technical details.
- **Dynamic Edge Resistance**: past any limit, content gives ever less then settles home, on the
  curve Apple's scroll views use, in every scrolling region, the sliders and map panning. The page
  itself never scrolls.
- Settings and search grow from the dock like a drop, and stay open while the map is used. Search
  offers popular places in the district and ranks live results.
- A section of the telemetry deck for WebFabric applications, and notifications marked as theirs.
  Elements choose how they arrive from provided motions, or a spring within the guidelines.
- Applications can name their own bus stops and read the demand a stop there would see, by the model
  real stops use. `Fabric/examples/bus_planner.py` is a whole product built on Fabric: it plans lines along
  real roads, draws them and runs buses along them.
- Fine control for Back and Forward, asking how far on each press. Data sizes in MB by default, or MiB.
- Zooming out is limited to 5% past fit, with resistance to a hard 10%.
- A speed slider with stops from 0.25× to 20×, including new 10× and 20× rates, that settles with
  the momentum of the gesture.
- Badges for states such as Realistic News not being supported on this device, an uninstalled SUMO,
  speed or motion held by backpressure, and applications waiting for permission.
- An interactive start-up screen: a street network on springs that responds to the pointer and
  lights up with the real stages, with elapsed time and facts during a long wait.
- WebFabric sidebar: room beside the map for an application such as a bus planner, with tabs, lists,
  statistics, legends and inputs, numbered series colours, overlay points that glide, map picking, and
  a state poll that sends only what changed.
- **Fabric**: the HTTP API as its own library in `Fabric/`, one module per API group,
  with a recorded contract test. See [Fabric](https://dstns.readthedocs.io/components/fabric/).
- **WebFabric**: independent applications in the observer. An application registers
  itself through `/api/v1/fabric/apps`, and declares status lines, header items, dock
  controls, edge indicators, map overlays, panels, dialogs and settings as data.
  Identity, grants and settings persist; a page of its own runs in a sandboxed frame;
  control of the simulation needs a capability a person grants, and is recorded. See
  [WebFabric](https://dstns.readthedocs.io/components/webfabric/) and
  [Building applications](https://dstns.readthedocs.io/development/webfabric-apps/).
- **Settings → Applications → WebFabric**: search, per-application settings drawn from a
  schema, permissions, suspend, resume and forget.
- A Fabric and a WebFabric logo in About, and a black and white favicon set in
  `docs/assets/brand/favicons/`.
- Failure and shutdown screens. Nothing loading, or a terminated server, now says so in
  full rather than as a small error or a connection that never returns.
- The map coasts when thrown, zooms smoothly about the pointer, and its camera redirects
  in flight. The settings drawer can be dragged shut.

- Natural-language narration of news. Incidents, storms, floods and surges are
  worded in plain language by Apple's on-device Foundation Model through `fm
  serve`, started and stopped by the server where `fm` is installed, or by any
  OpenAI-style Chat Completions endpoint (`--narrator`, `--narrator-model`,
  `--narrator-cache`, `DSTNS_NARRATOR*`). Presentation only: the model sees facts
  after the simulation has fixed them, its sentences are checked against those
  facts (invented numbers, injuries, speculation and advice are refused), and the
  simulation never reads them; runs are byte-identical with it on or off.
  Scheduled incidents and storms are narrated ahead of time at install; narrations
  are cached by their facts in memory and in SQLite, so seeks, replays and
  restarts reuse them. News items gain an optional `narrative`; `/api/v1/news`
  gains the `since_narration` cursor with `narrated` and `narration_sequence`;
  `GET /api/v1/system/narrator` reports the model, queue and cache. The observer
  shows narrations as notification summaries and keeps the core's text under the
  technical details.
- `dstns_benchmark` measures the system under increasing load: district size,
  storms and incidents, concurrent observers, and the narrator (with `--narrator`,
  a real model end to end). `--json` writes every figure with the machine and build.
- `DSTNS_TUNE_FOR_HOST` CMake option for `-mcpu=native` builds.
- The launcher chooses narration before it starts a server: `--narrator`, or
  `narration.mode` in `config/defaults.json` (default `auto`). It checks for the
  `fm` command, `fm available` and Apple's terms (or that an endpoint answers),
  and when narration is unavailable or unsupported starts the server with it off,
  keeps the default wording, and says why and how to fix it. After the run starts
  it reports what the server's narrator actually did. A **Narration** environment
  check shows the same decision.

- Realistic News. The observer's **Settings → News** switches between Realistic
  News, written by the on-device model like a local traffic report, and Standard,
  predefined wordings that vary from event to event (`news.style` in
  `config/ui-config.json`). Realistic News is written from the event and its
  context - the city, road, district, hour, day type, named places nearby, the
  weather at the time, earlier incidents that day - may add plausible colour but
  not contradict the facts, invent numbers or mention deaths, and now also covers
  the busiest hours at named schools, hospitals, shopping centres and stations.
  It is the observer's alone: `/api/v1/news` serves narratives only with
  `narration=realistic`, and snapshots never do. Notifications written this way
  are marked **Realistic News**.
- The launcher reports Apple Foundation Models as **Available**, **Unavailable** or
  **Disabled**, in start-up messages and as an environment check.

### Changed

- The engine and core features moved to `Core/`, and the server entry point to
  `Core/server/`. Build targets and flags are unchanged.
- The command rail and the bar above it share their edges. The rail shows all speeds on a labelled
  slider, with a full-width progress line. The top bar, the Layers, Places and Roads menus, dropdowns and
  the hover card are redrawn; the hover card now describes the place you point at. Surfaces are solid
  rather than frosted, and per-frame updates no longer re-render the interface, which removes most of
  the lag. Light mode is designed in its own right, and the boot screen uses the full logo.
- The lower HUD is one quiet row, with coordinates and scale as a caption on the map. Settings are
  grouped, with more room. About explains Fabric and WebFabric. The end-of-day dialog is redrawn, with
  figures that count up. Icons move on hover and selection, and their centres match their hover areas.
- Rain cells, the map fit and zoom, the progress ring and collapse and expand all move on springs. The
  interface arrives around the map in a stagger, and the map quietens when the day ends.
- Do Not Disturb stops new notifications without removing one already on screen. An open notification
  shows its full text and stays still: newer events wait behind a count.
- All motion is one spring model. Dialogs and popovers enter through interruptible
  transitions, so they reverse from wherever they have got to.
- Start-up is one surface naming the real stage. The Welcome hold and staged delays are
  gone, and the interface polls faster until a map exists: 3.3 s to 1.55 s from starting
  a run to interactive, in Chrome on the bundled map. Idle no longer shows a spinner.
- Text in Settings no longer competes with the map behind it. Switches, segmented
  controls and text buttons meet the 24 px target minimum.
- The observer's page is served with a Content Security Policy.

- The topology response is built once per world and served from a cache: about
  0.1 ms instead of 87 ms for a 2,500-junction grid, without rebuilding it under
  the engine lock.
- Snapshots copy the dynamic state under the engine lock and build their JSON
  after releasing it, in parallel slices on several cores for large networks.
- The engine catches up on the clock in slices of about 20 ms, releasing its lock
  between them, so a snapshot, pause or seek waits for one slice instead of the
  whole catch-up. The ticks and their order are unchanged.
- A physics tick is about 22% faster: storms and surges are shaped once per tick
  instead of per junction or edge, per-edge signal groups and traversable
  directions are fixed at install, and the hot loops index state directly.
  Results are bit-identical.
- On Apple silicon the physics clock runs at interactive quality of service (the
  performance cores) and narration at utility (the efficiency cores).

### Fixed

- A signal's phase walk no longer reads past its phase table (see above).
- The launcher no longer floods the terminal with logging tracebacks, or fails to
  install its terminal interface, in a checkout synced by OneDrive, iCloud Drive or
  Dropbox. Its log and private environment are kept on local disk there
  (`~/Library/Logs/DSTNS`, `~/Library/Caches/DSTNS`; `DSTNS_LAUNCHER_VENV` overrides),
  a log that cannot be written goes quiet instead of raising, and the **Workspace**
  check warns when the server's runtime files have been evicted to the cloud.
- The simulation core would not build or start from a checkout synced by OneDrive,
  iCloud Drive or Dropbox: CMake could not create its files in `build/`, and the
  server's logs and the observer were read from evicted files. In a synced
  checkout the launcher now builds the core and the observer, caches maps, and
  keeps the server's logs on local disk (`DSTNS_BUILD_DIR`, `DSTNS_LOGS_DIR`
  override; the server reads the observer's location from `DSTNS_UI_DIST`), and
  keeps Python's bytecode there too.
- An observer that cannot be built (Node.js missing or no longer starting) no
  longer stops the simulation from starting; the launcher names the cause and the
  fix, and serves the previous build if there is one.
- `./launcher start` without a terminal no longer hangs on SIGTERM: it waited on
  the server holding a lock its own signal handler needed.
- The server's model watchdog no longer leaves `fm serve` running when DSTNS has
  exited but not yet been reaped.

- GHCR publishing now builds and tests native Linux AMD64 and ARM64 images,
  then verifies the multi-platform manifest before promoting stable tags.
- Compose pulls `ghcr.io/varunkarthic/dstns:stable` by default; use the explicit
  `docker-compose.build.yml` override for local or optional SUMO builds.

### Added

- Stable/latest, branch, short/full SHA and semantic-version release tags;
  OCI developer attribution for Varun Karthic, SBOM and build provenance.
- Packaged build manifest, licence and copyright; revision, timestamp, channel
  and architecture in CLI/API build information. Engine version stays 2.1.0.
- Container gates for health, offline simulation, observer assets, metadata,
  non-root execution, run replacement and shutdown. Direct GHCR pull/run docs.

## [2.1.0] - 2026-10-02

Engine 2.1.0 and observer 2.3.0, API contract 1.0. The first public release.

**Results change for some maps.** Maps containing untagged roundabouts produce a
different graph in this release, because those roundabouts are now one-way as
OpenStreetMap requires. Their `graph_hash`, `scenario_hash` and simulation results
differ from 2.0.0. Maps without untagged roundabouts, including the bundled fixtures,
are unchanged.

### Security

- **The server binds to `127.0.0.1` by default.** `dstns_server`,
  `config/defaults.json` and the Docker Compose port mapping previously
  exposed the API on every interface. Set `--host`, `api.host` or
  `DSTNS_BIND=0.0.0.0` to expose it deliberately. The container still listens on
  `0.0.0.0` internally behind the loopback mapping.
- **DNS rebinding is refused.** When bound to loopback, requests whose `Host`
  header is not `localhost`, a `*.localhost` name or an IP literal receive HTTP
  421 `HOST_NOT_ALLOWED`. `DSTNS_ALLOWED_HOSTS` admits additional names.
- **CORS is no longer granted to every origin.** `Access-Control-Allow-Origin: *`
  let any web page read a local server's run state. The header is now sent only
  for the server's own origin and `DSTNS_ALLOWED_ORIGINS`.
- **Cross-site request forgery.** State-changing requests carrying a browser
  `Origin` other than the server's own are refused with 403
  `CROSS_ORIGIN_FORBIDDEN`. `GET /terminate` and `GET /api/v1/system/terminate`
  were removed; shutdown is `POST` only.
- **Command injection** through the SUMO export directory is closed: every
  argument passed to a shell is quoted.
- Integer wrap-around in path IDs, times, query numbers and undo or redo counts
  is refused with HTTP 400 instead of acting on the wrong object.
- Log messages are flattened to one line, so a request path cannot forge entries.
- Published a [security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md) and added CodeQL analysis.

### Added

- **Public release.** DSTNS is released for public use under the AGPL. It is
  developed independently and does not take outside contributions, bug reports or
  feature requests.
- **Licence headers.** Every source file carries an SPDX identifier and copyright line;
  `scripts/license-headers.py --check` runs in CI. `COPYRIGHT` and the licence page
  explain how the licence is applied.
- **Docker, supported.** A multi-architecture image (234 MB) with the engine, the
  observer, the map downloader and an offline district; auto-start configured by
  `DSTNS_*` variables; `dstns-run` for starting runs; an optional TLS gateway as a
  Compose profile; optional SUMO.
- **Documentation site** on Read the Docs: getting started and system requirements,
  a user guide, concepts with the model's equations and assumptions, an API
  reference with an OpenAPI explorer, deployment, upgrading and security guides,
  troubleshooting, an FAQ, known limitations, reference tables, design decisions and
  the quality assurance record.
- Continuous integration on GitHub Actions for the native, HTTP, observer,
  documentation and container builds.
- CodeQL static analysis of the C++, JavaScript and TypeScript, Python and workflow code.
- `tests/api/hardening_smoke.py`, covering origin and host checks, CORS, input
  validation and shutdown against a real server.

### Changed

- The CLI's `playback.tick_rate` and `--speed` bound is 5, matching the engine
  (it was 10).
- `dstns_replay_verify` accepts decimal seeds and `--help`.
- Building no longer links OpenSSL or zstd opportunistically; the engine needs
  neither.

### Fixed

- **Southern-hemisphere cities could never be downloaded** on Python before 3.13
  (Debian, Ubuntu, the container): the bounding box's leading minus sign was
  parsed as an option. 25 of 181 cities, about one seed in seven, were affected.
- Exported SUMO bus stops were rejected by SUMO (`Invalid position for busStop`),
  failing every SUMO run on a real map. SUMO release versions were misreported.
- Undoing a signal toggle did nothing.
- Seeking backwards erased operator road overrides; seeking to 24:00:00 did not
  complete the day.
- Surge and weather parameters were unbounded and could overflow.
- **Results change for maps with untagged roundabouts**, which are now one-way as
  OpenStreetMap convention requires, and `shop=mall` nodes are malls, not stores.
- SUMO was reported available when it could not start; failed SUMO runs reported
  success; SUMO runs held the engine lock and froze the API.
- Dialogs slid under the header, hiding the About logo, and dialogs opened from
  the completion screen vanished after 180 ms.
- `--port 70000` wrapped to 4464; stale `.progress` files accumulated in the map
  cache.
- The observer reports the HTTP status of an error that has no JSON body.
- Saving a seed whose city is chosen by the seed (`--save-seed` without
  `--osm-file`) failed with `No such file or directory`. Such saved seeds now
  record the seed and selection version, and replay through the map cache.
- `global_view.json` and the shutdown response reported an outdated product name,
  and `global_view.json` an outdated version.
- The observer dependency DOMPurify was updated from 3.4.15 to 3.4.16
  ([#1](https://github.com/varunkarthic/DSTNS/pull/1)).

### Removed

- The separate UI container and its unused in-memory overlay service, the second
  Compose file, the retired static design mock-up and generated SUMO outputs. The
  original design specifications are published under
  [Design specifications](https://dstns.readthedocs.io/design/).

## [2.0.0] - 2026-09-20

Engine 2.0.0 and observer 2.2.0.

### Added

- **Seed-selected real places:** a catalogue of 181 cities, on-demand
  OpenStreetMap downloads, CRFG district growth and a true-metre projection.
- Raw numeric seeds end to end, saved seeds, and UTF-8 safety for untrusted map
  text.
- Adaptive Simulation Backpressure (ASB) keeping the observer in step.
- Realistic signals: controllers snapped to junctions, green waves and
  demand-proportional splits.
- Place-aware demand with explainable couplings, and realistic bus-stop spacing.
- The observer: command rail, world regeneration, time-travel controls, settings,
  Do Not Disturb, Auto Focus, notification history, telemetry collapse, place
  legend, guided tutorial, PDF report, a finished-run screen and a UI-first
  start-up.
- The operator CLI: an interactive console, start-up verification, saved seeds,
  test runner and log inspector.
- Deterministic incident subsystem (at least four a day) and standardised
  weather (DWS).
- AGPL-3.0-or-later licensing with a network source offer.

## [1.0.0] - 2026-09-07

The first deterministic vertical slice: seeded scenario compilation from a
synthetic grid or OSM XML, the aggregate traffic model, checkpoint replay, the
HTTP API, the SUMO export and the first observer.

[Unreleased]: https://github.com/varunkarthic/DSTNS/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/varunkarthic/DSTNS/releases/tag/v3.0.0
[2.1.0]: https://github.com/varunkarthic/DSTNS/commits/main
[2.0.0]: https://github.com/varunkarthic/DSTNS/commits/main
[1.0.0]: https://github.com/varunkarthic/DSTNS/commits/main
