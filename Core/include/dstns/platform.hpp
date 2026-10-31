// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include <string>

namespace dstns {

/**
 * What a thread is for, so the operating system can place it.
 *
 * Apple silicon has performance and efficiency cores, and macOS schedules by
 * quality-of-service class rather than by priority: a thread marked
 * interactive is kept on the performance cores, one marked utility drifts to
 * the efficiency cores. The simulation clock wants the former; narration and
 * other presentation work want the latter, so they never take a performance
 * core from the physics step. Elsewhere this is a no-op.
 */
enum class ThreadRole {
    Simulation,   // the physics clock: latency-sensitive
    Preparation,  // world compilation: the operator is waiting on it
    Presentation  // narration and other cosmetic work: throughput, not latency
};

void set_thread_role(ThreadRole role) noexcept;

/// "Apple M4 (4P+6E)", "x86_64", ...: for benchmark reports.
[[nodiscard]] std::string processor_description();

} // namespace dstns
