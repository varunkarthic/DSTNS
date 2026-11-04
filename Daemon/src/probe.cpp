// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// What a process uses, and what the machine has: macOS and Linux each in their own way.

#include "dstns/daemon.hpp"

#include <sys/statvfs.h>
#include <unistd.h>

#include <fstream>
#include <sstream>

#if defined(__APPLE__)
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <sys/sysctl.h>
#endif

namespace dstns::daemon {

#if defined(__APPLE__)

std::optional<Usage> process_usage(int pid) {
    proc_taskinfo info{};
    if (proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &info, sizeof info) != static_cast<int>(sizeof info)) return std::nullopt;
    // On Apple silicon these are in the machine's own time units, not nanoseconds.
    static const mach_timebase_info_data_t timebase = [] {
        mach_timebase_info_data_t t{};
        mach_timebase_info(&t);
        return t;
    }();
    const double ticks = static_cast<double>(info.pti_total_user + info.pti_total_system);
    return Usage{ticks * timebase.numer / timebase.denom / 1e9, static_cast<double>(info.pti_resident_size)};
}

std::vector<int> process_group(int group) {
    std::vector<int> pids(512);
    const int bytes = proc_listpids(PROC_PGRP_ONLY, static_cast<std::uint32_t>(group), pids.data(), static_cast<int>(pids.size() * sizeof(int)));
    if (bytes <= 0) return {};
    pids.resize(static_cast<std::size_t>(bytes) / sizeof(int));
    std::erase(pids, 0);
    return pids;
}

std::optional<SystemMemory> system_memory() {
    std::uint64_t total = 0;
    std::size_t size = sizeof total;
    if (sysctlbyname("hw.memsize", &total, &size, nullptr, 0) != 0) return std::nullopt;
    vm_statistics64_data_t vm{};
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    if (host_statistics64(mach_host_self(), HOST_VM_INFO64, reinterpret_cast<host_info64_t>(&vm), &count) != KERN_SUCCESS) return std::nullopt;
    // What could be had without paging anything out: free, plus what the system would give back at once.
    const double page = static_cast<double>(sysconf(_SC_PAGESIZE));
    const double available = (static_cast<double>(vm.free_count) + vm.inactive_count + vm.purgeable_count + vm.speculative_count) * page;
    return SystemMemory{static_cast<double>(total), available};
}

#else

std::optional<Usage> process_usage(int pid) {
    std::ifstream stat("/proc/" + std::to_string(pid) + "/stat");
    std::string line;
    if (!std::getline(stat, line)) return std::nullopt;
    // The name, in parentheses, may itself hold spaces and parentheses: the fields start after the last one.
    const auto close = line.rfind(')');
    if (close == std::string::npos) return std::nullopt;
    std::istringstream fields(line.substr(close + 2));
    std::vector<std::string> f;
    for (std::string word; fields >> word;) f.push_back(word);
    if (f.size() < 22) return std::nullopt;
    const double tick = static_cast<double>(sysconf(_SC_CLK_TCK));
    const double cpu = (std::stod(f[11]) + std::stod(f[12])) / tick;
    const double resident = std::stod(f[21]) * static_cast<double>(sysconf(_SC_PAGESIZE));
    return Usage{cpu, resident};
}

std::vector<int> process_group(int group) {
    std::vector<int> out;
    std::error_code ec;
    for (const auto& entry : std::filesystem::directory_iterator("/proc", ec)) {
        const auto name = entry.path().filename().string();
        if (name.empty() || !std::isdigit(static_cast<unsigned char>(name[0]))) continue;
        std::ifstream stat(entry.path() / "stat");
        std::string line;
        if (!std::getline(stat, line)) continue;
        const auto close = line.rfind(')');
        if (close == std::string::npos) continue;
        std::istringstream fields(line.substr(close + 2));
        std::string state, parent, pgrp;
        fields >> state >> parent >> pgrp;
        if (pgrp == std::to_string(group)) out.push_back(std::stoi(name));
    }
    return out;
}

std::optional<SystemMemory> system_memory() {
    std::ifstream info("/proc/meminfo");
    double total = -1, available = -1;
    for (std::string key; info >> key;) {
        double kib = 0;
        info >> kib;
        if (key == "MemTotal:") total = kib * 1024;
        if (key == "MemAvailable:") available = kib * 1024;
        info.ignore(256, '\n');
    }
    if (total < 0 || available < 0) return std::nullopt;
    return SystemMemory{total, available};
}

#endif

std::optional<double> free_disk_bytes(const std::filesystem::path& path) {
    struct statvfs stats{};
    std::error_code ec;
    auto at = path;
    // The nearest directory that exists, so that a cache not made yet still reads its disk.
    while (!at.empty() && !std::filesystem::exists(at, ec)) at = at.parent_path();
    if (at.empty() || statvfs(at.c_str(), &stats) != 0) return std::nullopt;
    return static_cast<double>(stats.f_bavail) * static_cast<double>(stats.f_frsize);
}

} // namespace dstns::daemon
