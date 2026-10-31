// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/demand.hpp"
#include "dstns/graph.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace dstns {
namespace {

constexpr double kDay = 86400.0;

/// One Gaussian bump in a diurnal profile.
struct Bump {
    double at_s;    // centre, seconds since midnight
    double sigma_s; // width
    double amp;     // added multiplier at the crest
};

/**
 * Value of a bump at `t`, wrapped across midnight.
 *
 * Wrapping matters: an evening bump with a wide shoulder genuinely reaches
 * past midnight, and a profile that cut off at 23:59:59 would put a
 * discontinuity in the middle of the night.
 */
double bump_at(const Bump& b, double t) {
    double d = std::fabs(t - b.at_s);
    d = std::min(d, kDay - d);
    const double z = d / b.sigma_s;
    return b.amp * std::exp(-0.5 * z * z);
}

double sum_bumps(const Bump* bumps, std::size_t count, double t, double floor_value) {
    double total = floor_value;
    for (std::size_t i = 0; i < count; ++i) total += bump_at(bumps[i], t);
    return total;
}

constexpr double h(double hours) { return hours * 3600.0; }
constexpr double m(double minutes) { return minutes * 60.0; }

} // namespace

const char* to_string(PlaceKind kind) {
    switch (kind) {
        case PlaceKind::School: return "school";
        case PlaceKind::University: return "university";
        case PlaceKind::Office: return "office";
        case PlaceKind::Retail: return "retail";
        case PlaceKind::Mall: return "mall";
        case PlaceKind::Hospital: return "hospital";
        case PlaceKind::Pharmacy: return "pharmacy";
        case PlaceKind::Food: return "food";
        case PlaceKind::Transport: return "transport";
        case PlaceKind::BusStop: return "bus_stop";
        case PlaceKind::Parking: return "parking";
        case PlaceKind::Park: return "park";
        case PlaceKind::Industrial: return "industrial";
        case PlaceKind::Residential: return "residential";
        case PlaceKind::Worship: return "worship";
        case PlaceKind::Culture: return "culture";
        case PlaceKind::Hotel: return "hotel";
        case PlaceKind::Other: return "other";
    }
    return "other";
}

bool is_modelled(PlaceKind kind) {
    // Places of worship, residential blocks and unclassified buildings are
    // drawn but not modelled: the traffic model has nothing meaningful to say
    // about when they are busy, and pretending otherwise would be invention.
    switch (kind) {
        case PlaceKind::Worship:
        case PlaceKind::Residential:
        case PlaceKind::Other: return false;
        default: return true;
    }
}

bool is_generator(PlaceKind kind) {
    switch (kind) {
        case PlaceKind::School:
        case PlaceKind::University:
        case PlaceKind::Office:
        case PlaceKind::Mall:
        case PlaceKind::Retail:
        case PlaceKind::Transport:
        case PlaceKind::Industrial:
        case PlaceKind::Hospital: return true;
        default: return false;
    }
}

bool is_commercial(PlaceKind kind) {
    switch (kind) {
        case PlaceKind::Retail:
        case PlaceKind::Mall:
        case PlaceKind::Food: return true;
        default: return false;
    }
}

