// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/engine.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <thread>

namespace httplib { class Server; }

namespace dstns {
class ApiServer {
public:
    ApiServer(SimulationEngine& engine,RuntimeLogger& logger);
    ~ApiServer();
    void listen(const std::string& host,std::uint16_t port);
    void stop();
private:
    void routes();
    SimulationEngine& engine_; RuntimeLogger& logger_; std::unique_ptr<httplib::Server> server_; std::atomic_bool stopping_{};
    std::atomic_bool termination_started_{};
    std::thread shutdown_worker_;
    // How many times the observer page has been served, so the launcher can
    // wait for the interface to be open before it asks for a world.
    std::atomic<std::uint64_t> observer_loads_{};
    // Whether the listener is bound to a loopback address. Shared with the
    // pre-routing guard, which enforces the Host-header check only then: a
    // loopback server is reached by name only through DNS rebinding, whereas a
    // server behind a proxy legitimately sees any hostname.
    std::shared_ptr<std::atomic_bool> loopback_only_{std::make_shared<std::atomic_bool>(false)};
};
} // namespace dstns
