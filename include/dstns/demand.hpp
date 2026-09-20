#pragma once

#include "dstns/model.hpp"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace dstns {

// ---------------------------------------------------------------------------
// Demand
//
// What a place draws out of the network, as a multiplier on its baseline
// contribution. Two layers, deliberately separated:
//
//   1. A *diurnal profile* - what this kind of place does on an ordinary day,
//      as a continuous function of time. Sums of Gaussian bumps over a floor,
//      so demand swells and subsides rather than switching between levels.
//
//   2. *Couplings* - how a place responds to what is happening elsewhere right
//      now. A school run does not care what the weather is; a park does. A
//      pharmacy is busier after a crash nearby; a hotel is not.
//
// The second layer is what makes the network behave as a system rather than a
// collection of independent schedules. Every coupling is a named, bounded
// multiplier with a stated reason, so any demand figure can be decomposed into
// "this is the profile, and this is what the rest of the network did to it".
// ---------------------------------------------------------------------------

enum class PlaceKind : std::uint8_t {
    School,
    University,
    Office,
    Retail,
    Mall,
    Hospital,
    Pharmacy,
    Food,
    Transport,
    BusStop,
    Parking,
    Park,
    Industrial,
    Residential,
    Worship,
    Culture,
    Hotel,
    Other,
};

[[nodiscard]] const char* to_string(PlaceKind kind);

/// Classify a map feature from its OpenStreetMap tags and category.
[[nodiscard]] PlaceKind classify_place(const MapFeature& feature);

/// Whether this kind is modelled at all. Unmodelled kinds sit at 1.0 and are
/// hidden from the places legend by default.
[[nodiscard]] bool is_modelled(PlaceKind kind);

/// Places that generate trips others respond to (schools, offices, retail...).
[[nodiscard]] bool is_generator(PlaceKind kind);

/// Places whose custom is shopping, eating or errands.
[[nodiscard]] bool is_commercial(PlaceKind kind);

/**
 * Baseline multiplier for this kind at this moment of the virtual day.
 *
 * `virtual_s` is seconds since midnight; `day` is 0 for a weekday and 1 for a
 * weekend. The result is >= 1 and continuous in time, with continuous first
 * derivative - there are no steps, so nothing in the network jumps.
 */
[[nodiscard]] double diurnal_demand(PlaceKind kind, double virtual_s, int day);

/// The state of the network around one place, as its couplings see it.
struct DemandContext {
    /// Rainfall intensity at the place, 0..1.
    double rain{};
    /// Share of nearby road capacity that is closed or impassable, 0..1.
    double blocked_share{};
    /// Incident and flood pressure nearby, 0..1.
    double distress{};
    /// Mean excess demand (multiplier - 1) of nearby commercial places.
    double commercial_pull{};
    /// Mean excess demand of nearby trip generators.
    double generator_pull{};
};

/// Coupling strengths. Public so tests state the contract in the same terms.
inline constexpr double kCouplingClosure = 0.55;    // displaced trips
inline constexpr double kCouplingHealth = 0.60;     // pharmacies, hospitals
inline constexpr double kCouplingShelter = 0.35;    // indoor places in rain
inline constexpr double kCouplingExposure = 0.75;   // outdoor places in rain
inline constexpr double kCouplingParking = 0.85;    // parking follows commerce
inline constexpr double kCouplingTransit = 0.70;    // stops follow generators
/// How close another place must be to influence one, in metres.
inline constexpr double kCouplingRadiusM = 400.0;
/// How many neighbouring edges and peer places one place reads when its
/// couplings are evaluated. The kernel weights fall off steeply, so the
/// strongest few carry the signal; the cap is what keeps a tick's work bounded
/// in a dense city centre rather than quadratic in how much is mapped there.
inline constexpr std::size_t kCouplingFanout = 24;
/// No place may exceed this, however many couplings stack.
inline constexpr double kDemandCeiling = 3.0;

// ---------------------------------------------------------------------------
// Stop topology
//
// OpenStreetMap records a bus stop per kerb, per platform and per operator, so
// a single place on the ground can arrive as half a dozen nodes metres apart.
// Drawn as-is they cluster into an unreadable blob, and the demand model reads
// one stop's worth of boarding as six. Thinning collapses each cluster to its
// best-attested member, leaving stops spaced the way a real network spaces
// them.
// ---------------------------------------------------------------------------

/// Minimum distance between two stops *serving the same street*, in metres.
/// Urban routes space their stops between 250 m and 450 m apart.
inline constexpr double kBusStopSpacingM = 300.0;
/// Below this, two stop nodes are the same stop on the ground however they are
/// tagged: opposite kerbs, a shelter and its flag, two operators' platforms.
inline constexpr double kStopDuplicateM = 60.0;

/// How close stops are allowed to sit.
struct StopSpacing {
    /// Stops on the same corridor must be at least this far apart.
    double along_corridor_m{kBusStopSpacingM};
    /// No two stops, on any corridor, may be closer than this.
    double duplicate_m{kStopDuplicateM};
};

/**
 * Remove bus stops that crowd a better-attested neighbour.
 *
 * Spacing is a property of a route, not of the map: two stops 150 m apart on
 * parallel streets are two real stops serving two corridors, while two stops
 * 150 m apart on the same street are one stop mapped twice. So a corridor id
 * per feature (the way each stop serves) governs which rule applies - stops
 * sharing a corridor are held to `along_corridor_m`, and everything else only
 * has to clear `duplicate_m`. Pass no corridors and every stop is treated as
 * sharing one, which is the strictest reading.
 *
 * Deterministic: candidates are ranked by how well attested they are (a named
 * station outranks a named stop, which outranks an unnamed node) and ties break
 * on feature id, so the same extract always thins to the same stops. Only bus
 * stops are considered - every other feature is left exactly as it was.
 *
 * Returns the number of features removed.
 */
std::size_t thin_bus_stops(std::vector<MapFeature>& features,
                           const std::vector<std::uint64_t>& corridors = {},
                           StopSpacing spacing = {});

/// Whether this feature is a bus stop or station, by its tags.
[[nodiscard]] bool is_bus_stop(const MapFeature& feature);

/// One coupling's contribution, for explaining a figure.
struct DemandFactor {
    const char* name;
    double multiplier;
};

/**
 * Apply the couplings to a baseline.
 *
 * Couplings multiply, because they are independent pressures on the same
 * place: rain and a nearby closure both make a shop busier, and doing both at
 * once is busier still. The product is clamped so no stack of coincidences can
 * produce a figure the traffic model cannot carry.
 *
 * When `factors` is given it receives each contribution that was not 1,
 * newest first, so a caller can say why a number is what it is.
 */
[[nodiscard]] double couple_demand(PlaceKind kind, double baseline, const DemandContext& context,
                                   std::vector<DemandFactor>* factors = nullptr);

} // namespace dstns