PlaceKind classify_place(const MapFeature& feature) {
    const auto tag = [&](const char* key) -> std::string {
        const auto it = feature.tags.find(key);
        return it == feature.tags.end() ? std::string{} : it->second;
    };
    const auto matches = [](const std::string& value, std::initializer_list<const char*> any) {
        for (const auto* candidate : any)
            if (value == candidate) return true;
        return false;
    };

    // Most specific tag first: a building=yes tagged shop=mall is a mall.
    const std::string amenity = tag("amenity");
    const std::string shop = tag("shop");
    const std::string office = tag("office");
    const std::string railway = tag("railway");
    const std::string transport = tag("public_transport");
    const std::string leisure = tag("leisure");
    const std::string landuse = tag("landuse");
    const std::string tourism = tag("tourism");
    const std::string building = tag("building");
    const std::string& category = feature.category;

    if (amenity == "bus_station" || transport == "platform" || transport == "stop_position" ||
        tag("highway") == "bus_stop" || category == "bus_stop")
        return PlaceKind::BusStop;
    if (matches(amenity, {"school", "kindergarten", "childcare"}) ||
        matches(category, {"school", "kindergarten", "childcare"}))
        return PlaceKind::School;
    if (matches(amenity, {"university", "college"}) || matches(category, {"university", "college"}))
        return PlaceKind::University;
    if (matches(amenity, {"hospital", "clinic", "doctors"}) ||
        matches(category, {"hospital", "clinic", "doctors"}))
        return PlaceKind::Hospital;
    if (amenity == "pharmacy" || shop == "chemist" || category == "pharmacy")
        return PlaceKind::Pharmacy;
    if (matches(amenity, {"restaurant", "cafe", "fast_food", "bar", "pub", "food_court"}) ||
        matches(category, {"restaurant", "cafe", "fast_food", "bar", "pub"}))
        return PlaceKind::Food;
    if (matches(shop, {"mall", "department_store"}) || amenity == "marketplace" ||
        matches(category, {"mall", "marketplace", "department_store"}))
        return PlaceKind::Mall;
    if (matches(amenity, {"parking", "fuel"}) || matches(building, {"garage", "garages"}) ||
        matches(category, {"parking", "fuel", "garage", "garages"}))
        return PlaceKind::Parking;
    if (!railway.empty() || transport == "station" || matches(category, {"station", "train_station", "subway", "halt"}))
        return PlaceKind::Transport;
    if (!shop.empty() || matches(landuse, {"retail"}) || matches(category, {"supermarket", "convenience", "retail"}))
        return PlaceKind::Retail;
    if (matches(amenity, {"place_of_worship"}) ||
        matches(category, {"place_of_worship", "church", "mosque", "synagogue", "temple"}))
        return PlaceKind::Worship;
    if (matches(amenity, {"museum", "library", "theatre", "cinema", "arts_centre"}) ||
        matches(tourism, {"museum", "gallery", "attraction"}) ||
        matches(category, {"museum", "library", "theatre", "cinema", "arts_centre", "gallery"}))
        return PlaceKind::Culture;
    if (matches(tourism, {"hotel", "hostel", "guest_house"}) ||
        matches(category, {"hotel", "hostel", "guest_house"}))
        return PlaceKind::Hotel;
    if (!office.empty() || matches(amenity, {"bank", "courthouse", "townhall"}) ||
        matches(landuse, {"commercial"}) ||
        matches(category, {"office", "offices", "company", "commercial", "government", "bank"}))
        return PlaceKind::Office;
    if (matches(landuse, {"industrial"}) || matches(building, {"warehouse", "industrial", "factory"}) ||
        matches(category, {"industrial", "warehouse", "factory", "works"}))
        return PlaceKind::Industrial;
    if (matches(leisure, {"park", "garden", "playground", "pitch", "recreation_ground"}) ||
        matches(landuse, {"grass", "forest", "meadow"}) ||
        matches(category, {"park", "garden", "playground", "pitch", "recreation_ground"}))
        return PlaceKind::Park;
    if (matches(building, {"residential", "apartments", "house", "detached", "dormitory", "terrace"}) ||
        matches(landuse, {"residential"}) ||
        matches(category, {"residential", "apartments", "house", "detached", "dormitory"}))
        return PlaceKind::Residential;
    return PlaceKind::Other;
}

