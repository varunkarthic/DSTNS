# Deterministic seeding

A DSTNS run is a pure function of its inputs. This page explains how a single
128-bit seed becomes every random choice in a simulation without any shared
random-number state, and why that makes the result independent of machine, thread
scheduling and the order in which subsystems happen to run. It ends with a worked
example you can reproduce by hand.

## Design goals

| Goal | Consequence |
|---|---|
| **Reproducible** | The same seed gives the same world on any machine |
| **Isolated** | Adding a random draw to weather must not change traffic, signals or incidents |
| **Order-independent** | A value must not depend on how many numbers were drawn before it |
| **Unbiased** | Bounded draws are uniform, with no modulo bias |
| **Human-sized** | An operator can read a seed off the screen and retype it |

A conventional generator such as `std::mt19937` fails the second and third goals:
it carries state, so inserting one draw anywhere shifts every later draw. DSTNS
instead uses **domain-separated sub-seeds** and a **counter-based generator**.

## The seed

A seed is an unsigned 128-bit integer, stored as two 64-bit halves:

```cpp
struct Seed128 {
    std::uint64_t high{};
    std::uint64_t low{};
};
```

\[
s = \text{high} \cdot 2^{64} + \text{low}, \qquad 0 \le s < 2^{128}
\]

Operators see it as a **decimal** integer (up to 39 digits); the internal form,
used for hashing, is 32 hexadecimal digits:

| Form | Example for the same seed | Used for |
|---|---|---|
| Decimal | `42` | The interface, the CLI, reports, the API field `seed` |
| Hexadecimal | `0x0000000000000000000000000000002a` | Hashing and derivation; the API fields `global_seed`, `seed_hex` |

Decimal parsing multiplies by ten and adds a digit in 128-bit arithmetic,
detecting overflow rather than wrapping:

```cpp
// seed = seed * 10 + digit, in 128 bits, detecting overflow.
const std::uint64_t low_product = seed.low * 10;
const std::uint64_t low_carry   = mul_high(seed.low, 10);      // the bits that spill past 2^64
const std::uint64_t high_product = seed.high * 10;
if (mul_high(seed.high, 10) != 0) throw std::invalid_argument("seed does not fit in 128 bits");
```

`mul_high` returns the upper 64 bits of a 64-by-64-bit product. Without it the
multiplication would silently lose the carry, and `340282366920938463463374607431768211456`
(which is \( 2^{128} \)) would parse as `0` instead of being rejected.

Seeds typed as `auto`, `random`, `0` or nothing draw a fresh **64-bit** seed
(`Seed128::secure64`), so a generated seed has at most 20 digits and stays easy to
retype.

## Domain-separated sub-seeds

The master seed is never used directly. Each subsystem asks for its own sub-seed,
named by a label \( \ell \):

\[
s_\ell \;=\; \operatorname{first\ 128\ bits\ of}\;\; \operatorname{SHA\text{-}256}\!\big(\, \operatorname{hex}(s) \;\Vert\; \texttt{":"} \;\Vert\; \ell \,\big)
\]

```cpp
Seed128 Seed128::derive(std::string_view domain) const {
    const std::string payload = hex() + ":" + std::string(domain);
    const std::string hash = sha256(payload);
    return Seed128::parse(std::string_view(hash).substr(0, 32));   // 32 hex digits = 128 bits
}
```

The labels in use:

| Label | Used by | Controls |
|---|---|---|
| `map.city` | `select_map_location` | Which of the 181 cities |
| `map.anchor` | `select_map_location` | Where in the city's extract the district grows from |
| `map` | `ScenarioCompiler` | District root, node flood susceptibility and drainage |
| `dws` | `plan_weather` | Storm schedule, positions, sizes |
| `traffic` | `plan_hotspots`, `plan_trips` | Hotspot edges, trip origins and destinations |
| `incidents` | `plan_incidents` | Incident times, edges and types |
| `signals` | `plan_signals` | Cycle jitter |
| `demand` | `EventRuntime::initialize` | Each place's character, peak, time shift and stretch |
| `scenario` | `ScenarioCompiler` | Synthetic building placement (test grids only) |

Because \( s_\ell \) is a hash, a change to any one subsystem's *code* (which
draws it makes, in what order) leaves every other subsystem's random stream
untouched. And because SHA-256 diffuses input changes, seeds that differ by one
bit give unrelated sub-seeds. For a good hash, flipping one input bit flips each
output bit with probability one half, so the expected number of differing bits
among 128 is

\[
\mathbb{E}[\Delta] = 64, \qquad \sigma = \sqrt{128 \cdot \tfrac12 \cdot \tfrac12} \approx 5.7
\]

For an ideal hash the number of differing bits is binomially distributed, so
falling below 40 has probability

\[
P\big(\Delta \le 40\big) \approx 1.6 \times 10^{-5}
\]

The unit test `subseed avalanche and domain separation`
(`tests/unit/test_main.cpp`) asserts at least 40 differing bits for a one-bit seed
change. It is there to catch a *broken* derivation (one that, say, ignored part of
the seed and so differed in only a handful of bits), not to measure SHA-256: a
working derivation passes with probability \( 1 - 1.6 \times 10^{-5} \), and the
test input is fixed, so it either always passes or always fails.

