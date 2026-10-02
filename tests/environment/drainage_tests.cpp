// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// DDS: the synthetic drainage network, inlet hydraulics, routing to the
// outfalls, finite capacity and surcharge (scenario B), and the exact
// exchange of water between street and pipe.
#include "dstns/environment/drainage.hpp"
#include "dstns/environment/runtime.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
#include <iostream>
#include <set>
#include <string>

using namespace dstns;
using namespace dstns::env;

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

Scenario world(const std::string& dem, std::uint32_t side = 9) {
    ScenarioConfig c;
    c.playback_duration_s = 600;
    c.grid_width = side;
    c.grid_height = side;
    c.day = 0;
    c.month = 5;
    c.dws_frequency = 0;
    c.environment.dem_source = dem;
    return ScenarioCompiler{}.compile(Seed128::parse("0x5eed00000000000000000000000000e1"), c);
}

struct Outcome {
    double street_m3{}, drains_m3{}, outfall_m3{}, rain_m3{}, peak_utilisation{}, backflow_m3{}, inflow_m3{};
    std::uint32_t peak_surcharged{};
    bool balanced{true};
};

/// Rain at `mm_h` over the whole district for `minutes`, then an hour of settling.
Outcome storm(const Scenario& s, double mm_h, int minutes, bool drainage = true, double design_mm_h = 25) {
    EnvironmentRuntime rt;
    HydrologyParams hp;
    hp.rain_peak_mm_h = mm_h;
    DrainageParams dp;
    dp.design_rain_mm_h = design_mm_h;
    rt.install(s, {}, hp, nullptr, dp);
    const auto& g = rt.terrain().grid;
    const StormCell everywhere{g.origin_x_m + g.width * g.cell_m / 2, g.origin_y_m + g.height * g.cell_m / 2, 1e6, 1.0};
    Outcome o;
    for (std::uint32_t t = 1; t <= std::uint32_t(minutes + 60) * 60; ++t) {
        EnvironmentInputs in;
        in.virtual_s = 10 * 3600 + t;
        in.dcm = false;
        in.drainage = drainage;
        if (t <= std::uint32_t(minutes) * 60) in.storms = {everywhere};
        rt.step(in);
        if (t % 5 == 0) {
            const auto summary = rt.summary();
            o.balanced = o.balanced && summary["water_system"]["conservation_error_m3"].get<double>() == 0.0 &&
                         summary["drainage"]["conservation_error_m3"].get<double>() == 0.0;
            o.peak_utilisation = std::max(o.peak_utilisation, summary["drainage"]["peak_utilisation"].get<double>());
        }
    }
    const auto summary = rt.summary();
    o.street_m3 = summary["water_system"]["on_streets_m3"];
    o.drains_m3 = summary["water_system"]["in_drains_m3"];
    o.outfall_m3 = summary["drainage"]["outfall_m3"];
    o.rain_m3 = summary["water_system"]["rain_m3"];
    o.backflow_m3 = summary["drainage"]["backflow_m3"];
    o.inflow_m3 = summary["drainage"]["inflow_m3"];
    o.peak_surcharged = summary["drainage"]["peak_surcharged_nodes"];
    return o;
}
} // namespace

