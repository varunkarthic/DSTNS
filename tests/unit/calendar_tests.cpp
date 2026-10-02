// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The deterministic calendar and constrained seed generation.
//
// A seed alone fixes the location, month and day type; a constrained seed is
// an ordinary seed found by search, never an override. The golden values below
// were recorded from the build before the calendar existed: they prove that
// adding new random streams did not move any existing one.
#include "dstns/calendar.hpp"
#include "dstns/geo.hpp"
#include "dstns/scenario.hpp"

#include <array>
#include <chrono>
#include <iostream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>

using namespace dstns;

namespace {
int failures = 0;
void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    } else {
        std::cout << "  ok  " << message << '\n';
    }
}
template <typename F>
bool throws(F&& f) {
    try { f(); } catch (...) { return true; }
    return false;
}

void constrained(const SeedConstraints& c, const std::string& label) {
    const auto started = std::chrono::steady_clock::now();
    const auto found = generate_constrained_seed(c, 0x0123456789ABCDEFULL);
    const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    const auto again = describe_seed(found.seed);
    bool ok = found.seed.high == 0 && found.seed.low != 0;
    if (c.city_index) ok = ok && again.city_index == *c.city_index;
    if (c.month) ok = ok && again.month == *c.month;
    if (c.day) ok = ok && again.day == *c.day;
    ok = ok && again.city == found.metadata.city && again.month == found.metadata.month && again.day == found.metadata.day;
    check(ok, "constrained seed, " + label + ": the seed alone reproduces the constraints (" +
                  std::to_string(found.attempts) + " candidates, " + std::to_string(ms) + " ms)");
    const auto repeat = generate_constrained_seed(c, 0x0123456789ABCDEFULL);
    check(repeat.seed == found.seed, "constrained seed, " + label + ": the search is reproducible from its start");
}
} // namespace

