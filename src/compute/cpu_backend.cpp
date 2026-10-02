// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/compute/cpu_backend.hpp"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>

namespace dstns::compute {

// A fixed set of threads that run one batch of ranges at a time. Created with
// the backend, so a step never creates a thread.
class CpuComputeBackend::Pool {
public:
    explicit Pool(std::uint32_t workers) {
        for (std::uint32_t i = 0; i < workers; ++i)
            threads_.emplace_back([this, i] { work(i); });
    }
    ~Pool() {
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        wake_.notify_all();
        for (auto& t : threads_) t.join();
    }
    [[nodiscard]] std::uint32_t workers() const { return static_cast<std::uint32_t>(threads_.size()); }

    /// Run job(0) on the caller and job(1..workers) on the pool; return when all have finished.
    void run(const std::function<void(std::uint32_t)>& job) {
        {
            std::lock_guard lock(mutex_);
            job_ = &job;
            pending_ = workers();
            ++generation_;
        }
        wake_.notify_all();
        job(0);
        std::unique_lock lock(mutex_);
        done_.wait(lock, [this] { return pending_ == 0; });
        job_ = nullptr;
    }
private:
    void work(std::uint32_t index) {
        std::uint64_t seen = 0;
        for (;;) {
            const std::function<void(std::uint32_t)>* job;
            {
                std::unique_lock lock(mutex_);
                wake_.wait(lock, [&] { return stopping_ || generation_ != seen; });
                if (stopping_) return;
                seen = generation_;
                job = job_;
            }
            (*job)(index + 1);
            std::lock_guard lock(mutex_);
            if (--pending_ == 0) done_.notify_one();
        }
    }
    std::vector<std::thread> threads_;
    std::mutex mutex_;
    std::condition_variable wake_, done_;
    const std::function<void(std::uint32_t)>* job_{};
    std::uint32_t pending_{};
    std::uint64_t generation_{};
    bool stopping_{};
};

CpuComputeBackend::CpuComputeBackend(std::uint32_t threads) {
    if (threads == 0) threads = std::clamp(std::thread::hardware_concurrency(), 1u, 8u);
    threads_ = std::max(1u, threads);
    if (threads_ > 1) pool_ = std::make_unique<Pool>(threads_ - 1);
}

CpuComputeBackend::~CpuComputeBackend() = default;

ComputeCapabilities CpuComputeBackend::capabilities() const {
    ComputeCapabilities c;
    c.available = true;
    c.hardware_accelerated = false;
    c.name = "CPU reference";
    c.device_type = "cpu";
    c.threads = threads_;
    c.unified_memory = true;
    return c;
}

void CpuComputeBackend::install(const StaticTables& tables) { tables_ = &tables; }
void CpuComputeBackend::release() { tables_ = nullptr; }

void CpuComputeBackend::step(const StepWork& work, std::vector<std::uint32_t>& state, StepResult& result) {
    const auto started = std::chrono::steady_clock::now();
    const auto& t = *tables_;
    cpu_node_pass(t, work.params, state);
    result = {};
    const auto& inputs = work.inputs.words();
    if (!pool_ || t.edge_count < kParallelEdges) {
        cpu_edge_pass(t, work.params, inputs, state, 0, t.edge_count, result);
    } else {
        // Contiguous ranges, one per thread; each sums into its own result and
        // the totals are combined in thread order. Integer sums, so the order
        // could not change them anyway.
        const auto parts = threads_;
        std::vector<StepResult> partial(parts);
        const auto chunk = (t.edge_count + parts - 1) / parts;
        pool_->run([&](std::uint32_t part) {
            const auto begin = std::min(t.edge_count, part * chunk);
            const auto end = std::min(t.edge_count, begin + chunk);
            cpu_edge_pass(t, work.params, inputs, state, begin, end, partial[part]);
        });
        for (const auto& p : partial) {
            result.transitions += p.transitions;
            result.congestion_sum += p.congestion_sum;
        }
    }
    telemetry_ = {};
    telemetry_.host_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
}

} // namespace dstns::compute
