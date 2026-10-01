# Frequently asked questions

## General

??? question "What is DSTNS for?"
    Studying how traffic on a real road network behaves over a day, under
    demand, signals, weather, flooding and incidents, in a way that is exactly
    repeatable. It suits teaching, research prototypes, testing transport
    algorithms against realistic and reproducible conditions, and demos.

??? question "Is it a microscopic simulator like SUMO?"
    No. DSTNS is **aggregate**: it models flows and queues per directed road
    segment, which makes a whole day of a 3,000-junction district cheap enough
    to scrub back and forth interactively. For a microscopic view of the same
    network, export it to SUMO (see the [SUMO adapter](components/sumo-adapter.md)).

??? question "Are the moving dots real vehicles?"
    They visualise modelled flow on each road, not individual tracked vehicles.

??? question "Which cities can it simulate?"
    Any city in its catalogue of 181, chosen by the seed (see [Seeds and
    places](guide/seeds-and-places.md#from-seed-to-place)), or any area you
    have as OpenStreetMap XML, with `--osm-file`.

??? question "Does it need the internet?"
    Only to download a city's map the first time. Cached cities, pinned maps
    and the bundled district run offline.

## Seeds and reproducibility

??? question "If I run the same seed twice, do I get exactly the same day?"
    Yes: the same seed, configuration, map bytes and DSTNS version give the
    same world and the same results, bit for bit, on any machine. Operator
    actions you take during the run are part of its history and change it. See
    [Reproducibility](concepts/reproducibility.md).

??? question "Does the speed I watch at change the results?"
    No. Physics always advances in one-second steps; speed only changes how
    fast those steps are taken. Seeking to a time and playing to it give
    identical state.

??? question "Why did my seed land somewhere else after an update?"
    It should not: the city catalogue and its order are frozen under the
    selection version `urban-crfg-v3`. One change can alter a *graph*, though:
    the October 2026 fix that makes untagged roundabouts one-way changes maps
    containing them. See [the changelog](changelog.md).

??? question "Can two seeds give the same city?"
    Yes, often: 181 cities, astronomically many seeds. They give different
    districts of it, and different weather, incidents and demand.

## Running

??? question "Docker or from source?"
    Docker to run it; from source to develop it or to use the operator CLI's
    full toolset (tests, saved seeds, logs). See [Getting
    started](getting-started/index.md).

??? question "How long does a day take?"
    One hour at 1× by default. Choose 0.25× to 5× in the interface, or change
    the duration (60 to 3600 seconds) with `--duration`.

??? question "Can I run several simulations at once?"
    One server runs one simulation. Run several servers on different ports:
    `./build/dstns_server --port 8091 --logs logs2`, or several containers with
    different `DSTNS_HOST_PORT` and project names.

??? question "Can I start a run from my own program?"
    Yes. `POST /api/v1/playback/start` with the operator credential from
    `logs/operator.token` in `X-DSTNS-Operator`. See the [Playback
    API](api/playback-api.md#post-start).

??? question "Why can't the browser choose the seed?"
    By design: what runs is the operator's decision, made with the CLI that
    holds the credential. The observer can ask for a *new* world, whose seed
    comes from a secure generator; operators can disable even that.

## The interface

??? question "It says DEGRADED or locks the speed."
    Adaptive backpressure: the browser is not keeping up, often because the
    tab is in the background, the machine is busy, or it is a virtual machine.
    DSTNS slows itself to match and recovers on its own. See [Adaptive
    backpressure](concepts/backpressure.md).

??? question "It says the window is too small."
    The observer needs 1024 × 640 CSS pixels. Enlarge the window or zoom out
    (++ctrl+minus++ or ++cmd+minus++).

??? question "How do I reset my interface preferences?"
    **About** (the ⓘ in the top bar) → **Reset all preferences**. Your run is
    not affected.

## Development

??? question "How do I run the tests?"
    `./scripts/test.sh` runs everything; see [Testing](development/testing.md)
    for each suite.

??? question "How do I preview the documentation?"
    `pip install -r docs/requirements.txt && mkdocs serve`. See [Building the
    documentation](development/documentation.md).

??? question "Does DSTNS take bug reports, feature requests or contributions?"
    No. DSTNS is developed independently and released for public use. You are welcome to
    fork it and change your copy under the [licence](license.md). The
    [troubleshooting guide](troubleshooting.md) covers the problems most likely to come up.

??? question "How do I report a security problem?"
    Privately, through the repository's **Security** tab, as described in the
    [security policy](https://github.com/varunkarthic/DSTNS/blob/main/SECURITY.md). Never in
    a public issue.
