// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/core-ng/selection.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <stdexcept>

namespace dstns::core_ng {
namespace {

// ISO 3166-1 alpha-2 for every country in the catalogue. A catalogue country missing here is a build-time mistake,
// caught by country_id() and the tests, never a silent omission.
const std::map<std::string, std::string, std::less<>> kCountryCodes{
    {"Algeria", "DZ"}, {"Argentina", "AR"}, {"Armenia", "AM"}, {"Australia", "AU"}, {"Austria", "AT"},
    {"Azerbaijan", "AZ"}, {"Bangladesh", "BD"}, {"Belgium", "BE"}, {"Brazil", "BR"}, {"Bulgaria", "BG"},
    {"Canada", "CA"}, {"Chile", "CL"}, {"China", "CN"}, {"Colombia", "CO"}, {"Costa Rica", "CR"}, {"Croatia", "HR"},
    {"Cuba", "CU"}, {"Czechia", "CZ"}, {"Denmark", "DK"}, {"Dominican Republic", "DO"}, {"Ecuador", "EC"},
    {"Egypt", "EG"}, {"Estonia", "EE"}, {"Ethiopia", "ET"}, {"Finland", "FI"}, {"France", "FR"}, {"Georgia", "GE"},
    {"Germany", "DE"}, {"Ghana", "GH"}, {"Greece", "GR"}, {"Guatemala", "GT"}, {"Hungary", "HU"}, {"India", "IN"},
    {"Indonesia", "ID"}, {"Ireland", "IE"}, {"Israel", "IL"}, {"Italy", "IT"}, {"Japan", "JP"}, {"Jordan", "JO"},
    {"Kazakhstan", "KZ"}, {"Kenya", "KE"}, {"Kuwait", "KW"}, {"Latvia", "LV"}, {"Lithuania", "LT"},
    {"Malaysia", "MY"}, {"Mexico", "MX"}, {"Morocco", "MA"}, {"Nepal", "NP"}, {"Netherlands", "NL"},
    {"New Zealand", "NZ"}, {"Nigeria", "NG"}, {"Norway", "NO"}, {"Pakistan", "PK"}, {"Panama", "PA"}, {"Peru", "PE"},
    {"Philippines", "PH"}, {"Poland", "PL"}, {"Portugal", "PT"}, {"Qatar", "QA"}, {"Romania", "RO"},
    {"Saudi Arabia", "SA"}, {"Serbia", "RS"}, {"Singapore", "SG"}, {"Slovakia", "SK"}, {"Slovenia", "SI"},
    {"South Africa", "ZA"}, {"South Korea", "KR"}, {"Spain", "ES"}, {"Sri Lanka", "LK"}, {"Sweden", "SE"},
    {"Switzerland", "CH"}, {"Taiwan", "TW"}, {"Tanzania", "TZ"}, {"Thailand", "TH"}, {"Tunisia", "TN"},
    {"Turkey", "TR"}, {"Uganda", "UG"}, {"United Arab Emirates", "AE"}, {"United Kingdom", "GB"},
    {"United States", "US"}, {"Uruguay", "UY"}, {"Uzbekistan", "UZ"}, {"Vietnam", "VN"},
};

const char* const kModes[] = {"global", "countries", "cities", "fixed_city"};

// Normalised IDs: case folded the canonical way, sorted and unique, so equal choices give equal fingerprints.
std::vector<std::string> normalise(std::vector<std::string> ids, bool upper) {
    for (auto& id : ids) {
        std::erase_if(id, [](unsigned char c) { return std::isspace(c); });
        for (auto& c : id) c = static_cast<char>(upper ? std::toupper(static_cast<unsigned char>(c)) : std::tolower(static_cast<unsigned char>(c)));
    }
    std::erase_if(ids, [](const std::string& id) { return id.empty(); });
    std::sort(ids.begin(), ids.end());
    ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
    return ids;
}

std::string joined(const std::vector<std::string>& ids) {
    std::string out;
    for (const auto& id : ids) out += (out.empty() ? "" : ",") + id;
    return out;
}

[[noreturn]] void bad(const std::string& message) { throw std::invalid_argument(message); }

// The anchor inside a city's extract, drawn exactly as urban-crfg-v3 draws it.
MapLocation locate(const City& city, Seed128 seed, double extent_m) {
    MapLocation location;
    location.city = city.name;
    location.country = city.country;
    location.extent_m = extent_m;
    location.centre_lat = city.centre_lat();
    location.centre_lon = city.centre_lon();
    const DeterministicRng anchor_rng{seed.derive("map.anchor")};
    const double lat_span = (location.max_lat() - location.min_lat()) * 0.5;
    const double lon_span = (location.max_lon() - location.min_lon()) * 0.5;
    location.anchor_lat = location.centre_lat - lat_span / 2 + lat_span * anchor_rng.uniform01({RngDomain::MapSelection, 0, 1, 0});
    location.anchor_lon = location.centre_lon - lon_span / 2 + lon_span * anchor_rng.uniform01({RngDomain::MapSelection, 0, 2, 0});
    return location;
}

} // namespace

std::string country_id(const City& city) {
    const auto found = kCountryCodes.find(city.country);
    if (found == kCountryCodes.end()) throw std::logic_error("no ISO code for catalogue country " + city.country);
    return found->second;
}

std::string city_id(const City& city) { return city.slug(); }

std::string SelectionPolicy::canonical() const {
    return "policy=" + id + ";mode=" + mode + ";countries=" + joined(countries) + ";cities=" + joined(cities);
}

std::string SelectionPolicy::fingerprint() const { return "sha256:" + sha256(canonical()); }

nlohmann::json SelectionPolicy::to_json() const {
    return {{"policy", id}, {"mode", mode}, {"countries", countries}, {"cities", cities}, {"fingerprint", fingerprint()}};
}

SelectionPolicy policy_of(const ScenarioConfig& config) {
    SelectionPolicy policy;
    policy.id = config.map_selection_version;
    policy.mode = config.map_selection_mode.empty() ? "global" : config.map_selection_mode;
    policy.countries = normalise(config.map_countries, true);
    policy.cities = normalise(config.map_cities, false);
    if (policy.id != kLegacyPolicy && policy.id != kGeoPolicy)
        bad("unsupported map selection version: " + policy.id + " (urban-crfg-v3 or urban-geo-v1)");
    if (std::find(std::begin(kModes), std::end(kModes), policy.mode) == std::end(kModes))
        bad("unknown map selection mode: " + policy.mode + " (global, countries, cities or fixed_city)");
    if (policy.id == kLegacyPolicy && (policy.mode != "global" || !policy.countries.empty() || !policy.cities.empty()))
        bad("urban-crfg-v3 always chooses from every city; use urban-geo-v1 to choose countries or cities");
    const bool wants_countries = policy.mode == "countries", wants_cities = policy.mode == "cities" || policy.mode == "fixed_city";
    if (wants_countries != !policy.countries.empty())
        bad(wants_countries ? "mode countries needs at least one country" : "countries are only used with mode countries");
    if (wants_cities != !policy.cities.empty())
        bad(wants_cities ? "mode " + policy.mode + " needs at least one city" : "cities are only used with mode cities or fixed_city");
    if (policy.mode == "fixed_city" && policy.cities.size() != 1) bad("mode fixed_city needs exactly one city");
    for (const auto& id : policy.countries)
        if (std::none_of(city_catalog().begin(), city_catalog().end(), [&](const City& c) { return country_id(c) == id; }))
            bad("no city in the catalogue is in country " + id + " (use ISO 3166-1 alpha-2 codes, such as IN)");
    for (const auto& id : policy.cities)
        if (std::none_of(city_catalog().begin(), city_catalog().end(), [&](const City& c) { return city_id(c) == id; }))
            bad("unknown city " + id + " (use the city's ID, such as mumbai)");
    return policy;
}

std::vector<const City*> eligible(const SelectionPolicy& policy) {
    std::vector<const City*> out;
    for (const auto& city : city_catalog()) {
        const bool allowed = policy.mode == "global"
            || (policy.mode == "countries" && std::binary_search(policy.countries.begin(), policy.countries.end(), country_id(city)))
            || ((policy.mode == "cities" || policy.mode == "fixed_city") && std::binary_search(policy.cities.begin(), policy.cities.end(), city_id(city)));
        if (allowed) out.push_back(&city);
    }
    return out;
}

MapLocation select_location(Seed128 seed, const SelectionPolicy& policy, double extent_m) {
    // The legacy policy is frozen: its catalogue, order and draws belong to core-legacy and are reused unchanged.
    if (policy.id == kLegacyPolicy) return select_map_location(seed, extent_m);
    if (!(extent_m >= 500.0) || extent_m > 20000.0) bad("city extract extent must be in [500, 20000] metres");
    const auto cities = eligible(policy);
    if (cities.empty()) bad("the map selection allows no city");
    // One bounded draw over the eligible list, in catalogue order: no retries, and no dependence on hash-map order or
    // locale. The same label and address as urban-crfg-v3, so mode global chooses exactly the legacy city.
    const DeterministicRng city_rng{seed.derive("map.city")};
    const auto index = city_rng.bounded({RngDomain::MapSelection, 0, 0, 0}, static_cast<std::uint32_t>(cities.size()));
    return locate(*cities[index], seed, extent_m);
}

ScenarioCompiler::Hooks hooks() {
    ScenarioCompiler::Hooks out;
    out.select = [](Seed128 seed, const ScenarioConfig& config) {
        return select_location(seed, policy_of(config), config.map_city_extent_m);
    };
    out.validate = [](const ScenarioConfig& config) { (void)policy_of(config); };
    out.describe = [](const ScenarioConfig& config) { return policy_of(config).to_json(); };
    return out;
}

} // namespace dstns::core_ng
