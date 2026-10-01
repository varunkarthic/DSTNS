# Deterministic RNG (`dstns::DeterministicRng`)

## Purpose
The RNG subsystem provides deterministic, counter-addressed, domain-isolated pseudo-random number generation across the entire DSTNS simulator. It ensures that changing random draws in one module (such as DWS weather) does not alter draws in other modules (such as road topology selection, bus stops, or traffic hotspots).

## Responsibilities
- Parse and represent 128-bit global simulation seeds (`dstns::Seed128`).
- Provide counter-based 4-dimensional addressable random number evaluation `(domain, object, purpose, draw)`.
- Implement stateless 10-round Philox-style generation and SHA-256 digests.
- Generate uniformly distributed integer, floating-point, and bounded values in $[0, \text{bound})$.
- Maintain address-domain isolation across the nine declared `RngDomain` values.

## Non-responsibilities
- Maintaining sequential stateful PRNG state (e.g. `std::mt19937` or `std::rand`).
- Making dynamic decisions about scenario topology or traffic demand.

## Inputs & Outputs
- **Inputs**: 128-bit master seed, 4D `RngAddress` tuple `(RngDomain, object, purpose, draw)`.
- **Outputs**: Deterministic 32-bit/64-bit unsigned integers, normalized floats in $[0, 1)$, bounded integers, SHA-256 hex strings.

## Data structures and enumerations
```cpp
enum class RngDomain : std::uint32_t {
    MapSelection = 1, BusStops, Buildings, TrafficControl, TrafficOD,
    TrafficSignals, DwsSchedule, DwsField, DaySelector
};

struct RngAddress {
    RngDomain domain;
    std::uint64_t object{};
    std::uint32_t purpose{};
    std::uint32_t draw{};
};
```

## Mathematical model
Given 128-bit seed $K = (K_0, K_1)$ and address $C = (\text{domain}, \text{object}, \text{purpose}, \text{draw})$, the Philox-style implementation computes:
$$C' = \text{Philox4x32}(C, K)$$
A normalized uniform float $u \in (0, 1)$ is generated via:
$$u = \frac{C'_0+0.5}{2^{32}}$$
Bounded integers in $[0,B)$ use rejection sampling to avoid modulo bias.

## Public interfaces
```cpp
class DeterministicRng {
public:
    explicit DeterministicRng(Seed128 seed);
    [[nodiscard]] std::uint32_t u32(RngAddress addr) const;
    [[nodiscard]] std::uint64_t u64(RngAddress addr) const;
    [[nodiscard]] double uniform01(RngAddress addr) const;
    [[nodiscard]] std::uint32_t bounded(RngAddress addr, std::uint32_t bound) const;
    [[nodiscard]] Seed128 seed() const;
};
```

## Threading & State Transitions
- `DeterministicRng` is completely stateless and thread-safe for concurrent read access.
- Deterministic random values depend solely on `(seed, address)` and have no internal state mutations.

## Testing strategy
- Unit tests verify 128-bit seed parsing, round-trip serialization, and SHA-256 test vectors (`test_main.cpp`).
- Unit tests verify repeatability and that changing an address domain changes the sampled stream.
- Range tests confirm values remain strictly within $[0, \text{bound})$.
