// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The demand model: diurnal profiles, place classification, and the couplings
// that make the network behave as a system rather than a set of schedules.
#include "dstns/demand.hpp"
#include "dstns/events.hpp"
#include "dstns/scenario.hpp"
#include "dstns/graph.hpp"

#include <cmath>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using namespace dstns;

int failures = 0;
void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "  FAIL: " << message << '\n';
        ++failures;
    }
}

constexpr double h(double hours) { return hours * 3600.0; }

MapFeature tagged(std::initializer_list<std::pair<const char*, const char*>> tags,
                  const std::string& category = "") {
    MapFeature f;
    f.category = category;
    for (const auto& [k, v] : tags) f.tags[k] = v;
    return f;
}

/// Peak of a kind's profile across the day, and when it occurs.
std::pair<double, double> peak_of(PlaceKind kind, int day) {
    double best = 0, at = 0;
    for (double t = 0; t < 86400; t += 60) {
        const double v = diurnal_demand(kind, t, day);
        if (v > best) { best = v; at = t; }
    }
    return {best, at};
}

int main() {
    // ---- Classification ---------------------------------------------------
    {
        check(classify_place(tagged({{"amenity", "school"}})) == PlaceKind::School, "school by amenity");
        check(classify_place(tagged({{"amenity", "kindergarten"}})) == PlaceKind::School, "kindergarten is a school");
        check(classify_place(tagged({{"amenity", "university"}})) == PlaceKind::University, "university");
        check(classify_place(tagged({{"amenity", "pharmacy"}})) == PlaceKind::Pharmacy, "pharmacy");
        check(classify_place(tagged({{"amenity", "hospital"}})) == PlaceKind::Hospital, "hospital");
        check(classify_place(tagged({{"shop", "mall"}})) == PlaceKind::Mall, "mall by shop tag");
        check(classify_place(tagged({{"shop", "bakery"}})) == PlaceKind::Retail, "any shop is retail");
        check(classify_place(tagged({{"amenity", "cafe"}})) == PlaceKind::Food, "cafe is food");
        check(classify_place(tagged({{"amenity", "parking"}})) == PlaceKind::Parking, "parking");
        check(classify_place(tagged({{"highway", "bus_stop"}})) == PlaceKind::BusStop, "bus stop");
        check(classify_place(tagged({{"amenity", "bus_station"}})) == PlaceKind::BusStop, "bus station");
        check(classify_place(tagged({{"railway", "station"}})) == PlaceKind::Transport, "railway station");
        check(classify_place(tagged({{"leisure", "park"}})) == PlaceKind::Park, "park");
        check(classify_place(tagged({{"office", "company"}})) == PlaceKind::Office, "office");
        check(classify_place(tagged({{"amenity", "place_of_worship"}})) == PlaceKind::Worship, "worship");
        check(classify_place(tagged({{"building", "apartments"}})) == PlaceKind::Residential, "residential");
        check(classify_place(tagged({{"building", "yes"}})) == PlaceKind::Other, "an untagged building is unclassified");
        // The most specific tag wins over a generic one.
        check(classify_place(tagged({{"building", "yes"}, {"shop", "mall"}})) == PlaceKind::Mall,
              "a shop tag beats building=yes");
    }

    // ---- What is modelled -------------------------------------------------
    {
        check(!is_modelled(PlaceKind::Worship), "worship is not modelled");
        check(!is_modelled(PlaceKind::Residential), "residential is not modelled");
        check(!is_modelled(PlaceKind::Other), "unclassified is not modelled");
        check(is_modelled(PlaceKind::School) && is_modelled(PlaceKind::BusStop), "schools and stops are modelled");
        // An unmodelled place never moves, whatever happens around it.
        DemandContext hostile{1.0, 1.0, 1.0, 2.0, 2.0};
        check(couple_demand(PlaceKind::Worship, 2.0, hostile) == 1.0, "an unmodelled place stays at 1.0");
    }

    // ---- Profiles are continuous and bounded ------------------------------
    for (const auto kind : {PlaceKind::School, PlaceKind::Office, PlaceKind::Retail, PlaceKind::Mall,
                            PlaceKind::Hospital, PlaceKind::Pharmacy, PlaceKind::Food,
                            PlaceKind::Transport, PlaceKind::BusStop, PlaceKind::Parking,
                            PlaceKind::Park, PlaceKind::Industrial, PlaceKind::Culture,
                            PlaceKind::Hotel, PlaceKind::University}) {
        for (const int day : {0, 1}) {
            double previous = diurnal_demand(kind, 0, day);
            double biggest_step = 0;
            for (double t = 60; t <= 86400; t += 60) {
                const double v = diurnal_demand(kind, t, day);
                check(v >= 1.0 - 1e-9, std::string("profile never drops below 1 for ") + to_string(kind));
                check(v <= kDemandCeiling, std::string("profile stays under the ceiling for ") + to_string(kind));
                biggest_step = std::max(biggest_step, std::fabs(v - previous));
                previous = v;
            }
            // No steps: a minute may not move demand more than a few percent.
            check(biggest_step < 0.05,
                  std::string("profile is continuous for ") + to_string(kind) + " (step " + std::to_string(biggest_step) + ")");
            // Midnight joins up with itself.
            check(std::fabs(diurnal_demand(kind, 0, day) - diurnal_demand(kind, 86400, day)) < 1e-9,
                  std::string("profile wraps at midnight for ") + to_string(kind));
        }
    }

    // ---- Profiles say something true about each kind ----------------------
    {
        // A school runs in the morning and empties mid-afternoon.
        const auto [school_peak, school_at] = peak_of(PlaceKind::School, 0);
        check(school_peak > 1.5, "a weekday school has a real peak");
        check(school_at > h(7) && school_at < h(9.5), "the school peak is the morning run");
        check(peak_of(PlaceKind::School, 1).first < 1.05, "a school is quiet at the weekend");

        // An office peaks on the evening commute.
        const auto [office_peak, office_at] = peak_of(PlaceKind::Office, 0);
        check(office_peak > 1.5 && office_at > h(16), "an office peaks on the way home");

        // A hospital is never quiet.
        for (double t = 0; t < 86400; t += 600)
            check(diurnal_demand(PlaceKind::Hospital, t, 0) >= 1.1, "a hospital never goes quiet");

        // Food has two peaks, not one.
        check(diurnal_demand(PlaceKind::Food, h(12.75), 0) > 1.5, "lunch");
        check(diurnal_demand(PlaceKind::Food, h(19.5), 0) > 1.5, "dinner");
        check(diurnal_demand(PlaceKind::Food, h(16), 0) < 1.4, "the afternoon lull between them");

        // Parks and industry pull in opposite directions across the week.
        check(peak_of(PlaceKind::Park, 1).first > peak_of(PlaceKind::Park, 0).first,
              "parks are busier at the weekend");
        check(peak_of(PlaceKind::Industrial, 0).first > peak_of(PlaceKind::Industrial, 1).first,
              "industry is busier on a weekday");
        check(peak_of(PlaceKind::Industrial, 0).second < h(9), "the industrial peak is an early shift");
    }

    // ---- Stop topology ----------------------------------------------------
    {
        // A stop at a given position, with optional name and station status.
        auto stop = [](const std::string& id, double x, double y,
                       const std::string& name = "", bool station = false) {
            MapFeature f;
            f.id = id;
            f.name = name;
            f.center = Point{x, y, 0, 0};
            f.geometry = {f.center};
            f.tags[station ? "amenity" : "highway"] = station ? "bus_station" : "bus_stop";
            f.category = station ? "bus_station" : "bus_stop";
            return f;
        };

        check(is_bus_stop(stop("a", 0, 0)), "a bus stop is recognised");
        check(!is_bus_stop(tagged({{"shop", "mall"}})), "a mall is not a bus stop");

        // Two kerbs of one road: eight metres apart, one place on the ground.
        {
            std::vector<MapFeature> f{stop("node/1", 0, 0), stop("node/2", 8, 0)};
            check(thin_bus_stops(f) == 1, "a facing pair collapses to one stop");
            check(f.size() == 1, "one stop remains");
        }

        // Stops a realistic distance apart are both real stops.
        {
            std::vector<MapFeature> f{stop("node/1", 0, 0), stop("node/2", 450, 0)};
            check(thin_bus_stops(f) == 0, "properly spaced stops are both kept");
        }

        // Nothing retained ends up closer than the spacing.
        {
            std::vector<MapFeature> f;
            for (int i = 0; i < 40; ++i) f.push_back(stop("node/" + std::to_string(i), i * 55.0, 0));
            thin_bus_stops(f);
            check(f.size() > 1, "a long corridor keeps several stops");
            for (std::size_t i = 0; i < f.size(); ++i)
                for (std::size_t j = i + 1; j < f.size(); ++j)
                    check(point_distance(f[i].center, f[j].center) >= kBusStopSpacingM - 1e-9,
                          "no two retained stops are closer than the spacing");
        }

        // The better-attested stop is the one that survives a cluster.
        {
            std::vector<MapFeature> f{stop("node/1", 0, 0), stop("node/2", 10, 0, "Hauptbahnhof")};
            thin_bus_stops(f);
            check(f.size() == 1 && f[0].name == "Hauptbahnhof", "the named stop outlives the unnamed one");

            std::vector<MapFeature> g{stop("node/1", 0, 0, "Stop"), stop("node/2", 10, 0, "Station", true)};
            thin_bus_stops(g);
            check(g.size() == 1 && g[0].name == "Station", "a station outranks a kerbside stop");
        }

        // Determinism: identical input thins identically, and input order does
        // not decide the winner - rank and id do.
        {
            std::vector<MapFeature> a{stop("node/1", 0, 0), stop("node/2", 10, 0), stop("node/3", 20, 0)};
            std::vector<MapFeature> b{stop("node/3", 20, 0), stop("node/2", 10, 0), stop("node/1", 0, 0)};
            thin_bus_stops(a);
            thin_bus_stops(b);
            check(a.size() == b.size(), "thinning is order-independent in count");
            check(!a.empty() && !b.empty() && a[0].id == b[0].id, "the same stop survives either ordering");
            check(a[0].id == "node/1", "the lowest id breaks a rank tie");
        }

        // Thinning touches only stops. Two shops on top of each other are two
        // shops, and surviving features keep their original relative order.
        {
            std::vector<MapFeature> f{tagged({{"shop", "bakery"}}), tagged({{"shop", "butcher"}}),
                                      stop("node/1", 0, 0), stop("node/2", 5, 0)};
            f[0].id = "way/1"; f[1].id = "way/2";
            const auto removed = thin_bus_stops(f);
            check(removed == 1, "only the duplicate stop is removed");
            check(f.size() == 3, "both shops survive");
            check(f[0].id == "way/1" && f[1].id == "way/2", "other features keep their order");
        }

        // Corridors: spacing is a property of a route, not of the map.
        {
            // Two stops 150 m apart on the same street are one stop mapped twice.
            std::vector<MapFeature> same{stop("node/1", 0, 0), stop("node/2", 150, 0)};
            check(thin_bus_stops(same, {7, 7}) == 1, "150 m apart on one street is one stop");

            // The same two stops on parallel streets are two real stops.
            std::vector<MapFeature> across{stop("node/1", 0, 0), stop("node/2", 150, 0)};
            check(thin_bus_stops(across, {7, 9}) == 0, "150 m apart on two streets is two stops");

            std::vector<MapFeature> close_parallel{stop("node/11", 0, 0), stop("node/12", 0, 40)};
            check(thin_bus_stops(close_parallel, {7,9}) == 0, "valid stops 40 m apart on parallel streets survive");

            // But a duplicate is a duplicate whatever corridor it claims: two
            // nodes 8 m apart are the same pole however they are tagged.
            std::vector<MapFeature> kerbs{stop("node/1", 0, 0), stop("node/2", 8, 0)};
            kerbs[0].tags["ref"]="shared-stop"; kerbs[1].tags["ref"]="shared-stop";
            check(thin_bus_stops(kerbs, {7, 9}) == 1, "facing kerbs merge across corridors");

            // A route's stops still thin along it even when a cross street's
            // stop sits between them.
            std::vector<MapFeature> mixed{stop("node/1", 0, 0), stop("node/2", 120, 0),
                                          stop("node/3", 240, 0)};
            check(thin_bus_stops(mixed, {7, 9, 7}) == 1, "the cross-street stop survives, the route pair does not");
            check(mixed.size() == 2, "two stops remain");

            // Missing corridor data falls back to the strictest reading rather
            // than silently letting everything through.
            std::vector<MapFeature> unknown{stop("node/1", 0, 0), stop("node/2", 150, 0)};
            check(thin_bus_stops(unknown, {}) == 1, "no corridor data applies route spacing");
        }

        // Degenerate input is handled rather than crashing.
        {
            std::vector<MapFeature> empty;
            check(thin_bus_stops(empty) == 0, "an empty extract thins to nothing");
            std::vector<MapFeature> one{stop("node/1", 0, 0)};
            check(thin_bus_stops(one) == 0 && one.size() == 1, "a lone stop is kept");
            std::vector<MapFeature> pair{stop("node/1", 0, 0), stop("node/2", 1, 0)};
            check(thin_bus_stops(pair, {}, StopSpacing{0.0, 0.0}) == 0, "a zero spacing thins nothing");
        }
    }

    // ---- Couplings: each one alone ---------------------------------------
    {
        const DemandContext calm{};
        check(couple_demand(PlaceKind::Retail, 1.5, calm) == 1.5, "a calm network leaves the baseline alone");

        // A closure pushes displaced traffic onto what remains.
        DemandContext blocked{};
        blocked.blocked_share = 0.5;
        check(couple_demand(PlaceKind::Retail, 1.0, blocked) > 1.0, "a nearby closure raises demand");
        check(couple_demand(PlaceKind::School, 1.0, blocked) > 1.0, "closure displacement applies to every kind");

        // Distress sends people to pharmacies and hospitals, not to the shops.
        DemandContext hurt{};
        hurt.distress = 1.0;
        check(couple_demand(PlaceKind::Pharmacy, 1.0, hurt) > 1.3, "an incident raises pharmacy demand");
        check(couple_demand(PlaceKind::Hospital, 1.0, hurt) > 1.3, "an incident raises hospital demand");
        check(couple_demand(PlaceKind::Mall, 1.0, hurt) == 1.0, "an incident does not send people shopping");

        // Rain drives people indoors and empties the parks.
        DemandContext wet{};
        wet.rain = 1.0;
        check(couple_demand(PlaceKind::Retail, 1.0, wet) > 1.0, "rain drives people into shops");
        check(couple_demand(PlaceKind::BusStop, 1.0, wet) > 1.0, "rain puts people at the stop");
        check(couple_demand(PlaceKind::Park, 1.2, wet) < 1.2, "rain empties the park");
        check(couple_demand(PlaceKind::Park, 1.2, wet) >= 1.0, "a park's demand never goes below the floor");
        check(couple_demand(PlaceKind::Office, 1.0, wet) == 1.0, "rain does not change whether people go to work");

        // Parking follows commerce; stops follow what they serve.
        DemandContext busy_shops{};
        busy_shops.commercial_pull = 1.0;
        check(couple_demand(PlaceKind::Parking, 1.0, busy_shops) > 1.5, "parking fills when the shops are busy");
        check(couple_demand(PlaceKind::Office, 1.0, busy_shops) == 1.0, "busy shops do not fill an office");

        DemandContext busy_generators{};
        busy_generators.generator_pull = 1.0;
        check(couple_demand(PlaceKind::BusStop, 1.0, busy_generators) > 1.5, "a stop follows what it serves");
        check(couple_demand(PlaceKind::Parking, 1.0, busy_generators) == 1.0,
              "a car park does not follow a school run");
    }

    // ---- Couplings compound, and stay bounded -----------------------------
    {
        DemandContext everything{};
        everything.rain = 1.0;
        everything.blocked_share = 1.0;
        everything.distress = 1.0;
        const double one = couple_demand(PlaceKind::Retail, 1.0, DemandContext{.rain = 1.0});
        const double both = couple_demand(PlaceKind::Retail, 1.0, everything);
        check(both > one, "independent pressures compound");
        check(both <= kDemandCeiling + 1e-9, "however they compound, the ceiling holds");

        // Even an absurd baseline cannot exceed the ceiling.
        check(couple_demand(PlaceKind::Retail, 99.0, everything) <= kDemandCeiling + 1e-9,
              "the ceiling holds against any baseline");
        check(couple_demand(PlaceKind::Retail, 0.1, DemandContext{}) >= 1.0,
              "a baseline below the floor is lifted to it");
    }

    // ---- A figure can be explained ---------------------------------------
    {
        std::vector<DemandFactor> factors;
        DemandContext wet_and_blocked{};
        wet_and_blocked.rain = 0.8;
        wet_and_blocked.blocked_share = 0.4;
        const double value = couple_demand(PlaceKind::Retail, 1.2, wet_and_blocked, &factors);
        check(factors.size() == 2, "each contributing coupling is recorded");
        double product = 1.2;
        for (const auto& f : factors) {
            check(f.name != nullptr && *f.name, "every factor is named");
            product *= f.multiplier;
        }
        check(std::fabs(product - value) < 1e-9, "the factors multiply out to the figure shown");

        factors.clear();
        (void)couple_demand(PlaceKind::Retail, 1.2, DemandContext{}, &factors);
        check(factors.empty(), "a calm network records no factors");
    }

    // ---- End to end: couplings move a real scenario -----------------------
    {
        ScenarioConfig cfg;
        cfg.osm_file = "data/fixtures/real_network.osm.xml";
        cfg.playback_duration_s = 3600;
        const auto scenario = ScenarioCompiler{}.compile(Seed128::parse("0x4cafe"), cfg);

        EventRuntime runtime;
        runtime.initialize(scenario);
        check(runtime.place_kinds().size() == scenario.features.size(), "every feature is classified");

        // Run into the morning so the schedule has raised some baselines.
        (void)runtime.advance(scenario, 30600);
        std::vector<EdgeDynamic> edges(scenario.edges.size());

        runtime.recouple(scenario, edges, 30600);
        for(int tick=0;tick<8;++tick)runtime.recouple(scenario,edges,30600);
        std::vector<double> calm = runtime.demand;

        // Now shut everything and flood it, and look again.
        for (auto& e : edges) {
            e.closed = true;
            e.incident_closed = true;
            e.rainfall = 1.0;
            e.flood = 1.0;
        }
        runtime.recouple(scenario, edges, 30600);

        std::size_t raised = 0;
        for (std::size_t i = 0; i < calm.size(); ++i)
            if (runtime.demand[i] > calm[i] + 1e-6) ++raised;
        check(raised > 0, "a network in trouble raises demand somewhere");

        // And every figure stays inside the model's bounds.
        for (const double d : runtime.demand)
            check(d >= 1.0 && d <= kDemandCeiling, "coupled demand stays within bounds");

        // Returning to calm returns the figures - but not in one step. Parking
        // and stops follow their neighbours from the previous tick, so the
        // response is deliberately lagged and takes a few ticks to unwind.
        for (auto& e : edges) e = EdgeDynamic{};
        runtime.recouple(scenario, edges, 30600);
        bool immediate = true;
        for (std::size_t i = 0; i < calm.size(); ++i)
            if (std::fabs(runtime.demand[i] - calm[i]) > 1e-6) immediate = false;
        check(!immediate, "followed places unwind over ticks rather than instantly");

        // A handful of ticks later it has settled back exactly.
        for (int tick = 0; tick < 8; ++tick) runtime.recouple(scenario, edges, 30600);
        for (std::size_t i = 0; i < calm.size(); ++i)
            check(std::fabs(runtime.demand[i] - calm[i]) < 1e-6,
                  "conditions clearing restores demand once the lag has unwound");

        // And it is a converged fixed point, not a drift.
        const auto settled = runtime.demand;
        runtime.recouple(scenario, edges, 30600);
        for (std::size_t i = 0; i < settled.size(); ++i)
            check(std::fabs(runtime.demand[i] - settled[i]) < 1e-9,
                  "a settled network stays settled");
    }

    // Every modelled kind participates even without the legacy four-kind tag.
    {
        Scenario s;
        s.config.buildings = true;
        s.nodes.resize(4);
        for (std::size_t i=0;i<s.nodes.size();++i) { s.nodes[i].id={static_cast<std::uint32_t>(i)}; s.nodes[i].position={double(i)*60,0,0,0}; }
        for (std::uint32_t i=0;i<3;++i) {
            EdgeStatic e; e.id={i}; e.from={i==2?2u:0u}; e.to={i==2?3u:i+1};
            e.length_m=60; s.edges.push_back(e);
        }
        auto stop=tagged({{"highway","bus_stop"}}, "bus_stop"); stop.id="stop"; stop.center={0,0,0,0};
        auto school=tagged({{"amenity","school"}}, "school"); school.id="school"; school.center={0,0,0,0};
        s.features={stop,school};
        EventRuntime runtime; runtime.initialize(s);
        std::vector<EdgeDynamic> edges(s.edges.size());
        runtime.recouple(s,edges,0); const auto night=runtime.demand;
        runtime.recouple(s,edges,28800); const auto morning=runtime.demand;
        check(morning[0]>night[0], "bus-stop profile changes through the day without a legacy tag");
        check(morning[1]>night[1], "school profile is sampled continuously without a legacy tag");
        const double alternate=runtime.demand_effect({1});
        edges[0].closed=true; edges[0].incident_closed=true;
        runtime.recouple(s,edges,28800);
        check(runtime.demand_effect({0})==0, "closed roads receive no place demand");
        check(runtime.demand_effect({1})>alternate, "school closure pressure moves to a reachable alternate road");
        for(auto& e:edges) e.rainfall=1;
        runtime.recouple(s,edges,28800);
        bool shelter=false;for(const auto& f:runtime.demand_factors(0))if(std::string(f.name)=="shelter")shelter=true;
        check(shelter, "bus stops respond to rain on their indexed roads");
        for(auto& e:edges) e=EdgeDynamic{};
        runtime.recouple(s,edges,72000);
        check(runtime.baseline_demand(1)<morning[1], "profiles fall again rather than retaining their morning maximum");
    }

    if (failures) {
        std::cerr << failures << " demand assertion(s) failed\n";
        return 1;
    }
    std::cout << "Demand invariants passed\n";
    return 0;
}
