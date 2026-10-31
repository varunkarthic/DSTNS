// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/engine.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <cstddef>
#include <cstdint>
#include <string>

// Request parsing and response helpers shared by the Fabric route modules.
namespace dstns::fabric {
using json = nlohmann::json;

void send(httplib::Response& r, const json& j, int status = 200);
std::size_t page_parameter(const httplib::Request& request, const char* key, std::size_t fallback, std::size_t ceiling);
Seed128 seed_from(const json& j);
bool same_origin(const std::string& origin, const std::string& host, const std::string& forwarded_host);
bool host_allowed(std::string host);
json body(const httplib::Request& r);
std::uint32_t path_id(const std::string& text);
std::uint64_t unsigned_parameter(const httplib::Request& request, const char* key, std::uint64_t fallback);
std::uint32_t time_value(const json& v);
ScenarioConfig config_from(const json& j);
} // namespace dstns::fabric
