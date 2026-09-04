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
};
} // namespace dstns
