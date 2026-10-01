# Implementation notes

The initial implementation deliberately establishes a runnable deterministic vertical slice. Static and dynamic graph state are separated, JSON snapshots are built under a coherent engine lock, and the UI only consumes published API state. OSM XML and offline fixtures are supported; PBF/planet indexing is not. SUMO plain XML is validated end-to-end, while live in-process libsumo state replacement remains open.

Controls use independent multiplier channels and logical undo. Checkpoint seek restores stored dynamic arrays then replays fixed steps. Revisions are state commits, not HTTP read counters.
