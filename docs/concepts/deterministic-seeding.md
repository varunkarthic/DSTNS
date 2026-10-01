# Deterministic Seeding & Cryptographic Sub-Seed Derivation

DSTNS implements strict, bit-for-bit reproducible simulation dynamics across all platforms and compilers. A single 128-bit Master Seed (`Seed128`) governs the entire execution without shared global RNG state.

---

## 1. Architecture of Domain-Separated Sub-Seeds

To prevent cross-subsystem coupling (where introducing a random draw in weather generation would alter traffic, routing, or incidents), the master seed is cryptographically partitioned into independent sub-seeds via SHA-256 domain derivation:

```text
                           +------------------------+
                           |  Master Seed (128-bit) |
                           +------------------------+
                                        |
      +-------------------+-------------+-------------+-------------------+
      |                   |                           |                   |
      v                   v                           v                   v
SHA256(seed || "map")  SHA256(seed || "dws")    SHA256(seed || "traffic") SHA256(seed || "incidents")
      |                   |                           |                   |
      v                   v                           v                   v
   [Map RNG]           [DWS RNG]                [Traffic RNG]       [Incident RNG]
 (City Selection)  (Wendland Storms)           (Surge/Demand)     (Road Disruptions)
```

### Supported Sub-Seed Domains
- `"map"`: Metropolitan catalog selection, candidate coordinate hashing, and network cropping.
- `"dws"`: Deterministic Weather Simulation storm cell coordinates, radius, kinematic velocity, and precipitation rates.
- `"traffic"`: Demand baseline scaling, time-of-day multipliers, and localized traffic surge anchors.
- `"incidents"`: Road closures, traffic accidents, bottlenecks, temporal scheduling, and severity multipliers.
- `"events"`: Background scenario events and news ticker scheduling.
- `"scenario"`: General scenario compilation parameters and facility anchoring.

---

## 2. Implementation (`include/dstns/rng.hpp`, `src/rng.cpp`)

```cpp
Seed128 Seed128::derive(std::string_view domain) const {
    std::string input;
    input.reserve(16 + domain.size());
    // Append 16 bytes of little-endian master seed
    for (int i = 0; i < 8; ++i) input.push_back(static_cast<char>((lo >> (i * 8)) & 0xFF));
    for (int i = 0; i < 8; ++i) input.push_back(static_cast<char>((hi >> (i * 8)) & 0xFF));
    input.append(domain);

    std::uint8_t hash[32];
    sha256(reinterpret_cast<const std::uint8_t*>(input.data()), input.size(), hash);

    std::uint64_t d_lo = 0;
    std::uint64_t d_hi = 0;
    for (int i = 0; i < 8; ++i) d_lo |= (static_cast<std::uint64_t>(hash[i]) << (i * 8));
    for (int i = 0; i < 8; ++i) d_hi |= (static_cast<std::uint64_t>(hash[8 + i]) << (i * 8));
    return Seed128{d_lo, d_hi};
}
```

---

## 3. Cryptographic Avalanche Effect

A critical design requirement is that nearby seeds (e.g., `seed = 5000` vs `seed = 5001`) must not yield adjacent or correlated outputs. 

SHA-256 guarantees strict bit diffusion satisfying the Strict Avalanche Criterion (SAC):
- Any 1-bit perturbation in the input flips approximately 50% ($\sim 64$ bits) of the 128-bit derived seed.
- DSTNS unit tests (`DeterministicSeeding_SubSeedAvalanche` in `test_main.cpp`) explicitly assert that flipping a single bit in the master seed alters at least $\ge 40$ bits in the derived seed.

---

## 4. Subsystem RNG Isolation

Each subsystem instantiates its own `PhiloxRng` instance initialized with its derived sub-seed:

```cpp
auto map_seed = config.seed.derive("map");
auto dws_seed = config.seed.derive("dws");
auto traffic_seed = config.seed.derive("traffic");
auto incident_seed = config.seed.derive("incidents");

PhiloxRng map_rng(map_seed, RngDomain::MapGeneration);
PhiloxRng dws_rng(dws_seed, RngDomain::DWS);
PhiloxRng traffic_rng(traffic_seed, RngDomain::TrafficSurge);
PhiloxRng incident_rng(incident_seed, RngDomain::Incidents);
```

### Counter-Based Philox Engine
`PhiloxRng` uses the 4x64 Philox counter-based PRNG algorithm. Because sequence generation is purely a function of `(seed, domain, counter)`:
- Operations are stateless and branch-free.
- Thread scheduling or execution order cannot desynchronize state across subsystems.
- Zero runtime entropy (e.g. `std::rand()`, `std::random_device`, `time(nullptr)`) is used anywhere in the simulation pipeline.
