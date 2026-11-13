// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/api.hpp"
#include "dstns/daemon.hpp"
#include "dstns/webfabric/registry.hpp"
#include "gate.hpp"

#include <httplib.h>

#include <cstdlib>

namespace dstns {

std::unique_ptr<daemon::Handler> make_daemons(SimulationEngine& engine, RuntimeLogger& logger);

namespace {
// HTTPS when given a certificate, which needs a build with DSTNS_TLS. Asked for and not
// available, it refuses to start, rather than serving in the clear what was meant to be private.
std::unique_ptr<httplib::Server> make_server() {
    const char* cert = std::getenv("DSTNS_TLS_CERT");
    const char* key = std::getenv("DSTNS_TLS_KEY");
    if (!(cert && *cert) && !(key && *key)) return std::make_unique<httplib::Server>();
    if (!(cert && *cert && key && *key)) throw std::runtime_error("--tls-cert and --tls-key must be given together");
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
    auto server = std::make_unique<httplib::SSLServer>(cert, key);
    if (!server->is_valid()) throw std::runtime_error("the TLS certificate or key could not be loaded");
    return server;
#else
    throw std::runtime_error("this server was built without TLS: configure with -DDSTNS_TLS=ON");
#endif
}
} // namespace

ApiServer::ApiServer(SimulationEngine& e, RuntimeLogger& l)
    : engine_(e), logger_(l), server_(make_server()),
      registry_(std::make_unique<fabric::AppRegistry>(l.log_directory() / "fabric-apps.json")) {
    // How many requests are answered at once: DSTNS_API_THREADS, or the library's own choice.
    if (const char* value = std::getenv("DSTNS_API_THREADS"); value && std::atoi(value) > 0) {
        const auto threads = static_cast<std::size_t>(std::min(std::atoi(value), 256));
        server_->new_task_queue = [threads] { return new httplib::ThreadPool(threads); };
    }
    // config/engines.json (or DSTNS_ENGINE_CONFIG): which engines may run, and how a run on an unstable one is
    // acknowledged. The gate tells every application when an approval changes, so it can retry what was deferred.
    const char* engines_file = std::getenv("DSTNS_ENGINE_CONFIG");
    auto engine_config = fabric::EngineConfig::load(engines_file && *engines_file ? engines_file : "config/engines.json");
    for (const auto& warning : engine_config.warnings) logger_.system("WARN", "engines", warning);
    gate_ = std::make_unique<fabric::EngineGate>(std::move(engine_config), [this](const nlohmann::json& event) {
        registry_->broadcast("engine.approval", event);
        logger_.system("INFO", "engines", "approval " + event.value("state", std::string()) + " " + event.value("approval_id", std::string()));
    });
    install_guards();
    routes_static();
    routes_system();
    routes_playback();
    routes_world();
    routes_control();
    routes_view();
    routes_observation();
    routes_apps();
    routes_daemon();
    routes_engine();
    daemons_ = make_daemons(engine_, logger_);
    daemons_->start();
}

ApiServer::~ApiServer() {
    stop();
    if (shutdown_worker_.joinable()) shutdown_worker_.join();
}

void ApiServer::listen(const std::string& host, std::uint16_t port) {
    loopback_only_->store(host == "localhost" || host == "::1" || host.rfind("127.", 0) == 0);
    logger_.system("INFO", "api", std::string("listening on ") + (std::getenv("DSTNS_TLS_CERT") ? "https://" : "http://") + host + ":" + std::to_string(port));
    if (!server_->listen(host, port) && !stopping_) {
        throw std::runtime_error("API server failed to listen on " + host + ":" + std::to_string(port) + " (port may be in use by another process)");
    }
}

void ApiServer::stop() {
    if (stopping_.exchange(true)) return;
    // The daemons first, so that a queue being waited on lets its reader go.
    if (daemons_) daemons_->stop();
    if (server_) server_->stop();
}

} // namespace dstns