int main() {
    std::cout << "the synthetic network\n";
    {
        const auto s = world("synthetic:slope:0.02");
        EnvironmentRuntime rt;
        rt.install(s);
        const auto& net = rt.drainage();
        const auto& p = rt.drainage_params();
        check(net.source == "synthetic", "the network says it is synthetic");
        check(net.nodes.size() == s.nodes.size(), "a manhole at every junction");
        double grates = 0, street = 0;
        for (const auto& inlet : net.inlets) grates += inlet.grates;
        for (const auto& e : s.edges) street += e.from.value < e.to.value ? e.length_m : 0;
        check(std::abs(grates - 2 * street / p.inlet_spacing_m) < 1e-6 * grates, "a grate every 50 m on each kerb of every street");
        std::vector<int> downstream(net.nodes.size(), 0);
        for (const auto& pipe : net.pipes) ++downstream[pipe.from];
        bool tree = true, cover = true, standard = true;
        for (std::size_t i = 0; i < net.nodes.size(); ++i) {
            tree = tree && downstream[i] == (net.nodes[i].outfall ? 0 : 1);
            cover = cover && net.nodes[i].invert_m <= net.nodes[i].ground_m - p.min_cover_m + 1e-9;
        }
        const std::set<double> sizes{0.30, 0.375, 0.45, 0.525, 0.60, 0.675, 0.75, 0.90, 1.05, 1.20, 1.35, 1.50, 1.80, 2.40};
        for (const auto& pipe : net.pipes) standard = standard && sizes.contains(pipe.diameter_m);
        check(tree, "every junction drains through exactly one pipe, outfalls through none");
        check(cover, "every pipe lies at least the minimum cover below the street");
        check(standard, "diameters are standard sizes");
        bool falls = true;
        for (const auto& pipe : net.pipes) falls = falls && pipe.slope >= p.min_slope - 1e-12;
        check(falls, "every pipe falls towards its outfall by at least the minimum slope");
        // Following the pipes from anywhere reaches an outfall.
        std::vector<std::int64_t> next(net.nodes.size(), -1);
        for (const auto& pipe : net.pipes) next[pipe.from] = pipe.to;
        bool reaches = true;
        for (std::size_t i = 0; i < net.nodes.size(); ++i) {
            std::size_t at = i, hops = 0;
            while (next[at] >= 0 && hops++ <= net.nodes.size()) at = std::size_t(next[at]);
            reaches = reaches && net.nodes[at].outfall;
        }
        check(reaches, "and from every junction the pipes lead to an outfall");
        // Pipes grow downstream: a trunk is never smaller than a branch feeding it.
        bool growing = true;
        for (const auto& a : net.pipes)
            for (const auto& b : net.pipes)
                if (b.from == a.to) growing = growing && b.diameter_m >= a.diameter_m;
        check(growing, "pipes never narrow downstream");
    }

    std::cout << "inlet hydraulics\n";
    {
        DrainageNetwork net;
        net.cell_area_m2 = 625;
        DrainNode node;
        node.cell = 0;
        node.ground_m = 10;
        node.invert_m = 8.5;
        node.crown_m = 9.1;
        node.shaft_area_m2 = 1.1;
        node.pipe_volume_m3 = 2;
        net.nodes = {node};
        net.inlets = {{0, 0, 2.0}};
        DrainageParams p;
        auto st = initial_drainage(net);
        const auto capture = [&](double depth) {
            std::vector<std::int32_t> h{static_cast<std::int32_t>(depth * 16777216)}, drain{0};
            const auto x = inlet_exchange(net, p, st, h, 1.0, drain);
            return double(x[0]) * net.cell_area_m2 / 16777216;
        };
        const double shallow = capture(0.01), deeper = capture(0.04);
        check(std::abs(deeper / shallow - 8.0) < 0.2, "shallow water enters as over a weir: four times the depth, eight times the flow");
        const double weir = 2 * p.weir_coefficient * p.grate_perimeter_m * std::pow(0.5, 1.5);
        const double orifice = 2 * p.orifice_coefficient * p.grate_area_m2 * std::sqrt(2 * 9.81 * 0.5);
        check(std::abs(capture(0.5) - std::min(weir, orifice)) < 0.01 && orifice < weir, "deep water is limited by the grate's orifice");
        check(capture(0.0) == 0.0, "a dry street gives nothing");
        // A tiny puddle cannot give more than it holds.
        std::vector<std::int32_t> h{1000}, drain{0};
        const auto x = inlet_exchange(net, p, st, h, 5.0, drain);
        check(x[0] <= 1000 && drain[0] == x[0], "an inlet never takes more than the street holds");
        // Surcharged above the street: water comes back out.
        st.volume[0] = static_cast<std::int64_t>(30.0 / net.cell_area_m2 * 16777216);
        std::vector<std::int32_t> dry{0}, back{0};
        const auto y = inlet_exchange(net, p, st, dry, 1.0, back);
        check(node_head(net.nodes[0], net, st.volume[0]) > node.ground_m && y[0] < 0 && back[0] == y[0], "a surcharged network backflows onto the street");
    }

    std::cout << "routing, capacity and surcharge (scenario B)\n";
    {
        const auto s = world("synthetic:slope:0.01", 10);
        const auto light = storm(s, 15, 30);                 // below the 25 mm/h design
        const auto heavy = storm(s, 60, 30);                 // beyond it
        const auto undersized = storm(s, 60, 30, true, 3);   // the same storm, pipes sized for 3 mm/h
        const auto none = storm(s, 60, 30, false);
        const auto line = [](const char* label, const Outcome& o) {
            std::cout << "      " << label << ": rain " << o.rain_m3 << " m3, into drains " << o.inflow_m3 << ", backflow " << o.backflow_m3
                      << ", outfall " << o.outfall_m3 << ", on the street " << o.street_m3 << "; peak utilisation " << o.peak_utilisation
                      << ", " << o.peak_surcharged << " manholes surcharged\n";
        };
        line("15 mm/h, design 25", light);
        line("60 mm/h, design 25", heavy);
        line("60 mm/h, design 3 ", undersized);
        line("60 mm/h, no drains", none);
        check(light.balanced && heavy.balanced && undersized.balanced && none.balanced, "street and pipes together balance exactly at every step, in every run");
        check(light.outfall_m3 > 0.15 * light.rain_m3, "drains carry a good share of a light storm to the outfalls");
        check(light.peak_surcharged == 0 && light.peak_utilisation < 1.0, "below the design storm no pipe fills and no manhole surcharges");
        check(undersized.peak_utilisation > 1.0 && undersized.peak_surcharged > 0, "an undersized network reaches capacity and surcharges");
        check(undersized.backflow_m3 > 0, "water backs up out of its inlets onto the street");
        check(undersized.street_m3 > heavy.street_m3, "so more water stays on the street than with adequate drains");
        check(none.street_m3 > heavy.street_m3, "and drains always take a share, compared with none");
        check(heavy.outfall_m3 <= heavy.rain_m3 && undersized.outfall_m3 <= undersized.rain_m3, "outfalls never discharge more than fell");
    }

    if (failures) {
        std::cerr << failures << " drainage check(s) failed\n";
        return 1;
    }
    std::cout << "drainage tests passed\n";
    return 0;
}
