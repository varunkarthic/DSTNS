// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/calendar.hpp"

#include "dstns/geo.hpp"

#include <array>
#include <cctype>
#include <stdexcept>

namespace dstns {
namespace {

constexpr std::array<const char*, 12> kMonthNames{
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"};

// Odd, so a step of it visits every 64-bit value before repeating.
constexpr std::uint64_t kWeylStep = 0x9E3779B97F4A7C15ULL;

std::string lower(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    for (const char c : text) out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    return out;
}

std::string_view trim(std::string_view text) {
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) text.remove_prefix(1);
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.remove_suffix(1);
    return text;
}

} // namespace

const char* month_name(int month) { return month >= 1 && month <= 12 ? kMonthNames[std::size_t(month - 1)] : ""; }

std::optional<int> parse_month(std::string_view text) {
    const auto value = lower(trim(text));
    if (value.empty()) return std::nullopt;
    if (value.find_first_not_of("0123456789") == std::string::npos) {
        if (value.size() > 2) return std::nullopt;
        const int number = std::stoi(value);
        return number >= 1 && number <= 12 ? std::optional<int>(number) : std::nullopt;
    }
    for (int m = 1; m <= 12; ++m) {
        const auto name = lower(kMonthNames[std::size_t(m - 1)]);
        if (value == name || (value.size() == 3 && name.compare(0, 3, value) == 0)) return m;
    }
    return std::nullopt;
}

const char* day_type_name(int day) { return day == kWeekend ? "weekend" : "weekday"; }

std::optional<int> parse_day_type(std::string_view text) {
    const auto value = lower(trim(text));
    if (value == "weekday" || value == "0") return kWeekday;
    if (value == "weekend" || value == "1") return kWeekend;
    return std::nullopt;
}

int derive_month(Seed128 seed) {
    const DeterministicRng rng{seed.derive("calendar.month")};
    return 1 + static_cast<int>(rng.bounded({RngDomain::Calendar, 0, 0, 0}, 12));
}

int derive_day_type(Seed128 seed) {
    const DeterministicRng rng{seed.derive("calendar.day")};
    return rng.bounded({RngDomain::DaySelector, 0, 0, 0}, 7) >= 5 ? kWeekend : kWeekday;
}

std::optional<std::uint32_t> find_city(std::string_view name) {
    const auto wanted = lower(trim(name));
    if (wanted.empty()) return std::nullopt;
    const auto& catalog = city_catalog();
    for (std::size_t i = 0; i < catalog.size(); ++i)
        if (lower(catalog[i].name) == wanted || catalog[i].slug() == wanted) return static_cast<std::uint32_t>(i);
    return std::nullopt;
}

SeedMetadata describe_seed(Seed128 seed) {
    SeedMetadata m;
    m.city_index = select_city_index(seed);
    const auto& city = city_catalog().at(m.city_index);
    m.city = city.name;
    m.country = city.country;
    m.latitude = city.lat;
    m.longitude = city.lon;
    m.month = derive_month(seed);
    m.day = derive_day_type(seed);
    return m;
}

ConstrainedSeed generate_constrained_seed(const SeedConstraints& c, std::uint64_t start, std::uint64_t max_attempts) {
    if (c.city_index && *c.city_index >= city_catalog().size()) throw std::invalid_argument("unknown location");
    if (c.month && (*c.month < 1 || *c.month > 12)) throw std::invalid_argument("month must be in [1, 12]");
    if (c.day && *c.day != kWeekday && *c.day != kWeekend) throw std::invalid_argument("day type must be weekday or weekend");
    std::uint64_t value = start;
    for (std::uint64_t attempt = 1; attempt <= max_attempts; ++attempt, value += kWeylStep) {
        if (value == 0) continue;
        const Seed128 candidate{0, value};
        // Cheapest rejections first: each test is one SHA-256 and one Philox
        // evaluation, and most candidates fail the first constraint applied.
        if (c.day && derive_day_type(candidate) != *c.day) continue;
        if (c.month && derive_month(candidate) != *c.month) continue;
        if (c.city_index && select_city_index(candidate) != *c.city_index) continue;
        return {candidate, describe_seed(candidate), attempt};
    }
    throw std::runtime_error("no seed satisfying the constraints was found");
}

ConstrainedSeed generate_constrained_seed(const SeedConstraints& constraints) {
    return generate_constrained_seed(constraints, Seed128::secure64().low);
}

} // namespace dstns
