// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include <cstddef>
#include <cstdint>

namespace dstns {

/// Read-only view of the conditions on every edge after a step: what the
/// demand model needs, without materialising the full edge state. Points into
/// the compute dispatcher's host state, which is current after every step
/// whichever backend ran it.
struct EdgeConditions {
    const std::uint32_t* rain_q30{};
    const std::uint32_t* flood_q30{};
    const std::uint32_t* flags{};
    std::size_t count{};

    [[nodiscard]] double rainfall(std::size_t e) const { return double(rain_q30[e]) / 1073741824.0; }
    [[nodiscard]] double flood(std::size_t e) const { return double(flood_q30[e]) / 1073741824.0; }
    [[nodiscard]] bool closed(std::size_t e) const { return (flags[e] & 1u) != 0; }
    [[nodiscard]] bool incident_closed(std::size_t e) const { return (flags[e] & 2u) != 0; }
};

} // namespace dstns
