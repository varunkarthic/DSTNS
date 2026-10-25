# Realistic News

The core words its news tersely, for machines as much as people:

> [07:32:47] Commercial transit vehicle breakdown obstructing right lane on Edge #4428 near Node #981. (MID SEVERITY)

The observer can show it two ways, chosen under **Settings → News → News style**:

**Realistic News** - written for this moment by a language model, by default
Apple's on-device Foundation Model, the way a local traffic reporter would say it:

> A commercial transit vehicle has broken down on Adderley Street in the east
> district, blocking the right lane during the morning rush. The road remains
> open but movement is slow as crews work nearby, with queues forming near The
> Crypt Jazz Restaurant. Keep to the left and allow extra space.

**Standard** - one of several predefined wordings for each kind of event,
chosen by the event so the same item always reads the same:

> Breakdown on Adderley Street in the east district: expect delays while it is cleared.

Either way it is wording only. The simulation decides everything first and never
reads anything the model writes, so a run is the same with Realistic News on,
off, or unavailable.

## Turning it on

On a Mac with Apple Intelligence there is nothing to do: the launcher reports
**Apple Foundation Models: Available**, the server starts `fm serve` on a private
socket when there is something to write and stops it on exit, and Realistic
News is the observer's default. When the model is missing, unsupported or not
ready the launcher says **Unavailable** and why; with `--narrator off` it says
**Disabled**. The observer then offers Standard only, and says why in Settings.

Elsewhere (Linux, Docker, an older Mac) point the server at any OpenAI-style
Chat Completions endpoint - llama.cpp's `llama-server`, Ollama, vLLM, or `fm serve`
on another machine:

```bash
dstns_server --narrator http://127.0.0.1:11434 --narrator-model llama3.2   # Ollama
dstns_server --narrator unix:/tmp/fm.sock                                  # a socket
dstns_server --narrator off                                                # never
```

| Option | Environment | Default | Meaning |
|---|---|---|---|
| `--narrator` | `DSTNS_NARRATOR` | `auto` | `auto` uses `fm` where installed, otherwise off; `fm` requires it; `off`; or an endpoint `http://HOST:PORT` or `unix:/PATH` |
| `--narrator-model` | `DSTNS_NARRATOR_MODEL` | `system` | The model name sent to an endpoint (`fm` serves `system`) |
| `--narrator-cache` | `DSTNS_NARRATOR_CACHE` | `<logs>/narrations.db` | Where items are kept between runs; `none` keeps them in memory only |

The launcher takes the same modes as `./launcher --narrator MODE` or
`narration.mode` in `config/defaults.json`, checks them before starting the server
(see [Operator CLI](operator-cli.md#narration)), and starts the server with
narration off when the choice cannot be used. The observer's starting style is
`news.style` in `config/ui-config.json` (see
[Observer configuration](observer-configuration.md#news)).

## Only for the observer

Realistic News belongs to the DSTNS observer. `GET /api/v1/news` serves exactly
the core's feed unless the request asks for it by name with
`narration=realistic`, which is what the observer sends when its style is
Realistic News; snapshots never carry it. See the
[News API](../api/news-api.md#realistic-news).

## What it knows

Each item is written from the event's facts and its context, all derived from the
world so that an item can be written before its event fires:

| Context | Example |
|---|---|
| City, day type, time of day | Cape Town, South Africa · a weekday · 07:32, the morning rush hour |
| Road and district | Adderley Street (or "a residential street") · the east district |
| Places nearby | The Crypt Jazz Restaurant (restaurant); Vista High School (school) |
| Weather at that place and time | heavy rain |
| Earlier today | a collision at 06:10 on this same road |
| What happened, for a clearance | Commercial transit vehicle breakdown obstructing right lane, started at 07:32 |
| The angle of the story | the weather and driving conditions only; no crashes, breakdowns or crews |

Internal identifiers (`Edge #4428`) are never sent.

| News | Written by the model |
|---|---|
| Incidents starting and clearing | Always |
| Rain starting, peaking and clearing; flooding; demand surges | Always |
| A place at its busiest | For named schools, universities, hospitals, shopping centres and stations; a city's thousands of other demand changes keep Standard wording |
| Signals, system messages, demand winding down | Never |

## Guardrails

The model is asked to add ordinary, plausible colour - the scene, what drivers
are seeing, a word of advice - and that is the point. It is checked before it
is kept, and its item is discarded, with the Standard wording shown instead, if it:

- contains any number or time that is not among the facts;
- mentions deaths;
- speaks as itself ("I", "as an assistant");
- echoes the facts back as labels, or is a list rather than prose;
- is shorter than 20 or longer than 420 characters.

A discarded item is not asked for again.

## Timing and caching

The on-device model takes about four to six seconds an item on an M-series Mac.
Nothing waits for it:

1. **The physics step only queues the facts.** Two worker threads, at utility
   priority so macOS places them on the efficiency cores, talk to the model.
2. **Scheduled news is written ahead.** Incidents, storms and busy hours at notable
   places are planned when the world is compiled, so they are requested at
   install, earliest first, and are usually ready before the clock reaches them.
3. **Items are cached by their facts** - in memory (4,096 entries) and in SQLite
   (`narrations.db`) - so a seek, a replay or a restart reuses them. Floods,
   surges and busy hours carry the hour rather than the minute, so repeats on
   one road within the hour share an item.

An item finished after its news was delivered reaches the observer through the
`since_narration` cursor, and the notification updates in place, marked
**Realistic News**. If the model stops answering, three failures in a row pause
it for 30 seconds; the queue is bounded (256 items) and sheds the furthest-off
work first. Either way the news keeps flowing in Standard wording.

## Privacy

With `fm`, everything stays on the Mac: the model runs on device and the socket is
private to the user. With a remote endpoint, the facts listed above - from a
simulated day - are sent to it.
