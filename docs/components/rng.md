# RNG Subsystem (`dstns::rng`)

## Purpose
The RNG subsystem provides deterministic, counter-addressed, domain-isolated pseudo-random number generation across the entire DSTNS simulator. It ensures that changing random draws in one module (such as DWS weather) does not alter draws in other modules (such as road topology selection, bus stops, or traffic hotspots).

## Responsibilities
- Parse and represent 128-bit global simulation seeds (`dstns::Seed128`).
- Provide counter-based 4-dimensional addressable random number evaluation `(domain, object_id, step, stream)`.
- Implement stateless, reversible Philox-style hashing and SHA-256 digests.
- Generate uniformly distributed integer, floating-point, and bounded values in $[0, \text{bound})$.
- Maintain strict domain isolation across all 8 simulation subsystems.

## Non-responsibilities
- Maintaining sequential stateful PRNG state (e.g. `std::mt19937` or `std::rand`).
- Making dynamic decisions about scenario topology or traffic demand.

## Inputs & Outputs
- **Inputs**: 128-bit master seed, 4D `RngAddress` tuple `(RngDomain, object_id, step, stream)`.
- **Outputs**: Deterministic 32-bit/64-bit unsigned integers, normalized floats in $[0, 1)$, bounded integers, SHA-256 hex strings.

## Data Structures & Enums
```cpp
enum class RngDomain : std::uint8_t {
    MapSelection    = 1,
    BusStops        = 2,
    Buildings       = 3,
    Signals         = 4,
    TrafficHotspots = 5,
    TrafficOD       = 6,
    DwsSchedule     = 7,
    FloodParams     = 8
};

struct RngAddress {
    RngDomain domain;
    std::uint32_t object_id{};
    std::uint32_t step{};
    std::uint32_t stream{};
};
```

## Mathematical Model
Given 128-bit seed $K = (K_0, K_1)$ and counter vector $C = (\text{domain}, \text{object\_id}, \text{step}, \text{stream})$, the 4-round Philox-like bijection computes:
$$C' = \text{Philox4x32}(C, K)$$
A normalized uniform float $u \in [0, 1)$ is generated via:
$$u = \frac{C'_0}{2^{32}}$$
Bounded integer in $[0, B)$:
$$r = \lfloor u \cdot B \rfloor$$

## Public Interfaces
```cpp
class DeterministicRng {
public:
    explicit DeterministicRng(Seed128 seed);
    [[nodiscard]] std::uint32_t u32(RngAddress addr) const;
    [[nodiscard]] double uniform01(RngAddress addr) const;
    [[nodiscard]] std::uint32_t bounded(RngAddress addr, std::uint32_t bound) const;
    [[nodiscard]] Seed128 seed() const;
};
```

## Threading & State Transitions
- `DeterministicRng` is completely stateless and thread-safe for concurrent read access.
- Deterministic random values depend solely on `(seed, address)` and have no internal state mutations.

## Testing Strategy
- Unit tests verify 128-bit seed parsing, round-trip serialization, and SHA-256 test vectors (`test_main.cpp`).
- Domain isolation tests verify that varying the domain produces independent uncorrelated distributions.
- Range tests confirm values remain strictly within $[0, \text{bound})$.
