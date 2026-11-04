# The daemons

Small watchers run inside the server, each on a thread of its own, from the server's start
to its end. They say what they notice in three places: the launcher (in its log, and as a
toast for a warning or worse), the observer (as a notification from System), and two queues
any program can read.

| Daemon | Watches | Says |
|---|---|---|
| `rcs` | The **Resource Control Subsystem**: each module's memory and processor, against its α, β and γ | Below α: that something may be off. Over β: a warning. Over γ: an alert |
| `memory` | The machine's available memory | Low: a warning. Critically low: an emergency |
| `disk` | Free space where the logs and the maps are kept | Low: a warning, and the cache handler clears what it can. Critically low: an emergency |
| `stall` | A run that should be running, whose clock has stopped | A warning, and again once it moves |
| `cache` | The **auto cache handler**: the map cache and what is left in it | That it cleared something, and how much |

Nothing is said until its condition has held for its **sustain time** (`daemon.sustain_s`, 5
seconds unless an alert sets its own), so that a brief spike is not an alarm. Each says once
when a condition begins, and once when it is over.

## The Resource Control Subsystem

Each module has three lines for its memory (MiB) and three for its processor (percent of one
core):

| Line | Means | Below or over it |
|---|---|---|
| α, alpha | The least it should use while it works | Below α, the lowest kind of message: *something feels off, is it working properly?* |
| β, beta | Where it is using a lot | Over β, a warning |
| γ, gamma | The most it should ever use | Over γ, an alert, on the emergency queue |

| Module | What it is | Found by |
|---|---|---|
| `engine` | The server itself | The server |
| `downloads` | The map downloads, while they run | The server |
| `launcher` | The launcher that started the server | The launcher reports it |
| `applications` | The applications the launcher started, together, each with its whole process group | The launcher reports them |

The processor's α counts only while a run is running: an engine at rest uses nothing, and
that is not wrong.

```bash
./launcher set rcs.engine.memory "4, 2048, 4096"     # α, β, γ in MiB
./launcher set rcs.engine.cpu "0.2, 180, 380"        # α, β, γ as a percentage of one core
./launcher daemon show rcs                            # what each module uses now, and its state
```

## The auto cache handler

Every `cache.interval_min` minutes, and at once when disk space runs low, it clears what
nothing needs:

| It removes | It never removes |
|---|---|
| Cities beyond the cache's budget (`cache.max_mib`), least recently written first | The running world's city |
| Downloads abandoned for more than half an hour, while nothing is downloading | Dynamic Fastboot's next city |
| Sidecar manifests whose city has gone, and stray temporary files | A download that may still be going, or Fast Boot's own cities |

## The queues

| Queue | Holds | Keeps |
|---|---|---|
| **daemonEmergencyQueue** | Alerts and emergencies: what every application should act on at once | The last 200 |
| **daemonNotificationQueue** | Warnings, and what is worth knowing | The last 500 |

Anyone may ask `GET /api/v1/daemon`, without a token, whether the daemons are on, which run,
and how long each queue is. While they are on, an application should **subscribe** to the
emergency queue, which is simply reading it: anyone who has read a queue in the last minute
is listed as its subscriber. An application reads with its own token and says who it is:

```python
since = 0
while True:
    read = get(f"/api/v1/daemon/emergency-queue?app=org.example.planner&since={since}&wait=25", token)["data"]
    for message in read["items"]:
        act_on(message)                      # message["id"], ["level"], ["title"], ["text"], ["data"]
        post(f"/api/v1/daemon/emergency-queue/{message['sequence']}/ack?app=org.example.planner", {}, token)
    since = read["latest_sequence"]
```

`wait` holds the request open for up to 25 seconds until something arrives. The observer and
the operator read the same queues; see [the endpoints](../api/endpoints.md#daemons).

## What they can say

Every message is one of the templates in `Daemon/messages.json`, the enum the daemons and
their readers share: an id (`rcs.over_gamma`), a level (`info`, `warning`, `alert`,
`emergency`), and a title and text whose `{names}` are filled in from the message's data.
`GET /api/v1/daemon/messages` returns them.

The alerts raised by a reading crossing a line are in `config/daemon-alerts.json`, one per
line: which daemon, which reading, `below` or `above` what, which message, which message when
it is over, and how long it must hold. Change them there; the server reads the file as it
starts, and has the same alerts built in if the file is missing.

```json
{ "daemon": "memory", "reading": "available_percent", "below": 5, "message": "memory.critical", "recovered": "memory.recovered", "sustain_s": 2 }
```

## Turning them on and off

| Setting | Default | What it does |
|---|---|---|
| `daemon.enabled` | on | All of them |
| `daemon.rcs`, `daemon.memory`, `daemon.disk`, `daemon.stall`, `daemon.cache` | on | One each |
| `daemon.sustain_s` | 5 | How long a condition holds before anything is said |
| `cache.max_mib`, `cache.interval_min` | 2048, 10 | The map cache's budget, and how often the handler looks |
| `rcs.MODULE.memory`, `rcs.MODULE.cpu` | see above | α, β and γ |

They reach the server as it starts. While it runs, `./launcher daemon on|off NAME` or
`PUT /api/v1/daemon/{name}` turns one on or off until it stops, and `PUT` with `settings`
changes its lines.
