// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/platform.hpp"

#include <thread>

#if defined(__APPLE__)
#include <pthread.h>
#include <sys/qos.h>
#include <sys/sysctl.h>
#endif

namespace dstns {

void set_thread_role(ThreadRole role) noexcept {
#if defined(__APPLE__)
    qos_class_t qos = QOS_CLASS_DEFAULT;
    switch (role) {
    case ThreadRole::Simulation: qos = QOS_CLASS_USER_INTERACTIVE; break;
    case ThreadRole::Preparation: qos = QOS_CLASS_USER_INITIATED; break;
    case ThreadRole::Presentation: qos = QOS_CLASS_UTILITY; break;
    }
    (void)pthread_set_qos_class_self_np(qos, 0);
#else
    (void)role;
#endif
}

std::string processor_description() {
#if defined(__APPLE__)
    auto text = [](const char* key) {
        char buffer[256]{};
        std::size_t size = sizeof(buffer);
        return sysctlbyname(key, buffer, &size, nullptr, 0) == 0 ? std::string(buffer) : std::string();
    };
    auto number = [](const char* key) {
        int value = 0;
        std::size_t size = sizeof(value);
        return sysctlbyname(key, &value, &size, nullptr, 0) == 0 ? value : 0;
    };
    auto name = text("machdep.cpu.brand_string");
    if (name.empty()) name = "Apple";
    const int performance = number("hw.perflevel0.physicalcpu");
    const int efficiency = number("hw.perflevel1.physicalcpu");
    if (performance && efficiency)
        return name + " (" + std::to_string(performance) + "P+" + std::to_string(efficiency) + "E)";
    return name + " (" + std::to_string(std::thread::hardware_concurrency()) + " threads)";
#else
#if defined(__aarch64__)
    const char* arch = "aarch64";
#elif defined(__x86_64__)
    const char* arch = "x86_64";
#else
    const char* arch = "unknown";
#endif
    return std::string(arch) + " (" + std::to_string(std::thread::hardware_concurrency()) + " threads)";
#endif
}

} // namespace dstns
