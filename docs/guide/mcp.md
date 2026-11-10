# MCP Handler

The MCP Handler lets an AI client call DSTNS through the
[Model Context Protocol](https://modelcontextprotocol.io). Every route the running server
lists becomes a tool, as do a generic request and a few of the launcher's own operations.

No agent is included. The handler is the door, for a client you choose to come through, and
it is **closed by default**.

## Turning it on

| Setting | Label | Default | Allows |
|---|---|---|---|
| `mcp.enabled` | MCP Handler | off | A client may connect, list tools, and call the routes that only read (`GET`) |
| `mcp.allow_writes` | AI may change things | off | …and call routes that change the simulation (`POST`, `PUT`, `DELETE`) |
| `mcp.allow_launcher` | AI may start and stop runs | off | …and start and stop simulations, and change settings, through the launcher |

```bash
./launcher config set mcp.enabled on
./launcher config set mcp.allow_writes on      # only if the client should change things
```

Either permission turns the handler on, and turning the handler off turns both off. The
setup's **MCP** step asks the same.

With [Advanced Security](operator-cli.md#advanced-security) on, a client can still read, but
it is offered no launcher tool that changes anything, whatever `mcp.allow_launcher` says, and
of the routes it may change only Fabric's applications (`/api/v1/fabric/apps/…`), as
`mcp.allow_writes` allows. Nothing it does reaches the launcher or the engine.

## Connecting a client

The client starts the handler itself, over standard input and output.
`./launcher mcp client-config` prints what to add to its configuration:

```json
{
  "mcpServers": {
    "dstns": {
      "command": "/path/to/DSTNS/launcher",
      "args": ["mcp", "serve"]
    }
  }
}
```

| Command | Does |
|---|---|
| `./launcher mcp serve` | Speak MCP over stdio, for a client to start. Refuses unless `mcp.enabled` is on |
| `./launcher mcp tools` | The tools a client would be offered now, and which only read |
| `./launcher mcp client-config` | The configuration above, with this checkout's path |

## What a client is offered

```text
$ ./launcher mcp tools
 MCP Handler: on, reading only
 Tool                         Kind   What it does
 launcher_status              reads  Whether a DSTNS server is running, and what its simulation is doing.
 launcher_config_get          reads  Read the launcher's settings: one, by key, or all of them.
 launcher_seeds_list          reads  The saved seeds: named, complete run configurations.
 launcher_apps_list           reads  The applications this launcher can start alongside a simulation.
 dstns_request                reads  Call any DSTNS API route on the running server.
 get_api_v1_playback_status   reads  The run's lifecycle, clock and modules
 get_api_v1_view_traffic      reads  Vehicles, speeds and halting on every road
 …
```

| Tool | Kind | What it does |
|---|---|---|
| One per route in `GET /api/v1/system/endpoints` | reads, or changes | Named for its method and path (`post_api_v1_control_events_weather`), described by the index, with the path's `{id}` parameters and a JSON body as arguments |
| `dstns_request` | reads (writes when allowed) | Any route by method and path, for what the index does not list |
| `launcher_status` | reads | Whether a server is running, its port and lifecycle, the seed and clock, the observer's address |
| `launcher_config_get` | reads | One setting, or all of them |
| `launcher_seeds_list`, `launcher_apps_list` | reads | Saved seeds; the application catalogue |
| `launcher_suggest` | reads | A request in plain words as a line of console commands, from the launcher's own model, checked as the command bar checks it. Nothing is run |
| `dstns_ask` | reads | A question about DSTNS in plain words (what it does, what it needs, how to use a feature, how to fix a problem), answered in Markdown from its documentation, and its code for questions about code, with the sources cited and who wrote it. Pass `conversation` from an answer to ask a follow-up. It only informs: nothing is run or changed. Off with `assist.enabled` |
| `graph_ask` | reads | A question about the code in plain words, answered from the [knowledge graph](operator-cli.md#the-knowledge-graph) with no model: *who calls physics_step*, *what does next_world.cpp import*, *functions in the launcher that save settings*. Each result has its file, line and GitHub link |
| `graph_show`, `graph_relations`, `graph_path` | reads | One node and everything round it; its callers, callees, dependencies, users or members; the chain between two |
| `launcher_start` | changes (with `mcp.allow_launcher`) | Start a simulation, with a seed, day type, speed and map |
| `launcher_stop` | changes (with `mcp.allow_launcher`) | Stop the server and the applications this launcher started |
| `launcher_config_set` | changes (with `mcp.allow_launcher` and `mcp.allow_writes`) | Change a setting, with the same validation and [rules](operator-cli.md#settings-that-go-together) as `config set` |

Tools that change things are listed only once they are allowed, and each tool carries MCP's
annotations (`readOnlyHint`, `destructiveHint`), so a client can ask a person before calling
one. With no server running, only the launcher's tools are offered: the routes' tools come
from the server's endpoint index.

## The protocol

| | |
|---|---|
| Transport | JSON-RPC 2.0, one message per line, over the standard input and output of `./launcher mcp serve` |
| Protocol versions | `2025-06-18`, `2025-03-26` and `2024-11-05`: the client's, if it is one of these, else the newest |
| Methods | `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call` |
| Results | A route's JSON reply as text content; an error from the server, or a refused change, as `isError` with the reason |

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_api_v1_playback_status","arguments":{}}}
```

## Security

The client acts with the **operator's credential**, as the launcher itself does: it can do
whatever the settings allow, on any route, without being asked. That is why changes are off
until a person turns them on. Every call is written to the launcher's log
(`logs/launcher.log`) with its tool and outcome, never its credential. The handler talks only
to the server on this machine, and nothing about it listens on a port.

## Extending it

A tool is a name, a description, a JSON Schema for its arguments, whether it only reads, and
what it does. To add one, add a `Tool` to `launcher_tools` in `LaunchKit/src/modules/mcp.rs`.
A new route needs nothing: once it is in the server's endpoint index, it is a tool.