## The counter-based generator

A sub-seed \( s_\ell \) is the *key* of a stateless generator. Each random number
is a pure function of the key and an **address**:

\[
x \;=\; \Phi\big(\; k(s_\ell, d),\;\; c(o, p, n) \;\big)
\]

where \( d \) is the domain, and the address \( (o, p, n) \) is the **object**
(for example a storm index), the **purpose** (which quantity of that object) and
the **draw** counter:

```cpp
struct RngAddress {
    RngDomain     domain;   // MapSelection, BusStops, DwsSchedule, Incidents, ...
    std::uint64_t object;   // e.g. storm number, edge ID, incident index
    std::uint32_t purpose;  // e.g. 0 = start time, 1 = duration, 2 = position
    std::uint32_t draw;     // 0, then 1, 2, ... only when a draw is rejected
};
```

Reading "the intensity of storm 2" is `u32({DwsSchedule, 2, 3, 0})`. It does not
matter whether storm 1 was generated first, last or never: the value depends only
on the address. This is what makes the generator **order-independent**.

### Philox 4×32-10

\( \Phi \) is the Philox 4×32-10 block function (Salmon et al., *Parallel Random
Numbers: As Easy as 1, 2, 3*, SC '11). It maps a 128-bit counter and a 64-bit key
to 128 random bits through ten rounds. With counter words
\( (c_0, c_1, c_2, c_3) \) and key words \( (k_0, k_1) \), each round computes

\[
\begin{aligned}
p_0 &= M_0 \cdot c_0, \qquad p_1 = M_1 \cdot c_2 \qquad (\text{64-bit products}) \\
c' &= \big(\, \operatorname{hi}(p_1) \oplus c_1 \oplus k_0,\;\; \operatorname{lo}(p_1),\;\; \operatorname{hi}(p_0) \oplus c_3 \oplus k_1,\;\; \operatorname{lo}(p_0) \,\big) \\
k' &= \big(\, k_0 + \texttt{0x9E3779B9},\;\; k_1 + \texttt{0xBB67AE85} \,\big) \pmod{2^{32}}
\end{aligned}
\]

with the multipliers \( M_0 = \texttt{0xD2511F53} \) and \( M_1 = \texttt{0xCD9E8D57} \),
where \( \operatorname{hi} \) and \( \operatorname{lo} \) are the upper and lower
32 bits. The key advances by Weyl increments (the golden-ratio constant and
\( \sqrt{3} - 1 \) scaled to 32 bits) so each round uses a different key.

```cpp
std::array<std::uint32_t, 4> philox(std::array<std::uint32_t,4> c, std::array<std::uint32_t,2> key) {
    constexpr std::uint64_t m0 = 0xD2511F53ULL, m1 = 0xCD9E8D57ULL;
    for (int round = 0; round < 10; ++round) {
        const auto p0 = m0 * c[0], p1 = m1 * c[2];
        c = { static_cast<std::uint32_t>(p1 >> 32) ^ c[1] ^ key[0],  static_cast<std::uint32_t>(p1),
              static_cast<std::uint32_t>(p0 >> 32) ^ c[3] ^ key[1],  static_cast<std::uint32_t>(p0) };
        key[0] += 0x9E3779B9U;  key[1] += 0xBB67AE85U;               // different key each round
    }
    return c;
}
```

The counter packs the address, and the key mixes the sub-seed with the domain:

\[
c = \big(\, o \bmod 2^{32},\;\; \lfloor o / 2^{32} \rfloor,\;\; p,\;\; n \,\big),
\qquad
k = \big(\, s_{\text{lo},0} \oplus s_{\text{hi},0} \oplus d,\;\;\; s_{\text{lo},1} \oplus s_{\text{hi},1} \oplus (d \cdot \texttt{0x9E3779B9}) \,\big)
\]

where \( s_{\text{lo},0} \) and \( s_{\text{lo},1} \) are the low and high 32 bits of the
low half of \( s_\ell \), \( s_{\text{hi},0} \) and \( s_{\text{hi},1} \) likewise for its high half, and
the product \( d \cdot \texttt{0x9E3779B9} \) is taken modulo \( 2^{32} \). The first output
word of \( \Phi \) is the 32-bit random value \( x \).

## From random bits to useful values

### Uniform in (0, 1)

\[
u \;=\; \frac{x + \tfrac12}{2^{32}} \;\in\; \Big[\tfrac{1}{2^{33}},\; 1 - \tfrac{1}{2^{33}}\Big]
\]

The half-step offset keeps \( u \) strictly inside the open interval: it is never
exactly 0 or 1, so a formula such as \( \log u \) or \( 1/u \) cannot blow up.

### Bounded integers, without bias

To draw an integer in \( [0, B) \), taking \( x \bmod B \) directly is biased
whenever \( B \) does not divide \( 2^{32} \): the first \( 2^{32} \bmod B \)
values would each appear once more than the rest. DSTNS rejects the biased prefix:

\[
t \;=\; (2^{32} - B) \bmod B \;=\; 2^{32} \bmod B, \qquad
\text{accept } x \text{ only if } x \ge t, \quad \text{return } x \bmod B
\]

```cpp
std::uint32_t DeterministicRng::bounded(RngAddress a, std::uint32_t bound) const {
    const std::uint32_t threshold = static_cast<std::uint32_t>(-bound) % bound;   // 2^32 mod B
    for (;;) {
        const auto x = u32(a);
        if (x >= threshold) return x % bound;       // accepted range has 2^32 - t values, a multiple of B
        ++a.draw;                                   // rejected: try the next counter, same address otherwise
    }
}
```

The accepted range \( [t, 2^{32}) \) contains \( 2^{32} - t \) values, an exact
multiple of \( B \), so every residue is equally likely. The probability that a
draw is rejected is \( t / 2^{32} < B / 2^{32} \), and the expected number of draws
is \( 1 / (1 - t/2^{32}) \). For the 181-city catalogue \( t = 15 \), so the
rejection probability is \( 3.5 \times 10^{-9} \) and the expected number of draws is
\( 1.0000000035 \): in practice one. A rejection moves
to the next `draw` counter of the **same address**, so even rejection is
deterministic.

## Worked example: seed 42

This is the whole path from a seed to a place, computed by hand and checked
against the server. Seed `42` resolves to Dar es Salaam, Tanzania, anchored at
latitude −6.795255, longitude 39.202837.

**1. City.** The sub-seed for the label `map.city`:

\[
s_{\texttt{map.city}} = \operatorname{SHA\text{-}256}\big(\texttt{"0x0000000000000000000000000000002a:map.city"}\big)_{[0:128]}
= \texttt{0x209cc0489e06eab695fa3d6442c82f6d}
\]

With domain \( d = 1 \) (`MapSelection`) and address \( (o{=}0, p{=}0, n{=}0) \), a
bounded draw below \( B = 181 \) gives index **120**, which is Dar es Salaam in the
catalogue.

**2. Extract.** The city centre is (−6.7924, 39.2083). The extract is a square of
\( L = 5000 \) m. Metres per degree:

\[
m_\varphi = 111{,}320, \qquad m_\lambda = 111{,}320 \cdot \max(0.01,\cos\varphi_c)
\]

so the extract spans \( \varphi_c \pm L/(2 m_\varphi) \) and
\( \lambda_c \pm L/(2 m_\lambda) \).

**3. Anchor.** A second sub-seed, `map.anchor`, gives two uniform values
\( u_\varphi = 0.372878 \) (purpose 1) and \( u_\lambda = 0.258443 \) (purpose 2).
The anchor ranges over the *middle half* of the extract, so a district grown around
it stays largely inside the download:

\[
\varphi_a = \varphi_c - \tfrac{\Delta\varphi}{4} + \tfrac{\Delta\varphi}{2}\, u_\varphi,
\qquad
\lambda_a = \lambda_c - \tfrac{\Delta\lambda}{4} + \tfrac{\Delta\lambda}{2}\, u_\lambda
\]

where \( \Delta\varphi \) and \( \Delta\lambda \) are the full latitude and longitude
spans of the extract. Evaluating gives \( (\varphi_a, \lambda_a) = (-6.795255,\; 39.202837) \),
exactly what the container reported.

You can check this yourself:

```python
import hashlib

def derive(seed: int, label: str) -> int:
    hex128 = "0x%032x" % seed                       # 32 hex digits
    return int(hashlib.sha256(f"{hex128}:{label}".encode()).hexdigest()[:32], 16)

print(hex(derive(42, "map.city")))                  # 0x209cc0489e06eab695fa3d6442c82f6d
```

The remaining steps need the Philox rounds above; a complete Python
reimplementation is a dozen lines and agrees with the C++ to the last digit.

## Why this is safe to rely on

| Property | Guaranteed by |
|---|---|
| Same seed, same world | Pure functions of (sub-seed, address); no global state |
| Subsystems independent | One sub-seed per subsystem, derived by a hash |
| Order independence | The value depends only on the address, never on prior draws |
| No modulo bias | Rejection sampling over a multiple of the bound |
| Platform independence | Fixed-width integer arithmetic only; no `float`-derived randomness; SHA-256 and Philox are specified bit for bit |
| Tested | SHA-256 test vectors, repeatability, domain isolation, range checks (`tests/unit/test_main.cpp`), and reproducibility across two independent engines (`dstns_replay_verify`) |

!!! warning "What changes a seed's world"
    The seed alone does not fix the world: the **map bytes**, the **configuration**
    and the **DSTNS version** matter too. Fixing a modelling or parsing bug can
    change results for affected maps. See [Reproducibility](reproducibility.md).

## Related

- [Reproducibility](reproducibility.md): the guarantee, the hashes, and how it is tested.
- [Seeds and places](../guide/seeds-and-places.md): choosing and saving seeds.
- [RNG component](../components/rng.md): the class interface.
