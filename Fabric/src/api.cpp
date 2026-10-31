// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/fabric/registry.hpp"

#include <httplib.h>

namespace dstns {

ApiServer::ApiServer(SimulationEngine& e, RuntimeLogger& l)
    : engine_(e), logger_(l), server_(std::make_unique<httplib::Server>()),
      registry_(std::make_unique<fabric::AppRegistry>(l.log_directory() / "fabric-apps.json")) {
    install_guards();
    routes_static();
    routes_system();
    routes_playback();
    routes_world();
    routes_control();
    routes_view();
    routes_observation();
    routes_apps();
}

ApiServer::~ApiServer() {
    stop();
    if (shutdown_worker_.joinable()) shutdown_worker_.join();
}

void ApiServer::listen(const std::string& host, std::uint16_t port) {
    loopback_only_->store(host == "localhost" || host == "::1" || host.rfind("127.", 0) == 0);
    logger_.system("INFO", "api", "listening on http://" + host + ":" + std::to_string(port));
    if (!server_->listen(host, port) && !stopping_) {
        throw std::runtime_error("API server failed to listen on " + host + ":" + std::to_string(port) + " (port may be in use by another process)");
    }
}

void ApiServer::stop() {
    if (stopping_.exchange(true)) return;
    if (server_) server_->stop();
}

} // namespace dstns
