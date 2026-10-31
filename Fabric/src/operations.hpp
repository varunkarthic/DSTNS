// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/engine.hpp"

#include <nlohmann/json.hpp>
#include <string>

// Control operations shared by the public routes and the capability-checked
// application route, so both validate a request the same way.
namespace dstns::fabric {
nlohmann::json add_weather(SimulationEngine& engine, const nlohmann::json& j);
nlohmann::json add_traffic(SimulationEngine& engine, const nlohmann::json& j);
nlohmann::json add_surge(SimulationEngine& engine, const nlohmann::json& j);
nlohmann::json override_edge(SimulationEngine& engine, std::uint32_t edge, const nlohmann::json& j);
nlohmann::json step(SimulationEngine& engine, const nlohmann::json& j);
std::uint32_t history_count(const nlohmann::json& j);

/// The capability an application needs for an action; empty if there is no such action.
std::string control_capability(const std::string& action);
nlohmann::json perform_control(SimulationEngine& engine, const std::string& action, const nlohmann::json& params);
} // namespace dstns::fabric
