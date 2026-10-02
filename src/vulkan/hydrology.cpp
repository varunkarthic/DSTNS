// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The surface-water solver on a Vulkan device. The same integer kernels as
// the CPU reference (shaders/include/dstns_hydrology.h), so the same bits.
//
// The depth and discharge fields stay on the device from step to step. A
// step is one submission: sources, then for each substep the flux, limiter,
// apply and scale passes, then a per-row reduction and the per-road
// summaries. The host reads back sixteen words per grid row and two per road
// edge, never the fields, except when it asks for them (a checkpoint, an
// overlay, a diagnostic).

#include "gpu.hpp"

#include "dstns/environment/hydrology.hpp"

#include <algorithm>
#include <array>
#include <cstring>

namespace dstns::vulkan {
namespace {

constexpr VkDeviceSize kMinimum = 256;
constexpr std::uint32_t kBindings = 22;
constexpr std::uint32_t kRowWords = 16;
constexpr auto kStorage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;

enum Binding : std::uint32_t {
    kParams, kBed, kFlags, kDepth, kFaceX, kFaceY, kFaceXPrev, kFaceYPrev, kLimiter, kBoundary, kSea,
    kRain, kEvaporation, kInfiltration, kEvaporated, kInfiltrated, kRows, kRoadOffsets, kRoadCells, kRoads, kDrain, kDrained
};

VkDeviceSize bytes_for(std::size_t words) { return std::max<VkDeviceSize>(kMinimum, VkDeviceSize(words) * 4); }

class VulkanHydrology final : public env::HydrologySolver {
public:
    VulkanHydrology(const compute::ComputeOptions& options, const compute::LogSink& log)
        : gpu_(std::make_unique<Gpu>(options, log)), layout_(std::make_unique<BindingLayout>(gpu_->device(), kBindings)) {
        for (const auto* name : {"hydro_source", "hydro_flux", "hydro_limit", "hydro_apply", "hydro_scale", "hydro_reduce", "hydro_roads"})
            pipelines_.push_back(gpu_->pipeline(*layout_, name));
    }
    ~VulkanHydrology() override {
        try { gpu_->synchronize(); } catch (...) {}
    }

    void install(const env::HydrologyGrid& grid) override {
        grid_ = &grid;
        const auto cells = grid.cells();
        edges_ = grid.road_offsets.empty() ? 0 : std::uint32_t(grid.road_offsets.size() - 1);
        const std::array<std::size_t, kBindings> words{
            16, cells, cells, cells, grid.faces_x(), grid.faces_y(), grid.faces_x(), grid.faces_y(), cells, cells, cells,
            cells, cells, cells, cells, cells, std::size_t(grid.grid.height) * kRowWords, grid.road_offsets.size(),
            std::max<std::size_t>(1, grid.road_cells.size()), std::size_t(edges_) * 2, cells, cells};
        const auto limit = gpu_->info().properties.limits.maxStorageBufferRange;
        for (std::uint32_t b = 0; b < kBindings; ++b) {
            if (bytes_for(words[b]) > limit) throw compute::ComputeError("the hydrology grid is larger than a storage buffer on " + gpu_->info().name, true);
            buffers_[b] = b == kParams ? Buffer(gpu_->device(), bytes_for(words[b]), VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Upload, "hydrology parameters")
                                       : Buffer(gpu_->device(), bytes_for(words[b]), kStorage, MemoryUse::Device, "hydrology");
        }
        std::size_t staging_words = std::max({std::size_t(4) * cells, grid.faces_x() + grid.faces_y() + cells, grid.road_cells.size() + grid.road_offsets.size(),
                                             std::size_t(grid.grid.height) * kRowWords + std::size_t(edges_) * 2});
        staging_ = Buffer(gpu_->device(), bytes_for(staging_words), VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                          MemoryUse::Readback, "hydrology staging");
        pool_ = std::make_unique<DescriptorPool>(gpu_->device(), 1, kBindings);
        set_ = pool_->allocate(*layout_);
        std::vector<VkBuffer> handles;
        for (auto& b : buffers_) handles.push_back(b.handle());
        write_set(gpu_->device(), set_, handles);

        upload_words(kBed, grid.z_q16.data(), cells);
        upload_words(kFlags, grid.flags.data(), cells);
        if (!grid.road_offsets.empty()) upload_words(kRoadOffsets, grid.road_offsets.data(), grid.road_offsets.size());
        if (!grid.road_cells.empty()) upload_words(kRoadCells, grid.road_cells.data(), grid.road_cells.size());
    }

