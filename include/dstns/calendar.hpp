// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

// The deterministic calendar: what a seed says about *when* and *where* a run
// takes place.
//
// A run models one 24-hour day. It has a location (a city from the catalogue),
// a month and a day type (weekday or weekend), and deliberately no day of the
// month. All three are functions of the seed, each drawn from its own derived
// stream, so that none of them shifts when another module draws more numbers:
//
//     location  = catalogue[ Philox(SHA-256(seed:map.city))      mod 181 ]
//     month     = 1 + Philox(SHA-256(seed:calendar.month)) mod 12
//     day type  = weekend iff Philox(SHA-256(seed:calendar.day)) mod 7 >= 5
//
// The day type follows the shape of a real week (five weekdays, two weekend
// days) rather than a coin toss.
//
// A seed with chosen properties is found by rejection: candidate seeds are
// proposed and their metadata derived until one matches. The answer is an
// ordinary seed, so the seed alone still reproduces the location, month and
// day type; nothing is overridden behind its back.

#include "dstns/rng.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace dstns {

inline constexpr int kWeekday = 0;
inline constexpr int kWeekend = 1;

/// "January" .. "December" for 1..12; "" otherwise.
[[nodiscard]] const char* month_name(int month);
/// A month from "7", "07", "July" or "jul" (any case). Empty if unrecognised.
[[nodiscard]] std::optional<int> parse_month(std::string_view text);
/// "weekday" or "weekend".
[[nodiscard]] const char* day_type_name(int day);
/// 0 from "weekday", 1 from "weekend" (or "0"/"1"). Empty if unrecognised.
[[nodiscard]] std::optional<int> parse_day_type(std::string_view text);

/// The month a seed resolves to, 1..12.
[[nodiscard]] int derive_month(Seed128 seed);
/// The day type a seed resolves to: kWeekday or kWeekend.
[[nodiscard]] int derive_day_type(Seed128 seed);

/// Catalogue index of a city by name or slug, ignoring case ("Ahmedabad",
/// "sao-paulo"). Empty if the catalogue has no such city.
[[nodiscard]] std::optional<std::uint32_t> find_city(std::string_view name);

/// Everything a seed alone determines about when and where a run is.
struct SeedMetadata {
    std::uint32_t city_index{};
    std::string city, country;
    double latitude{}, longitude{};
    int month{1};
    int day{kWeekday};
};
[[nodiscard]] SeedMetadata describe_seed(Seed128 seed);

/// What the operator asked for; an empty field is "Auto".
struct SeedConstraints {
    std::optional<std::uint32_t> city_index;
    std::optional<int> month;
    std::optional<int> day;
};

struct ConstrainedSeed {
    Seed128 seed;
    SeedMetadata metadata;
    std::uint64_t attempts{};
};

/// The largest number of candidates examined before giving up. A fully
/// constrained search needs 181 x 12 x 7/5 ~ 3,000 candidates on average for a
/// weekday and 181 x 12 x 7/2 ~ 7,600 for a weekend; this bound is three orders
/// of magnitude above that, so it is only reached when the constraints are
/// impossible.
inline constexpr std::uint64_t kMaxSeedSearch = 20'000'000;

/// Search 64-bit seeds for one whose metadata satisfies `constraints`.
///
/// Candidates are visited along a Weyl sequence from `start`
/// (start, start + phi, start + 2 phi, ... modulo 2^64, phi odd), so the walk
/// never repeats and is reproducible for a given start; zero is skipped
/// because the API reads it as "draw a fresh seed". Throws
/// std::invalid_argument for an out-of-range constraint and std::runtime_error
/// if nothing matches within `max_attempts`.
[[nodiscard]] ConstrainedSeed generate_constrained_seed(const SeedConstraints& constraints, std::uint64_t start,
                                                        std::uint64_t max_attempts = kMaxSeedSearch);
/// The same from a fresh secure starting point: the only place entropy enters.
[[nodiscard]] ConstrainedSeed generate_constrained_seed(const SeedConstraints& constraints);

} // namespace dstns
