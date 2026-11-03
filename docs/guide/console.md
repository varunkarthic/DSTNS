# The console

The launcher reads command lines as a Unix shell does. The same lines work in four places:

| Where | How |
|---|---|
| **The command bar**, at the foot of every page of the terminal interface | `:` or `/`, then type |
| **One line**, from any shell | `./launcher -c 'LINE'` |
| **Lines until `exit`**, from a terminal or a script | `./launcher shell` |
| **One command on its own**, piped by your own shell | `./launcher ps \| grep server` |

```bash
./launcher -c 'logs api | grep 500 | wc -l'          # how many requests failed
./launcher -c 'stop && start --seed 42 --no-open'    # restart on another seed
./launcher -c 'ps | grep -q running || start'        # start only if nothing is running
./launcher ls config/startup                         # every startup setting, as text
./launcher get api.port                              # one setting's value
printf 'ps\nuptime\n' | ./launcher shell             # a script of lines
```

## Joining commands

| Operator | Means |
|---|---|
| `A \| B` | `B` reads what `A` wrote |
| `A && B` | `B` runs if `A` succeeded |
| `A \|\| B` | `B` runs if `A` failed |
| `A ; B` | `B` runs whatever happened |

Operators inside quotes are text: `grep 'a|b'` looks for `a|b`. Words are split as a shell
splits them, with `'…'` and `"…"` keeping spaces, and `\` escaping inside double quotes.
A line's exit status is its last command's. A line that cannot be read (an unclosed quote)
exits with 2, and a command that does not exist with 127, as in a shell. `grep` that finds
nothing fails, so `grep -q x && …` reads as it should.

## Commands that run in the console

These run in the launcher itself, read its state, and print plain text:

| Command | Prints |
|---|---|
| `ls [PLACE]` | What is here. `ls` the pages; `ls apps`, `ls seeds`, `ls logs`; `ls config` the categories and `ls config/startup` a category's settings and values |
| `cat logs/SOURCE`, `cat config/KEY`, `cat FILE` | A log (`system`, `api`, `event`, `playback`), a setting, or a file. With nothing named, what was piped to it |
| `tail [-n N] [logs/SOURCE]`, `head [-n N] …` | The last or first lines of a log, or of their input. `tail -20` works too |
| `ps` | The server (its pid, from the server itself), its port and state, and the simulation's clock and seed |
| `get KEY` | A setting's value, as the Configuration page shows it |
| `env` | The `DSTNS_` variables in use |
| `uptime` | How long the server has been up, its state and clock, and its peak memory |
| `about` | Version, copyright, licence and map-data attribution |
| `docs [TOPIC]` | Opens the documentation (in a terminal) and prints its address. Topics: `launcher`, `console`, `mcp`, `fastboot`, `api`, `endpoints`, `config`, `apps`, `testing`, `troubleshooting` |
| `echo WORDS`, `true`, `false`, `help` | As in a shell; `help` lists every command |

And these filter what is piped to them:

| Filter | Does |
|---|---|
| `grep [-i] [-v] [-c] PATTERN` | Lines that match a regular expression; `-i` ignores case, `-v` inverts, `-c` counts |
| `head [-n N]`, `tail [-n N]` | The first or last N lines (10 by default) |
| `wc [-l]` | Lines, words and characters; `-l` lines only |
| `sort [-r] [-n]` | Sorted; `-r` reversed, `-n` by the leading number |
| `uniq [-c]` | Repeated adjacent lines once; `-c` with their count |
| `cut -d DELIM -f N[,N]` | Fields of each line (tab-separated by default) |
| `tee FILE` | Its input, also written to a file |

## Everything else

Every other command is one of the launcher's own (`start`, `stop`, `apps list`,
`fastboot status`, `test unit`, `mcp tools`…, the whole [command list](operator-cli.md#commands)),
run as a process of its own with `NO_COLOR=1` and its output captured, so that it pipes like
any other:

```bash
./launcher -c 'apps list | grep -c org.example'
./launcher -c 'test unit | tail -5'
./launcher -c 'fastboot status | grep cities'
```

## In the command bar

The command bar adds what only makes sense inside the interface:

| Command | Does |
|---|---|
| `cd PLACE` | Go to a page: `config`, `apps`, `seeds`, `logs`, `diagnostics`, `tests`, `tools`, `about`, `running`, `start`, `demo`, `setup`. `cd config/performance` goes to a section; `cd ..`, `cd /` or `cd ~` back to the dashboard |
| `pwd` | Where you are |
| `kill APP \| server` | Stop an application this launcher started, or the server |
| `start …`, `pause`, `resume`, `restart`, `open` | Start a run on the running page, control it, open the observer |
| `set KEY VALUE` (or `KEY=VALUE`), `config` | Change a setting, or open the Configuration page |
| `setup`, `reset` | The setup again; reset runtime data, after a confirmation |
| `history`, `clear`, `man COMMAND`, `exit` | The commands typed so far, clear the output, how to use a command, leave |

As you type, suggestions appear above the prompt with what each does, and the rest of the
first is shown dimmed. **Tab** takes it, **↑ ↓** walk the suggestions while typing and
the history otherwise, **Enter** runs, **Ctrl+C** stops a running command, **PgUp/PgDn**
scroll the output, **Ctrl+L** clears it, and **Esc** closes. The history is kept between
sessions in `logs/command-history` (the last 500 lines). A line with an operator in it runs
as `dstns-launcher -c`, so a long pipeline never holds up the interface, and its output
streams into its own block:

```text
 OUTPUT ─────────────────────────────────────────────────────────────────────────
❯ logs api | grep 500 | wc -l  ✓
  3
❯ frobnicate  ✗ 127
  frobnicate: command not found. help lists them, and Tab completes.
 ─────────────────────────────────────────────────────────────────────────────────
 dstns ~ ❯                                   ● :8090 running · 08:12:44 · cpu 12% · mem 214M
```

The readings at the right of the prompt are the server's, refreshed every two seconds off
the interface's thread: its port and state, the simulated clock, the share of a processor
it used since the last reading, and its peak memory, from `GET /api/v1/system/info`.
