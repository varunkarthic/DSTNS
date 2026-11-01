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

/// Where the engine's controls live now.
inline constexpr const char* kEngineBase = "/api/v1/fabric/engine";
/// The same handler, on an older path that still works and says what replaced it.
httplib::Server::Handler legacy_route(std::string successor, httplib::Server::Handler handler);

/// The observer, or the operator's own tooling, rather than an application.
bool is_host(const httplib::Request& req);
/// Keyed hash, as lower-case hex.
std::string hmac_sha256(std::string_view key, std::string_view message);
bool same_secret(std::string_view a, std::string_view b);
} // namespace dstns::fabric
