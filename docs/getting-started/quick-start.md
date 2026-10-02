# Quick start

The shortest path from nothing to a running simulation.

=== "Docker"

    ```bash
    git clone https://github.com/varunkarthic/DSTNS.git
    cd DSTNS
    docker compose up --pull always
    ```

    Open **<http://localhost:8090>**. The first build takes a few minutes; the
    container then picks a random seed, downloads that city's map (20 to 60
    seconds the first time) and starts the day.

    Start another run without restarting:

    ```bash
    docker compose exec dstns dstns-run --seed 382923
    ```

    Full details: [Run with Docker](docker.md).

=== "From source"

    ```bash
    git clone https://github.com/varunkarthic/DSTNS.git
    cd DSTNS
    ./launcher
    ```

    The launcher installs the CLI's dependencies, builds the C++ core and the
    observer (a few minutes the first time), starts the server, opens
    **<http://127.0.0.1:8090>** in your browser and starts a run.

    Pick the seed yourself:

    ```bash
    ./launcher start --seed 382923
    ```

    Prerequisites and platform notes: [Installation](installation.md).

## What you should see

1. The observer opens and narrates start-up: the seed resolving to a city, the
   map downloading, the world being built.
2. The map of the district appears with roads coloured by congestion, and the
   clock starts at 00:00:00.
3. The day plays out in an hour at 1× (choose 0.25× to 5× in the command rail).
   Signals cycle, traffic builds through the morning peak, storms pass over,
   incidents close roads and clear.

![The observer](../assets/screenshots/observer.png){ .screenshot }

## Common first commands

```bash
./launcher start --seed 382923 --day-type weekend   # a weekend in the same place
./launcher start --speed 3                          # three times faster
./launcher start --seed 42 --save-seed demo         # save the configuration
./launcher start --saved-seed demo                  # replay it exactly
./launcher console                                  # interactive dashboard
./launcher test                                     # run the test suites
```

## Offline

Both paths can run a recorded real district with no network:

=== "Docker"

    ```bash
    DSTNS_OSM_FILE=/app/data/fixtures/real_network.osm.xml docker compose up
    ```

=== "From source"

    ```bash
    ./launcher start --osm-file data/fixtures/real_network.osm.xml
    ```

Any city you have downloaded before is cached and also works offline. See
[Seeds and places](../guide/seeds-and-places.md#the-map-cache).

## Next

- [Your first simulation](first-simulation.md): what you are looking at.
- [Operator CLI](../guide/operator-cli.md): every command and flag.
- [Troubleshooting](../troubleshooting.md) if anything above did not work.
