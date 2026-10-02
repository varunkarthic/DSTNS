// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "gpu.hpp"

#include "dstns/compute/field.hpp"

#include <cstring>

namespace dstns::vulkan {
namespace {

constexpr VkDeviceSize kMinimum = 256;

class VulkanFieldSolver final : public compute::FieldSolver {
public:
    VulkanFieldSolver(const compute::ComputeOptions& options, const compute::LogSink& log)
        : gpu_(std::make_unique<Gpu>(options, log)),
          layout_(std::make_unique<BindingLayout>(gpu_->device(), 3)),
          diffusion_(gpu_->pipeline(*layout_, "field_diffusion")) {}

    ~VulkanFieldSolver() override {
        try { gpu_->synchronize(); } catch (...) {}
    }

    void load(const compute::Field2D& field) override {
        const auto bytes = std::max<VkDeviceSize>(kMinimum, VkDeviceSize(field.cells.size()) * 4);
        if (bytes > gpu_->info().properties.limits.maxStorageBufferRange)
            throw compute::ComputeError("the field is larger than a storage buffer on " + gpu_->info().name, true);
        width_ = field.width;
        height_ = field.height;
        constexpr auto usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
        for (auto& buffer : cells_) buffer = Buffer(gpu_->device(), bytes, usage, MemoryUse::Device, "field");
        params_ = Buffer(gpu_->device(), 16, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Upload, "field parameters");
        staging_ = Buffer(gpu_->device(), bytes, VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, MemoryUse::Readback, "field staging");
        pool_ = std::make_unique<DescriptorPool>(gpu_->device(), 2, 6);
        for (int p = 0; p < 2; ++p) {
            sets_[p] = pool_->allocate(*layout_);
            write_set(gpu_->device(), sets_[p], {params_.handle(), cells_[p].handle(), cells_[1 - p].handle()});
        }
        std::memcpy(staging_.mapped(), field.cells.data(), field.cells.size() * 4);
        staging_.flush();
        current_ = 0;
        gpu_->copy(staging_.handle(), 0, cells_[0].handle(), 0, field.cells.size() * 4, false);
    }

    void diffuse(std::uint32_t rate_q16, std::uint32_t iterations) override {
        if (!iterations || !width_ || !height_) return;
        auto* params = static_cast<std::uint32_t*>(params_.mapped());
        params[0] = width_;
        params[1] = height_;
        params[2] = rate_q16;
        params[3] = 0;
        params_.flush();
        const auto cells = width_ * height_;
        const auto groups = (cells + gpu_->workgroup() - 1) / gpu_->workgroup();
        // Every iteration in one command buffer: the field never leaves the
        // device between steps, and the host waits once.
        gpu_->run([&](VkCommandBuffer command) {
            const auto& vk = gpu_->device().vk();
            vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, diffusion_->handle());
            barrier(gpu_->device(), command, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT,
                    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT);
            for (std::uint32_t k = 0; k < iterations; ++k) {
                const auto set = sets_[(current_ + k) % 2];
                vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, layout_->pipeline_layout(), 0, 1, &set, 0, nullptr);
                vk.vkCmdDispatch(command, groups, 1, 1);
                barrier(gpu_->device(), command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT,
                        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT,
                        VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_READ_BIT);
            }
        });
        current_ = (current_ + iterations) % 2;
    }

    compute::Field2D read() override {
        compute::Field2D field{width_, height_, std::vector<std::uint32_t>(std::size_t(width_) * height_)};
        gpu_->copy(cells_[current_].handle(), 0, staging_.handle(), 0, field.cells.size() * 4, true);
        staging_.invalidate();
        std::memcpy(field.cells.data(), staging_.mapped(), field.cells.size() * 4);
        return field;
    }

    [[nodiscard]] std::string device() const override { return gpu_->info().name + " (" + gpu_->info().driver_name + ")"; }

private:
    std::unique_ptr<Gpu> gpu_;
    std::unique_ptr<BindingLayout> layout_;
    std::unique_ptr<ComputePipeline> diffusion_;
    Buffer cells_[2], params_, staging_;
    std::unique_ptr<DescriptorPool> pool_;
    VkDescriptorSet sets_[2]{};
    std::uint32_t width_{}, height_{};
    int current_{};
};

} // namespace
} // namespace dstns::vulkan

namespace dstns::compute {

std::unique_ptr<FieldSolver> create_vulkan_field_solver(const ComputeOptions& options, const LogSink& log, std::string& reason) {
    try {
        return std::make_unique<vulkan::VulkanFieldSolver>(options, log);
    } catch (const std::exception& e) {
        reason = e.what();
    }
    return nullptr;
}

} // namespace dstns::compute
