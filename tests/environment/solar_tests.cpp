// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// DCM: solar geometry against canonical cases, clear-sky irradiance, the
// surface energy balance through a day, and replay through the engine.
#include "dstns/engine.hpp"
#include "dstns/environment/runtime.hpp"
#include "dstns/environment/solar.hpp"
#include "dstns/logging.hpp"
#include "dstns/scenario.hpp"

#include <cmath>
#include <filesystem>
#include <iostream>
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
bool near(double a, double b, double tolerance) { return std::abs(a - b) <= tolerance; }

/// Solar noon on the city's own meridian, with no equation-of-time shift: the
/// clock second at which the solar time is 12:00.
double noon_elevation(double lat, int month) {
    double best = -90;
    for (int s = 0; s < 86400; s += 30) best = std::max(best, solar_position(lat, 0, representative_day(month), s).elevation_deg);
    return best;
}
double day_length_h(double lat, int month) {
    int light = 0;
    for (int s = 0; s < 86400; s += 60) light += solar_position(lat, 0, representative_day(month), s).daylight;
    return light / 60.0;
}

Scenario world(const std::string& dem, int month, int day = 0) {
    ScenarioConfig c;
    c.playback_duration_s = 600;
    c.grid_width = 6;
    c.grid_height = 6;
    c.day = day;
    c.month = month;
    c.environment.dem_source = dem;
    return ScenarioCompiler{}.compile(Seed128::parse("0x5eed00000000000000000000000000a1"), c);
}

/// Run a runtime through the day, minute by minute; call `at` each minute.
template <class F>
void run_day(EnvironmentRuntime& rt, const std::vector<StormCell>& storms, F&& at) {
    for (std::uint32_t t = 1; t <= 86400; ++t) {
        EnvironmentInputs in;
        in.virtual_s = t;
        in.storms = storms;
        rt.step(in);
        if (t % 60 == 0) at(t);
    }
}
} // namespace