double diurnal_demand(PlaceKind kind, double virtual_s, int day) {
    // Wrap so callers may pass any time, including a seek past midnight.
    double t = std::fmod(virtual_s, kDay);
    if (t < 0) t += kDay;
    const bool weekend = day == 1;

    switch (kind) {
        case PlaceKind::School: {
            // Arrival and home time, and almost nothing at the weekend.
            if (weekend) return 1.0;
            static constexpr Bump b[] = {{h(8.0), m(22), 0.85}, {h(15.25), m(28), 0.75}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::University: {
            // Later, flatter and longer than a school: lectures all day.
            if (weekend) {
                static constexpr Bump w[] = {{h(12.0), h(3.0), 0.20}};
                return sum_bumps(w, std::size(w), t, 1.0);
            }
            static constexpr Bump b[] = {
                {h(9.0), m(45), 0.70}, {h(13.0), h(1.0), 0.45}, {h(17.5), m(40), 0.55}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::Office: {
            if (weekend) return 1.02;
            static constexpr Bump b[] = {
                {h(8.75), m(35), 0.80}, {h(12.5), m(30), 0.25}, {h(17.75), m(40), 0.85}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::Retail: {
            static constexpr Bump b[] = {{h(12.5), h(1.0), 0.40}, {h(17.5), m(90), 0.70}};
            return sum_bumps(b, std::size(b), t, 1.0) + (weekend ? 0.25 : 0.0);
        }
        case PlaceKind::Mall: {
            static constexpr Bump b[] = {{h(13.0), m(90), 0.55}, {h(18.5), m(100), 0.80}};
            return sum_bumps(b, std::size(b), t, 1.0) + (weekend ? 0.35 : 0.0);
        }
        case PlaceKind::Hospital: {
            // Never quiet, busier in clinic hours.
            static constexpr Bump b[] = {{h(10.5), h(3.0), 0.25}};
            return sum_bumps(b, std::size(b), t, 1.15);
        }
        case PlaceKind::Pharmacy: {
            static constexpr Bump b[] = {{h(10.5), h(2.0), 0.30}, {h(18.5), h(1.0), 0.45}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::Food: {
            static constexpr Bump b[] = {{h(12.75), m(45), 0.90}, {h(19.5), m(70), 0.95}};
            return sum_bumps(b, std::size(b), t, 1.0) + (weekend ? 0.15 : 0.0);
        }
        case PlaceKind::Transport: {
            if (weekend) {
                static constexpr Bump w[] = {{h(11.0), h(2.5), 0.35}};
                return sum_bumps(w, std::size(w), t, 1.0);
            }
            static constexpr Bump b[] = {{h(8.25), m(30), 0.95}, {h(17.75), m(45), 0.95}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::BusStop: {
            // The same commuting shape as a station, at a smaller scale: a stop
            // serves a street, not a city. Most of its variation comes from the
            // transit coupling rather than from this profile.
            if (weekend) {
                static constexpr Bump w[] = {{h(11.5), h(2.5), 0.22}};
                return sum_bumps(w, std::size(w), t, 1.0);
            }
            static constexpr Bump b[] = {{h(8.1), m(28), 0.55}, {h(17.6), m(40), 0.60}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::Parking: {
            // Almost entirely coupling-driven; this is only the shape of people
            // leaving a car somewhere at all.
            static constexpr Bump b[] = {{h(9.0), h(1.5), 0.20}, {h(17.0), h(2.0), 0.25}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::Park: {
            static constexpr Bump b[] = {{h(15.0), h(2.5), 0.50}};
            return sum_bumps(b, std::size(b), t, 1.0) + (weekend ? 0.45 : 0.0);
        }
        case PlaceKind::Industrial: {
            // Shift changes, and they start early.
            if (weekend) return 1.05;
            static constexpr Bump b[] = {{h(6.5), m(40), 0.70}, {h(14.5), m(40), 0.55}, {h(22.5), m(40), 0.30}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::Residential: {
            // Kept for completeness; not modelled, so it never leaves 1.0.
            return 1.0;
        }
        case PlaceKind::Worship: {
            return 1.0;
        }
        case PlaceKind::Culture: {
            static constexpr Bump b[] = {{h(15.0), h(3.0), 0.35}, {h(20.0), h(1.5), 0.30}};
            return sum_bumps(b, std::size(b), t, 1.0) + (weekend ? 0.30 : 0.0);
        }
        case PlaceKind::Hotel: {
            static constexpr Bump b[] = {{h(8.0), h(1.0), 0.35}, {h(15.5), m(90), 0.45}};
            return sum_bumps(b, std::size(b), t, 1.0);
        }
        case PlaceKind::Other: return 1.0;
    }
    return 1.0;
}

double couple_demand(PlaceKind kind, double baseline, const DemandContext& c,
                     std::vector<DemandFactor>* factors) {
    if (!is_modelled(kind)) return 1.0;

    double value = std::max(1.0, baseline);
    const auto apply = [&](const char* name, double multiplier) {
        if (std::fabs(multiplier - 1.0) < 1e-6) return;
        value *= multiplier;
        if (factors) factors->push_back({name, multiplier});
    };

    // Displaced trips. When roads around a place are shut, the traffic that
    // would have passed elsewhere is pushed through what remains, and the
    // place sees more of it. Everything on the network feels this.
    if (c.blocked_share > 0)
        apply("closure", 1.0 + kCouplingClosure * std::clamp(c.blocked_share, 0.0, 1.0));

    // Distress response. A crash or a flood sends people to pharmacies and
    // hospitals; it does not make them go shopping.
    if (c.distress > 0 && (kind == PlaceKind::Pharmacy || kind == PlaceKind::Hospital))
        apply("distress", 1.0 + kCouplingHealth * std::clamp(c.distress, 0.0, 1.0));

    // Weather. Rain drives people indoors - into shops, cafes and stations -
    // and empties the parks. The same cause, opposite signs, which is why one
    // coefficient could not serve both.
    if (c.rain > 0) {
        const double r = std::clamp(c.rain, 0.0, 1.0);
        switch (kind) {
            case PlaceKind::Retail:
            case PlaceKind::Mall:
            case PlaceKind::Food:
            case PlaceKind::Transport:
            case PlaceKind::BusStop:
            case PlaceKind::Culture:
                apply("shelter", 1.0 + kCouplingShelter * r);
                break;
            case PlaceKind::Park:
                apply("exposure", std::max(0.2, 1.0 - kCouplingExposure * r));
                break;
            default:
                break;
        }
    }

    // Parking follows commerce. Nobody parks for its own sake: a car park is
    // busy because the shops it serves are.
    if (kind == PlaceKind::Parking && c.commercial_pull > 0)
        apply("commerce", 1.0 + kCouplingParking * std::clamp(c.commercial_pull, 0.0, 2.0));

    // Stops follow the places they serve, for the same reason.
    if (kind == PlaceKind::BusStop && c.generator_pull > 0)
        apply("transit", 1.0 + kCouplingTransit * std::clamp(c.generator_pull, 0.0, 2.0));

    return std::clamp(value, 1.0, kDemandCeiling);
}

bool is_bus_stop(const MapFeature& feature) {
    return classify_place(feature) == PlaceKind::BusStop;
}

namespace {

/// How well attested a stop is. Higher survives thinning.
int stop_rank(const MapFeature& f) {
    const auto tag = [&](const char* key) {
        const auto it = f.tags.find(key);
        return it == f.tags.end() ? std::string{} : it->second;
    };
    int rank = 0;
    // A station is a real interchange, not a kerbside pole.
    if (tag("amenity") == "bus_station" || f.category == "bus_station") rank += 8;
    // A named stop is one the operator publishes.
    if (!f.name.empty()) rank += 4;
    // A stop with a shelter or a route reference is a surveyed one.
    if (!tag("shelter").empty() || !tag("route_ref").empty() || !tag("network").empty()) rank += 2;
    if (tag("public_transport") == "station") rank += 1;
    return rank;
}

} // namespace

std::size_t thin_bus_stops(std::vector<MapFeature>& features,
                           const std::vector<std::uint64_t>& corridors,
                           StopSpacing spacing) {
    if (spacing.along_corridor_m <= 0 && spacing.duplicate_m <= 0) return 0;

    // Rank the stops without disturbing the feature order: thinning decides
    // which stops survive, not where anything sits in the list.
    std::vector<std::size_t> candidates;
    for (std::size_t i = 0; i < features.size(); ++i)
        if (is_bus_stop(features[i])) candidates.push_back(i);
    if (candidates.size() < 2) return 0;

    std::stable_sort(candidates.begin(), candidates.end(), [&](std::size_t a, std::size_t b) {
        const int ra = stop_rank(features[a]), rb = stop_rank(features[b]);
        if (ra != rb) return ra > rb;
        return features[a].id < features[b].id; // ties break deterministically
    });

    // With no corridor information every stop is treated as sharing one, which
    // applies the route spacing everywhere.
    const auto corridor_of = [&](std::size_t i) -> std::uint64_t {
        return i < corridors.size() ? corridors[i] : 0;
    };

    struct Kept { Point at; std::uint64_t corridor; std::size_t feature; };
    std::vector<Kept> kept;
    std::vector<bool> drop(features.size(), false);
    std::size_t removed = 0;
    for (const auto index : candidates) {
        const auto& here = features[index].center;
        const auto corridor = corridor_of(index);
        const bool crowded = std::any_of(kept.begin(), kept.end(), [&](const Kept& k) {
            const double gap = point_distance(k.at, here);
            // Same street: hold to route spacing. Any street: never allow two
            // stops so close that they are the same stop mapped twice.
            const auto& first=features[k.feature];
            const auto& second=features[index];
            const auto a=first.tags.find("ref"), b=second.tags.find("ref");
            const bool same_ref=a!=first.tags.end()&&b!=second.tags.end()&&!a->second.empty()&&a->second==b->second;
            const bool known_distinct=k.corridor&&corridor&&k.corridor!=corridor;
            const double limit = k.corridor == corridor ? spacing.along_corridor_m
                : known_distinct&&!same_ref ? 0.0 : spacing.duplicate_m;
            return gap < limit;
        });
        if (crowded) {
            drop[index] = true;
            ++removed;
        } else {
            kept.push_back({here, corridor, index});
        }
    }
    if (removed == 0) return 0;

    std::vector<MapFeature> survivors;
    survivors.reserve(features.size() - removed);
    for (std::size_t i = 0; i < features.size(); ++i)
        if (!drop[i]) survivors.push_back(std::move(features[i]));
    features = std::move(survivors);
    return removed;
}

} // namespace dstns
