#include "dstns/api.hpp"
#include "dstns/logging.hpp"

#include <cstdlib>
#include <exception>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
    try {
        std::string host = "0.0.0.0", logs = "logs";
        std::uint16_t port = 8090;
        for (int i = 1; i < argc; ++i) {
            std::string a = argv[i];
            if (a == "--host" && i + 1 < argc) host = argv[++i];
            else if (a == "--port" && i + 1 < argc) port = static_cast<std::uint16_t>(std::stoul(argv[++i]));
            else if (a == "--logs" && i + 1 < argc) logs = argv[++i];
            else if (a == "--help") {
                std::cout << "dstns_server [--host ADDR] [--port PORT] [--logs DIR]\n";
                return 0;
            } else {
                throw std::invalid_argument("unknown argument: " + a);
            }
        }
        dstns::RuntimeLogger logger(logs);
        dstns::SimulationEngine engine(logger);
        dstns::ApiServer api(engine, logger);
        api.listen(host, port);
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "DSTNS fatal: " << e.what() << '\n';
        return 1;
    }
}
