# Architectural Decisions (02)

1. **Deterministic RNG Isolation**:
   - *Decision*: Counter-addressed Philox hash `(domain, object_id, step, stream)`.
   - *Reason*: Eliminates sequential PRNG coupling across independent modules.
2. **Reverse Twin Directionality**:
   - *Decision*: All physical segments are synthesized into bidirectional directed edge pairs.
   - *Reason*: Ensures network navigability and avoids deadlocks in synthetic sandbox experiments.
3. **Two-Layer State Delivery**:
   - *Decision*: Static topology fetched once; dynamic state streamed as indexed arrays matching topology order.
   - *Reason*: Reduces payload bandwidth by >80% for high-frequency (1 Hz) full snapshot streaming.
4. **Single-Writer Concurrency**:
   - *Decision*: Only the simulation engine thread mutates authoritative state; API threads submit commands.
   - *Reason*: Prevents race conditions and guarantees revision coherence.
5. **Decoupled UI Overlay API**:
   - *Decision*: Third-party decision agents post to `/ui-api/v1/*` hosted by the UI Fastify server.
   - *Reason*: Keeps external visualization overlays strictly separated from authoritative SUMO simulation state.