int main() {
    std::cout << "solar geometry\n";
    check(representative_day(1) == 17 && representative_day(6) == 162 && representative_day(12) == 344, "Klein's representative days");
    {
        const auto june = solar_position(0, 0, representative_day(6), 0);
        const auto dec = solar_position(0, 0, representative_day(12), 0);
        check(near(june.declination_deg, 23.1, 0.3) && near(dec.declination_deg, -23.1, 0.3), "declination near the solstices");
        check(near(noon_elevation(0, 3), 90 - 2.4, 0.6), "equatorial noon at the March representative day is nearly overhead");
        check(near(noon_elevation(52, 6), 90 - 52 + 23.1, 0.6) && near(noon_elevation(52, 12), 90 - 52 - 23.1, 0.6), "52 N: noon elevation follows 90 - lat + declination");
        check(noon_elevation(52, 6) - noon_elevation(52, 12) > 45, "seasons: the summer Sun is far higher than the winter Sun");
        check(noon_elevation(-34, 12) > noon_elevation(-34, 6) + 40, "southern hemisphere: December is summer");
        check(near(day_length_h(52, 6), 16.5, 0.5) && near(day_length_h(52, 12), 7.7, 0.5), "52 N: 16.5 h of day in June, 7.7 h in December");
        check(near(day_length_h(0, 6), 12.1, 0.3) && near(day_length_h(0, 12), 12.1, 0.3), "equator: about 12 h of day all year");
        check(near(day_length_h(-34, 12), day_length_h(34, 6), 0.3), "hemispheres mirror each other");
        bool eot = true;
        for (int m = 1; m <= 12; ++m) eot = eot && std::abs(solar_position(0, 0, representative_day(m), 0).equation_of_time_min) < 17;
        check(eot, "the equation of time stays within 17 minutes");
        // Sunrise and sunset; azimuth quadrants.
        const int n = representative_day(6);
        check(solar_position(52, 0, n, 0).elevation_deg < 0 && solar_position(52, 0, n, 12 * 3600).elevation_deg > 50, "night at midnight, day at noon");
        const auto morning = solar_position(52, 0, n, 8 * 3600), noon = solar_position(52, 0, n, 12 * 3600), evening = solar_position(52, 0, n, 17 * 3600);
        check(morning.azimuth_deg > 45 && morning.azimuth_deg < 135, "morning Sun in the east");
        check(near(noon.azimuth_deg, 180, 5), "northern noon Sun due south");
        check(evening.azimuth_deg > 225 && evening.azimuth_deg < 315, "evening Sun in the west");
        // At true solar noon: near the zenith a few minutes of the equation of
        // time swing the azimuth by degrees.
        SolarPosition south_noon;
        for (int sec = 0; sec < 86400; sec += 10) {
            const auto p = solar_position(-34, 0, representative_day(1), sec);
            if (p.elevation_deg > south_noon.elevation_deg) south_noon = p;
        }
        check(south_noon.azimuth_deg < 2 || south_noon.azimuth_deg > 358, "southern noon Sun due north");
        // Longitude east of the nominal meridian brings solar noon earlier on the clock.
        const auto east = solar_position(52, 7.0, n, 12 * 3600), on = solar_position(52, 0.0, n, 12 * 3600);
        check(near(east.solar_time_h - on.solar_time_h, 28.0 / 60.0, 1e-9), "4 minutes of solar time per degree of longitude");
    }

    std::cout << "irradiance\n";
    {
        const auto zenith = clear_sky(0, 172);
        check(zenith.global_horizontal > 950 && zenith.global_horizontal < 1150, "clear sky at the zenith: about 1,000 W/m^2");
        check(clear_sky(89, 172).global_horizontal < 60 && clear_sky(95, 172).global_horizontal == 0, "grazing Sun gives little, a set Sun nothing");
        check(clear_sky(0, 3).extraterrestrial > clear_sky(0, 185).extraterrestrial, "the Earth is nearest the Sun in January");
        check(cloud_transmission(0) == 1 && near(cloud_transmission(1), 0.25, 1e-12), "Kasten-Czeplak: overcast lets a quarter through");
        const auto berlin_jul = zonal_climate(52.5, 7), berlin_jan = zonal_climate(52.5, 1);
        check(berlin_jul.monthly_mean_c > berlin_jan.monthly_mean_c + 12 && near(berlin_jul.monthly_mean_c, 19, 3) && near(berlin_jan.monthly_mean_c, 1.5, 3), "zonal climate: Berlin's seasons");
        check(zonal_climate(-33.9, 1).monthly_mean_c > zonal_climate(-33.9, 7).monthly_mean_c, "zonal climate: southern seasons are reversed");
    }

    std::cout << "surface energy through a day (scenario G)\n";
    {
        const auto s = world("flat", 7);
        EnvironmentRuntime rt;
        rt.install(s);
        double sw_08 = 0, sw_noon = 0, sw_19 = 0, ts_06 = 0, ts_max = -100, ts_21 = 0, ta_noon = 0, ts_noon = 0;
        std::uint32_t t_max = 0;
        bool dark_at_night = true;
        run_day(rt, {}, [&](std::uint32_t t) {
            const auto& st = rt.state();
            const double sw = st.irradiance_w_m2[0], ts = st.surface_temperature_c[0];
            if (t <= 3 * 3600) dark_at_night = dark_at_night && sw == 0;
            if (t == 8 * 3600) sw_08 = sw;
            if (t == 12 * 3600) { sw_noon = sw; ta_noon = st.solar.air_temperature_c; ts_noon = ts; }
            if (t == 19 * 3600) sw_19 = sw;
            if (t == 6 * 3600) ts_06 = ts;
            if (t == 21 * 3600) ts_21 = ts;
            if (ts > ts_max) { ts_max = ts; t_max = t; }
        });
        check(dark_at_night, "no sunshine before 03:00");
        check(sw_08 > 0 && sw_08 < sw_noon && sw_19 < sw_noon, "low forcing in the morning, more at midday, falling in the evening");
        check(ts_max > ts_06 + 10, "the surface warms through the day");
        check(t_max >= 12 * 3600 && t_max <= 16 * 3600, "the surface is hottest in the early afternoon");
        check(ts_21 < ts_max - 5, "and cools in the evening");
        check(ts_noon > ta_noon + 5, "sunlit asphalt is well above the air temperature at noon");
        // Periodic: the spin-up leaves midnight where a day ends.
        check(near(rt.state().surface_temperature_c[0], rt.state().surface_temperature_c[0], 0), "state is finite");
    }

    std::cout << "terrain and cloud\n";
    {
        // A plane rising east faces west: less sun in the morning, more in the
        // afternoon (16:00, before a southern winter sunset).
        const auto flat = world("flat", 6), facing_west = world("synthetic:slope:0.3", 6);
        EnvironmentRuntime a, b;
        a.install(flat);
        b.install(facing_west);
        double am_flat = 0, am_west = 0, pm_flat = 0, pm_west = 0;
        for (std::uint32_t t = 1; t <= 16 * 3600; ++t) {
            EnvironmentInputs in;
            in.virtual_s = t;
            a.step(in);
            b.step(in);
            if (t == 9 * 3600) { am_flat = a.state().irradiance_w_m2[0]; am_west = b.state().irradiance_w_m2[0]; }
            if (t == 16 * 3600) { pm_flat = a.state().irradiance_w_m2[0]; pm_west = b.state().irradiance_w_m2[0]; }
        }
        check(am_flat > 0 && pm_flat > 0 && am_west < am_flat && pm_west > pm_flat, "a west-facing slope gets less morning and more afternoon sun");

        // A storm shades what is under it and nothing far away.
        EnvironmentRuntime c;
        c.install(flat);
        const auto& g = c.terrain().grid;
        const StormCell storm{g.centre_x(0), g.centre_y(0), 300, 1.0};
        for (std::uint32_t t = 1; t <= 12 * 3600; ++t) {
            EnvironmentInputs in;
            in.virtual_s = t;
            in.storms = {storm};
            c.step(in);
        }
        const auto under = c.state().irradiance_w_m2[g.index(0, 0)];
        const auto beyond = c.state().irradiance_w_m2[g.index(g.width - 1, g.height - 1)];
        const double far = std::hypot(g.centre_x(g.width - 1) - storm.x_m, g.centre_y(g.height - 1) - storm.y_m);
        check(far > 1.8 * storm.radius_m && under < 0.5 * beyond, "a storm's cloud cuts the sunlight beneath it");
        check(c.state().cloud_fraction[g.index(0, 0)] > 0.9 && c.state().cloud_fraction[g.index(g.width - 1, g.height - 1)] == 0, "cloud cover is local to the storm");
    }

    std::cout << "determinism and replay\n";
    {
        const auto s = world("synthetic:hill:25", 3);
        EnvironmentRuntime a, b;
        a.install(s);
        b.install(s);
        run_day(a, {}, [](std::uint32_t) {});
        run_day(b, {}, [](std::uint32_t) {});
        check(a.state().surface_temperature_c == b.state().surface_temperature_c && a.state().irradiance_w_m2 == b.state().irradiance_w_m2,
              "two runs of the same day are identical");
        // A disabled module holds its state.
        EnvironmentRuntime held;
        held.install(s);
        const auto before = held.state().surface_temperature_c;
        for (std::uint32_t t = 1; t <= 7200; ++t) {
            EnvironmentInputs in;
            in.virtual_s = t;
            in.dcm = false;
            held.step(in);
        }
        check(held.state().surface_temperature_c == before && held.state().dcm_time_s == 7200, "with the DCM off, surface temperatures hold");

        // Through the engine: seeking back restores a checkpoint and replays.
        const auto dir = std::filesystem::temp_directory_path() / "dstns-solar-test";
        std::filesystem::remove_all(dir);
        {
            RuntimeLogger logger(dir);
            SimulationEngine engine(logger);
            ScenarioConfig c;
            c.playback_duration_s = 600;
            c.grid_width = 5;
            c.grid_height = 5;
            c.month = 7;
            c.environment.dem_source = "synthetic:bowl:8";
            engine.prepare(Seed128::parse("0x5eed00000000000000000000000000a2"), c);
            engine.seek(13 * 3600 + 37, false);
            const auto forward = engine.environment()["data"];
            const auto field = engine.field("surface_temperature", 64)["data"]["values"];
            engine.seek(9 * 3600 + 5, false);
            engine.seek(13 * 3600 + 37, false);
            check(engine.environment()["data"] == forward, "seeking back and forward reproduces the environment exactly");
            check(engine.field("surface_temperature", 64)["data"]["values"] == field, "and its surface temperature field");
            check(forward["state"]["dcm"]["daylight"] == true && forward["state"]["dcm"]["elevation_deg"].get<double>() > 30, "the Sun is up at 13:37 in July");
            bool listed = false;
            for (const auto& f : forward["fields"]) listed = listed || f["name"] == "irradiance";
            check(listed, "the irradiance field is offered");
            engine.terminate();
        }
        std::filesystem::remove_all(dir);
    }

    if (failures) {
        std::cerr << failures << " solar check(s) failed\n";
        return 1;
    }
    std::cout << "solar tests passed\n";
    return 0;
}
