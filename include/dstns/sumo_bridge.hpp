#pragma once

#include "dstns/model.hpp"

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>

namespace dstns {

struct SumoEnvironment {
    bool available{false};
    std::string sumo_version;
    std::filesystem::path sumo_binary;
    std::filesystem::path netconvert_binary;
    std::filesystem::path sumo_home;
};

class SumoBridge {
public:
    [[nodiscard]] static SumoEnvironment detect();

    static void export_bundle(const Scenario& scenario, const std::filesystem::path& directory);

    static bool build_network(const std::filesystem::path& directory, const SumoEnvironment& env, std::string& error_out);

    static nlohmann::json simulate(
        const Scenario& scenario,
        const std::filesystem::path& directory,
        std::uint32_t begin_s = 0,
        std::uint32_t end_s = 3600,
        const SumoEnvironment* env_override = nullptr
    );
};

} // namespace dstns
