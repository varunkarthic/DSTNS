#pragma once

#include "dstns/engine.hpp"

#include <atomic>
#include <cstdint>
#include <memory>

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
    // How many times the observer page has been served, so the launcher can
    // wait for the interface to be open before it asks for a world.
    std::atomic<std::uint64_t> observer_loads_{};
};
} // namespace dstns
