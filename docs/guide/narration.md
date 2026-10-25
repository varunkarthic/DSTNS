# Natural-language narration

The core words its news tersely, for machines as much as people:

> [07:32:47] Commercial transit vehicle breakdown obstructing right lane on Edge #200 near Node #2652. (MID SEVERITY)

With narration on, the observer shows the same event the way a traffic desk
would say it:

> A commercial transit vehicle is broken down in the right lane on the motorway in
> the east district. Traffic speed is 55% of normal and road capacity is 60% of normal.

The sentence is written by a language model - by default **Apple's on-device
Foundation Model**, through the `fm` command that ships with macOS - from the
facts of the event. It is wording only. The simulation decides everything first
and never reads anything the model writes, so a run is the same with narration
on, off, or failing.

## Turning it on

On a Mac with Apple Intelligence, there is nothing to do: `dstns_server` finds
`fm`, starts `fm serve` on a private socket the first time there is something to
narrate, and stops it on exit. Check it is running:

```bash
curl -s localhost:8090/api/v1/system/narrator | python3 -m json.tool
```

Elsewhere (Linux, Docker, an older Mac) narration is off unless you point it at
a model. Any server that speaks the OpenAI Chat Completions API will do -
llama.cpp's `llama-server`, Ollama, vLLM, or `fm serve` on another machine:

```bash
dstns_server --narrator http://127.0.0.1:11434 --narrator-model llama3.2   # Ollama
dstns_server --narrator unix:/tmp/fm.sock                                  # a socket
dstns_server --narrator off                                                # never
```

| Option | Environment | Default | Meaning |
|---|---|---|---|
| `--narrator` | `DSTNS_NARRATOR` | `auto` | `auto` uses `fm` where installed, otherwise off; `fm` requires it; `off`; or an endpoint `http://HOST:PORT` or `unix:/PATH` |
| `--narrator-model` | `DSTNS_NARRATOR_MODEL` | `system` | The model name sent to an endpoint (`fm` serves `system`) |
| `--narrator-cache` | `DSTNS_NARRATOR_CACHE` | `<logs>/narrations.db` | Where narrations are kept between runs; `none` keeps them in memory only |

The engine speaks plain HTTP: put a TLS-terminating proxy in front of a remote
model, as you would in front of DSTNS itself.

## What is narrated

| News | Facts the model is given |
|---|---|
| `INCIDENT_ACTIVATED` | kind, the core's description, road name, district, closed or not, speed and capacity as a percentage of normal, expected clearing time |
| `INCIDENT_RESOLVED` | kind, road, district, traffic flowing normally |
| `DWS_RAIN_STARTED`, `DWS_RAIN_PEAK`, `DWS_RAIN_ENDED` | district, nearest named road, intensity, radius |
| `FLOOD_STARTED` | road, district |
| `TRAFFIC_SURGE_ACTIVE` | district, nearest named road, extra demand, radius, end time |

Internal identifiers (`Edge #200`, `Node #2652`) are never sent; roads are named
from OpenStreetMap, or described by class ("a residential street") when unnamed.
Districts use the same compass as the observer's notifications ("the north-east
district"). Demand changes, signal changes and system messages are not
narrated: they are frequent, already plain, or both.

## Guardrails

A model can be fluent and wrong, so every sentence is checked against the facts
it was written from before it is kept. It is discarded - and the core's own
wording shown - if it:

- contains any number that is not among the facts;
- mentions injuries, casualties, police, ambulances, fire, causes such as speeding,
  or visibility, unless the facts do;
- speculates or advises ("may", "might", "should", "avoid", "recommend");
- echoes the facts back as labels, or is a list rather than prose;
- is shorter than 12 or longer than 280 characters.

A discarded narration is not asked for again. Requests run at temperature 0, so
the same facts give the same sentence on the same model.

## Timing and caching

The on-device model takes about one to three seconds a sentence on an M-series
Mac. Three things keep that off the operator's path:

1. **Nothing waits for it.** The physics step only queues the facts; two worker
   threads, at utility priority so macOS places them on the efficiency cores,
   talk to the model.
2. **Scheduled news is narrated ahead of time.** Incidents and storms are planned
   when the world is compiled, so their narrations are requested at install,
   earliest first, and are usually ready before the clock reaches them.
3. **Narrations are cached by their facts.** The key is a hash of the facts, so the
   same event - after a seek, a replay, or a restart with the same seed - is
   narrated once. The cache lives in memory (4,096 entries) and in SQLite
   (`narrations.db`), so it survives restarts.

When a narration finishes after its item was delivered, the news feed carries it
to the observer through the `since_narration` cursor (see the
[News API](../api/news-api.md#narration)), and the notification updates in place.

If the model stops answering, three failures in a row pause narration for 30
seconds; the queue is bounded (256 items) and sheds the furthest-off prefetches
first. Either way the news keeps flowing in the core's wording.

## Privacy

With `fm`, everything stays on the Mac: the model runs on device and the socket
is private to the user. With a remote endpoint, the facts listed above - road
names, districts and times from a simulated day - are sent to it.
