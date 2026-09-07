#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>

namespace dstns {

struct Seed128 {
    std::uint64_t high{};
    std::uint64_t low{};
    [[nodiscard]] std::string hex() const;
    static Seed128 parse(std::string_view value);
    static Seed128 secure();
    [[nodiscard]] Seed128 derive(std::string_view domain) const;
    auto operator<=>(const Seed128&) const = default;
};

enum class RngDomain : std::uint32_t {
    MapSelection = 1, BusStops, Buildings, TrafficControl, TrafficOD,
    TrafficSignals, DwsSchedule, DwsField, DaySelector, Incidents, Events
};

struct RngAddress {
    RngDomain domain{};
    std::uint64_t object{};
    std::uint32_t purpose{};
    std::uint32_t draw{};
};

class DeterministicRng {
public:
    explicit DeterministicRng(Seed128 seed) : seed_(seed) {}
    [[nodiscard]] std::uint32_t u32(RngAddress address) const;
    [[nodiscard]] std::uint64_t u64(RngAddress address) const;
    [[nodiscard]] double uniform01(RngAddress address) const;
    [[nodiscard]] std::uint32_t bounded(RngAddress address, std::uint32_t bound) const;
    [[nodiscard]] Seed128 seed() const { return seed_; }
private:
    Seed128 seed_;
};

[[nodiscard]] std::string sha256(std::string_view input);

} // namespace dstns