    void upload(const env::HydrologyState& s) override {
        upload_words(kDepth, s.h.data(), s.h.size());
        upload_words(kFaceX, s.qx.data(), s.qx.size());
        upload_words(kFaceY, s.qy.data(), s.qy.size());
    }

    void download(env::HydrologyState& s) override {
        download_words(kDepth, s.h.data(), s.h.size());
        download_words(kFaceX, s.qx.data(), s.qx.size());
        download_words(kFaceY, s.qy.data(), s.qy.size());
    }

    [[nodiscard]] bool host_resident() const override { return false; }
    [[nodiscard]] std::string name() const override { return "vulkan (" + gpu_->info().name + ")"; }

    void advance(env::HydrologyState& s, const env::HydrologySources& src, double dt, std::uint32_t substeps, const env::HydrologyParams& p) override {
        const auto& g = *grid_;
        const auto cells = g.cells();
        const auto c = env::hydrology_coefficients(dt, g.grid.cell_m, p);
        auto* params = static_cast<std::uint32_t*>(buffers_[kParams].mapped());
        const auto put64 = [&](std::uint32_t at, std::int64_t v) {
            params[at] = static_cast<std::uint32_t>(std::uint64_t(v) & 0xFFFFFFFFu);
            params[at + 1] = static_cast<std::uint32_t>(std::uint64_t(v) >> 32);
        };
        params[0] = g.grid.width;
        params[1] = g.grid.height;
        put64(2, c.a_q20);
        put64(4, c.k_q32);
        put64(6, c.c_q24);
        put64(8, c.hmin);
        put64(10, c.theta);
        params[12] = edges_;
        buffers_[kParams].flush();

        // Sources through the staging buffer; an absent source is zero-filled.
        auto* staging = static_cast<std::int32_t*>(staging_.mapped());
        std::int64_t rain_total = 0;
        const std::array<const std::vector<std::int32_t>*, 4> sources{&src.rain, &src.evaporation, &src.infiltration, &src.drain};
        for (std::size_t n = 0; n < 4; ++n)
            if (!sources[n]->empty()) std::memcpy(staging + n * cells, sources[n]->data(), cells * 4);
        for (const auto v : src.rain) rain_total += v;
        staging_.flush();

        const auto& vk = gpu_->device().vk();
        const auto groups = [&](std::size_t n) { return std::uint32_t((n + gpu_->workgroup() - 1) / gpu_->workgroup()); };
        const auto compute_barrier = [&](VkCommandBuffer command) {
            barrier(gpu_->device(), command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT,
                    VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT,
                    VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_TRANSFER_WRITE_BIT);
        };
        const auto dispatch = [&](VkCommandBuffer command, std::size_t pass, std::size_t items) {
            vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, pipelines_[pass]->handle());
            vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, layout_->pipeline_layout(), 0, 1, &set_, 0, nullptr);
            vk.vkCmdDispatch(command, groups(items), 1, 1);
            compute_barrier(command);
        };
        const auto faces = g.faces_x() + g.faces_y();
        const auto rows_words = std::size_t(g.grid.height) * kRowWords;
        gpu_->run([&](VkCommandBuffer command) {
            barrier(gpu_->device(), command, VK_PIPELINE_STAGE_HOST_BIT | VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_ACCESS_HOST_WRITE_BIT | VK_ACCESS_SHADER_WRITE_BIT,
                    VK_PIPELINE_STAGE_TRANSFER_BIT | VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_SHADER_READ_BIT);
            const std::array<Binding, 4> targets{kRain, kEvaporation, kInfiltration, kDrain};
            for (std::size_t n = 0; n < 4; ++n) {
                if (sources[n]->empty()) {
                    vk.vkCmdFillBuffer(command, buffers_[targets[n]].handle(), 0, VK_WHOLE_SIZE, 0);
                } else {
                    const VkBufferCopy region{VkDeviceSize(n * cells * 4), 0, VkDeviceSize(cells * 4)};
                    vk.vkCmdCopyBuffer(command, staging_.handle(), buffers_[targets[n]].handle(), 1, &region);
                }
            }
            compute_barrier(command);
            dispatch(command, 0, cells);  // sources
            for (std::uint32_t n = 0; n < substeps; ++n) {
                const VkBufferCopy fx{0, 0, VkDeviceSize(g.faces_x() * 4)}, fy{0, 0, VkDeviceSize(g.faces_y() * 4)};
                vk.vkCmdCopyBuffer(command, buffers_[kFaceX].handle(), buffers_[kFaceXPrev].handle(), 1, &fx);
                vk.vkCmdCopyBuffer(command, buffers_[kFaceY].handle(), buffers_[kFaceYPrev].handle(), 1, &fy);
                compute_barrier(command);
                dispatch(command, 1, faces);   // flux
                dispatch(command, 2, cells);   // limiter
                dispatch(command, 3, cells);   // apply
                dispatch(command, 4, faces);   // scale
            }
            dispatch(command, 5, g.grid.height);  // per-row tallies
            if (edges_) dispatch(command, 6, edges_);
            const VkBufferCopy rows{0, 0, VkDeviceSize(rows_words * 4)};
            vk.vkCmdCopyBuffer(command, buffers_[kRows].handle(), staging_.handle(), 1, &rows);
            if (edges_) {
                const VkBufferCopy roads{0, VkDeviceSize(rows_words * 4), VkDeviceSize(std::size_t(edges_) * 8)};
                vk.vkCmdCopyBuffer(command, buffers_[kRoads].handle(), staging_.handle(), 1, &roads);
            }
            barrier(gpu_->device(), command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
        });
        staging_.invalidate();

        const auto* words = static_cast<const std::uint32_t*>(staging_.mapped());
        const auto get64 = [&](std::size_t at) { return std::int64_t(std::uint64_t(words[at]) | (std::uint64_t(words[at + 1]) << 32)); };
        std::int64_t stored = 0, boundary = 0, sea = 0, evap = 0, infil = 0, h_max = 0, drains = 0;
        std::uint32_t wet = 0, flooded = 0;
        for (std::uint32_t j = 0; j < g.grid.height; ++j) {
            const auto at = std::size_t(j) * kRowWords;
            stored += get64(at);
            boundary += get64(at + 2);
            sea += get64(at + 4);
            evap += get64(at + 6);
            infil += get64(at + 8);
            h_max = std::max(h_max, get64(at + 10));
            wet += words[at + 12];
            flooded += words[at + 13];
            drains += get64(at + 14);
        }
        s.ledger.rain += rain_total;
        s.ledger.boundary += boundary;
        s.ledger.sea += sea;
        s.ledger.evaporated += evap;
        s.ledger.infiltrated += infil;
        s.ledger.drained += drains;
        s.stored = stored;
        s.h_max = h_max;
        s.wet_cells = wet;
        s.flooded_cells = flooded;
        s.road_max.resize(edges_);
        s.road_mean.resize(edges_);
        const auto* roads = reinterpret_cast<const std::int32_t*>(words + rows_words);
        for (std::uint32_t e = 0; e < edges_; ++e) {
            s.road_max[e] = roads[2 * e];
            s.road_mean[e] = roads[2 * e + 1];
        }
    }

private:
    template <class T>
    void upload_words(Binding target, const T* data, std::size_t count) {
        if (!count) return;
        std::memcpy(staging_.mapped(), data, count * 4);
        staging_.flush();
        gpu_->copy(staging_.handle(), 0, buffers_[target].handle(), 0, count * 4, false);
    }
    template <class T>
    void download_words(Binding source, T* data, std::size_t count) {
        if (!count) return;
        gpu_->copy(buffers_[source].handle(), 0, staging_.handle(), 0, count * 4, true);
        staging_.invalidate();
        std::memcpy(data, staging_.mapped(), count * 4);
    }

    std::unique_ptr<Gpu> gpu_;
    std::unique_ptr<BindingLayout> layout_;
    std::vector<std::unique_ptr<ComputePipeline>> pipelines_;
    std::array<Buffer, kBindings> buffers_;
    Buffer staging_;
    std::unique_ptr<DescriptorPool> pool_;
    VkDescriptorSet set_{};
    const env::HydrologyGrid* grid_{};
    std::uint32_t edges_{};
};

} // namespace
} // namespace dstns::vulkan

namespace dstns::env {

std::unique_ptr<HydrologySolver> make_vulkan_hydrology_solver(const compute::ComputeOptions& options, const compute::LogSink& log, std::string& reason) {
    try {
        return std::make_unique<vulkan::VulkanHydrology>(options, log);
    } catch (const std::exception& e) {
        reason = e.what();
    }
    return nullptr;
}

} // namespace dstns::env