int main() {
    std::cout << "golden: existing streams are unchanged\n";
    {
        const std::array<std::pair<std::uint64_t, const char*>, 5> golden{{
            {1, "Tashkent"}, {42, "Dar es Salaam"}, {382923, "Cape Town"}, {630294815033ULL, "Dubai"}, {9384759284ULL, "Tel Aviv"}}};
        for (const auto& [value, city] : golden) {
            check(select_map_location(Seed128{0, value}).city == city, "seed " + std::to_string(value) + " still resolves to " + city);
            check(describe_seed(Seed128{0, value}).city == city, "describe_seed agrees for " + std::to_string(value));
        }
        ScenarioConfig cfg;
        cfg.playback_duration_s = 600;
        cfg.grid_width = 7;
        cfg.grid_height = 7;
        cfg.dws_frequency = 4;
        cfg.day = 0;
        const auto seed = Seed128::parse("0xFEEDFACECAFED00D123456789ABCDEF0");
        const auto grid = ScenarioCompiler{}.compile(seed, cfg);
        check(grid.event_hash == "sha256:e3640f9df94eec6f5be4a103679c81660fe7306ba6104494237104d026b84f0c",
              "grid world: signals, weather, trips and incidents are as before");
        check(grid.graph_hash == "sha256:1c2caead21b078e3d39b8c0c6d6dc4e491b7681610d784cffda144d15c681112",
              "grid world: the road graph is as before");
        cfg.osm_file = "tests/fixtures/roads.osm.xml";
        cfg.max_nodes = 50;
        const auto osm = ScenarioCompiler{}.compile(seed, cfg);
        check(osm.event_hash == "sha256:fc05d62fbac6afed505935fde03f19d220f9bb666ff3c78a0a34d88deb5e78c1",
              "OSM world: scheduled events are as before");
    }

    std::cout << "derivation\n";
    {
        const Seed128 seed{0, 630294815033ULL};
        const auto a = describe_seed(seed), b = describe_seed(seed);
        check(a.city == b.city && a.month == b.month && a.day == b.day, "same seed, same location, month and day type");
        check(a.month >= 1 && a.month <= 12, "month is in 1..12");
        // Every month and both day types are reachable, in roughly the shape
        // of the year and the week.
        std::map<int, int> months;
        int weekend = 0;
        constexpr int n = 14000;
        for (int i = 1; i <= n; ++i) {
            const Seed128 s{0, std::uint64_t(i) * 7919};
            ++months[derive_month(s)];
            weekend += derive_day_type(s) == kWeekend;
        }
        check(months.size() == 12, "all twelve months occur");
        bool even = true;
        for (const auto& [m, count] : months) even = even && count > n / 12 * 0.85 && count < n / 12 * 1.15;
        check(even, "months are drawn uniformly (within 15%)");
        check(weekend > n * 2 / 7 * 0.9 && weekend < n * 2 / 7 * 1.1, "two days in seven are weekend days");
        // The three properties come from independent streams: knowing the day
        // type says nothing about the month.
        std::map<int, int> weekend_months;
        for (int i = 1; i <= n; ++i) {
            const Seed128 s{0, std::uint64_t(i) * 7919};
            if (derive_day_type(s) == kWeekend) ++weekend_months[derive_month(s)];
        }
        bool independent = weekend_months.size() == 12;
        for (const auto& [m, count] : weekend_months) independent = independent && count > weekend / 12 * 0.75 && count < weekend / 12 * 1.25;
        check(independent, "month and day type are independent");
    }

    std::cout << "parsing\n";
    check(parse_month("July") == 7 && parse_month("jul") == 7 && parse_month("7") == 7 && parse_month("07") == 7, "months by name, abbreviation and number");
    check(!parse_month("13") && !parse_month("Juli") && !parse_month("") && !parse_month("0"), "invalid months are refused");
    check(parse_day_type("weekday") == kWeekday && parse_day_type("Weekend") == kWeekend && !parse_day_type("monday"), "day types");
    check(find_city("Ahmedabad").has_value() && find_city("ahmedabad") == find_city("AHMEDABAD"), "cities by name, ignoring case");
    check(find_city("sao-paulo").has_value() && !find_city("Atlantis"), "cities by slug; unknown cities refused");
    check(std::string(month_name(7)) == "July" && std::string(month_name(13)).empty(), "month names");

    std::cout << "constrained generation\n";
    {
        const auto ahmedabad = *find_city("Ahmedabad");
        constrained({ahmedabad, {}, {}}, "location only");
        constrained({{}, 7, {}}, "month only");
        constrained({{}, {}, kWeekend}, "day type only");
        constrained({ahmedabad, 7, {}}, "location and month");
        constrained({ahmedabad, {}, kWeekday}, "location and day type");
        constrained({{}, 2, kWeekend}, "month and day type");
        constrained({ahmedabad, 7, kWeekday}, "location, month and day type");
        constrained({{}, {}, {}}, "all Auto");
        check(throws([] { (void)generate_constrained_seed({{}, 13, {}}, 1); }), "an impossible month is refused");
        check(throws([] { (void)generate_constrained_seed({std::uint32_t(100000), {}, {}}, 1); }), "an unknown location is refused");
        check(throws([] { (void)generate_constrained_seed({0, 1, kWeekend}, 1, 3); }), "a search that runs out of candidates fails loudly");
        // Fresh entropy gives a different, still valid, seed.
        const auto fresh = generate_constrained_seed({ahmedabad, 7, kWeekday});
        const auto meta = describe_seed(fresh.seed);
        check(meta.city == "Ahmedabad" && meta.month == 7 && meta.day == kWeekday, "a freshly generated constrained seed is valid");
        // Benchmark the fully constrained search.
        constexpr int runs = 20;
        std::uint64_t attempts = 0;
        const auto started = std::chrono::steady_clock::now();
        for (int i = 0; i < runs; ++i) attempts += generate_constrained_seed({ahmedabad, 7, kWeekday}, 0xABCDEF00ULL * (i + 1)).attempts;
        const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        std::cout << "  fully constrained search: mean " << attempts / runs << " candidates, " << ms / runs << " ms\n";
        check(ms / runs < 2000, "a fully constrained search completes interactively");
    }

    if (failures) {
        std::cerr << failures << " calendar check(s) failed\n";
        return 1;
    }
    std::cout << "calendar tests passed\n";
    return 0;
}
