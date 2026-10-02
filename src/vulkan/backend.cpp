// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "backend.hpp"

#include "dstns/compute/physics.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <sstream>

namespace dstns::vulkan {
namespace {
using compute::FaultInjection;
using Clock = std::chrono::steady_clock;

constexpr VkDeviceSize kMinimumBuffer = 256;
constexpr std::uint32_t kTimestampsPerStep = 5;
// Barrier masks used around every pass.
constexpr VkAccessFlags kDeviceWrites = VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT;
constexpr VkAccessFlags kDeviceAccess = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_TRANSFER_WRITE_BIT;
constexpr VkAccessFlags kTransferAccess = VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_TRANSFER_WRITE_BIT;
constexpr VkPipelineStageFlags kComputeAndTransfer = VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT;

VkDeviceSize bytes_of(std::size_t words) { return std::max<VkDeviceSize>(kMinimumBuffer, VkDeviceSize(words) * 4); }

std::uint32_t groups(std::uint32_t items, std::uint32_t size) { return (items + size - 1) / size; }

} // namespace

// Everything that belongs to one installed world.
struct VulkanComputeBackend::World {
    const compute::StaticTables* tables{};
    Buffer static_words, inputs, state[2], partials, counters;
    Buffer params, records_inputs, records_state, indirect, readback, staging;
    std::unique_ptr<DescriptorPool> descriptors;
    VkDescriptorSet physics_set[2]{}, scatter_inputs_set{}, scatter_state_set[2]{};
    std::uint32_t node_groups{}, edge_groups{};
    VkDeviceSize readback_partials{}, readback_counters{};
};

VulkanComputeBackend::VulkanComputeBackend(const compute::ComputeOptions& options, const compute::LogSink& log)
    : options_(options), log_(log) {
    if (options.fault.kind == FaultInjection::Kind::Initialisation) throw std::runtime_error("injected fault: initialisation");
    gpu_ = std::make_unique<Gpu>(options, log);
    physics_layout_ = std::make_unique<BindingLayout>(gpu_->device(), 7);
    if (options.fault.kind == FaultInjection::Kind::Pipeline) throw VulkanError("injected fault: vkCreateComputePipelines", VK_ERROR_INITIALIZATION_FAILED);
    node_pipeline_ = gpu_->pipeline(*physics_layout_, "node_step");
    edge_pipeline_ = gpu_->pipeline(*physics_layout_, "edge_step");
    scatter_pipeline_ = gpu_->pipeline(gpu_->pair_layout(), "scatter");
    gpu_->cache().save();
    if (gpu_->info().timestamps) timestamps_ = std::make_unique<Timestamps>(gpu_->device(), 2 * kTimestampsPerStep);
    step_commands_[0] = gpu_->commands().allocate();
    step_commands_[1] = gpu_->commands().allocate();
}

VulkanComputeBackend::~VulkanComputeBackend() {
    try {
        if (gpu_) gpu_->synchronize();
    } catch (...) {
    }
    world_.reset();
}

compute::ComputeCapabilities VulkanComputeBackend::capabilities() const {
    compute::ComputeCapabilities c;
    c.available = !gpu_->lost();
    c.hardware_accelerated = !gpu_->info().software;
    c.name = gpu_->info().name;
    c.vendor = gpu_->info().vendor_name();
    c.vendor_id = gpu_->info().properties.vendorID;
    c.device_id = gpu_->info().properties.deviceID;
    c.driver = gpu_->info().driver_name;
    c.driver_version = gpu_->info().driver_version_string();
    c.device_type = gpu_->info().type_name();
    c.api_version = version_string(gpu_->info().properties.apiVersion);
    c.uuid = gpu_->info().uuid;
    c.device_memory_bytes = gpu_->info().device_local_bytes;
    c.moltenvk = gpu_->info().moltenvk();
    c.portability_subset = gpu_->info().portability_subset;
    c.timestamps = timestamps_ != nullptr;
    c.synchronization2 = gpu_->device().synchronization2();
    c.validation = gpu_->instance().validation();
    c.unified_memory = gpu_->info().unified_memory;
    c.queue_family = static_cast<std::uint32_t>(gpu_->info().queue_family);
    c.workgroup_size = gpu_->workgroup();
    c.pipeline_cache = gpu_->cache().state();
    c.shader_bundle = shaders::kBundleSha256;
    return c;
}

void VulkanComputeBackend::guard() const {
    if (gpu_->lost()) throw VulkanError("the device was lost earlier", VK_ERROR_DEVICE_LOST, false);
}

// --- World resources ----------------------------------------------------------------------

void VulkanComputeBackend::install(const compute::StaticTables& tables) {
    guard();
    release();
    if (options_.fault.kind == FaultInjection::Kind::Allocation)
        throw compute::ComputeError("injected fault: device memory allocation failed", true);

    const auto& limits = gpu_->info().properties.limits;
    const auto state_bytes = bytes_of(tables.state_words());
    const auto static_bytes = bytes_of(tables.node_words.size() + tables.edge_words.size());
    const auto input_bytes = bytes_of(tables.input_words());
    const auto edge_groups = groups(tables.edge_count, gpu_->workgroup());
    const auto partial_bytes = std::max<VkDeviceSize>(kMinimumBuffer, VkDeviceSize(edge_groups) * 8);
    const auto host_field_bytes = VkDeviceSize(physics::EDGE_HOST_FIELDS) * tables.edge_stride * 4;
    const auto readback_bytes = host_field_bytes + partial_bytes + 16;
    const auto staging_bytes = std::max({state_bytes, static_bytes, input_bytes});

    // Refuse a world that cannot fit before allocating any of it, rather than
    // discovering it as VK_ERROR_OUT_OF_DEVICE_MEMORY halfway through.
    const auto largest = std::max({state_bytes, static_bytes, input_bytes});
    if (largest > limits.maxStorageBufferRange)
        throw compute::ComputeError("the world needs a " + std::to_string(largest >> 20) + " MiB storage buffer; " + gpu_->info().name +
                                    " binds at most " + std::to_string(limits.maxStorageBufferRange >> 20) + " MiB", true);
    if (gpu_->info().max_allocation && largest > gpu_->info().max_allocation)
        throw compute::ComputeError("the world needs a larger single allocation than " + gpu_->info().name + " allows", true);
    const auto total = static_bytes + input_bytes + 2 * state_bytes + partial_bytes + readback_bytes + staging_bytes + 3 * 65536;
    const auto budget = gpu_->device().memory_budget();
    if (total > budget / 2)
        throw compute::ComputeError("the world needs " + std::to_string(total >> 20) + " MiB of device memory; " +
                                    std::to_string(budget >> 20) + " MiB is available", true);

    auto world = std::make_unique<World>();
    world->tables = &tables;
    constexpr auto storage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    constexpr auto src = VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
    constexpr auto dst = VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    world->static_words = Buffer(gpu_->device(), static_bytes, storage | dst, MemoryUse::Device, "static tables");
    world->inputs = Buffer(gpu_->device(), input_bytes, storage | dst, MemoryUse::Device, "inputs");
    world->state[0] = Buffer(gpu_->device(), state_bytes, storage | src | dst, MemoryUse::Device, "state A");
    world->state[1] = Buffer(gpu_->device(), state_bytes, storage | src | dst, MemoryUse::Device, "state B");
    world->partials = Buffer(gpu_->device(), partial_bytes, storage | src | dst, MemoryUse::Device, "partial sums");
    world->counters = Buffer(gpu_->device(), kMinimumBuffer, storage | src | dst, MemoryUse::Device, "counters");
    world->params = Buffer(gpu_->device(), 4096, storage, MemoryUse::Upload, "step parameters");
    world->records_inputs = Buffer(gpu_->device(), 65536, storage, MemoryUse::Upload, "input updates");
    world->records_state = Buffer(gpu_->device(), 4096, storage, MemoryUse::Upload, "state patches");
    world->indirect = Buffer(gpu_->device(), 64, VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, MemoryUse::Upload, "scatter dispatch sizes");
    world->readback = Buffer(gpu_->device(), readback_bytes, dst, MemoryUse::Readback, "readback");
    world->staging = Buffer(gpu_->device(), staging_bytes, src | dst, MemoryUse::Readback, "staging");
    world->node_groups = groups(tables.node_count, gpu_->workgroup());
    world->edge_groups = edge_groups;
    world->readback_partials = host_field_bytes;
    world->readback_counters = host_field_bytes + partial_bytes;
    std::memset(world->records_inputs.mapped(), 0, 16);
    std::memset(world->records_state.mapped(), 0, 16);

    world->descriptors = std::make_unique<DescriptorPool>(gpu_->device(), 5, 2 * 7 + 3 * 2);
    for (int p = 0; p < 2; ++p) {
        world->physics_set[p] = world->descriptors->allocate(*physics_layout_);
        world->scatter_state_set[p] = world->descriptors->allocate(gpu_->pair_layout());
    }
    world->scatter_inputs_set = world->descriptors->allocate(gpu_->pair_layout());
    world_ = std::move(world);

    // Both state buffers start as zeros, padding included: the kernels never
    // write the words between an array's last element and its stride, and a
    // device need not zero new memory.
    gpu_->run([&](VkCommandBuffer command) {
        const auto& vk = gpu_->device().vk();
        barrier(gpu_->device(), command, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, kDeviceWrites, VK_PIPELINE_STAGE_TRANSFER_BIT, kTransferAccess);
        for (auto* buffer : {&world_->state[0], &world_->state[1], &world_->inputs, &world_->partials})
            vk.vkCmdFillBuffer(command, buffer->handle(), 0, VK_WHOLE_SIZE, 0);
        barrier(gpu_->device(), command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, kComputeAndTransfer, kDeviceAccess);
    });

    // The static tables go up once, through the staging buffer.
    auto* staging = static_cast<std::uint8_t*>(world_->staging.mapped());
    std::memcpy(staging, tables.node_words.data(), tables.node_words.size() * 4);
    std::memcpy(staging + tables.node_words.size() * 4, tables.edge_words.data(), tables.edge_words.size() * 4);
    world_->staging.flush();
    gpu_->copy(world_->staging.handle(), 0, world_->static_words.handle(), 0, (tables.node_words.size() + tables.edge_words.size()) * 4, false);

    parity_ = 0;
    for (int p = 0; p < 2; ++p) {
        write_set(gpu_->device(), world_->physics_set[p], {world_->params.handle(), world_->static_words.handle(), world_->inputs.handle(),
                                                     world_->state[p].handle(), world_->state[1 - p].handle(),
                                                     world_->partials.handle(), world_->counters.handle()});
        write_set(gpu_->device(), world_->scatter_state_set[p], {world_->records_state.handle(), world_->state[p].handle()});
    }
    write_set(gpu_->device(), world_->scatter_inputs_set, {world_->records_inputs.handle(), world_->inputs.handle()});
    record_step(0);
    record_step(1);
}

void VulkanComputeBackend::release() {
    if (!world_) return;
    synchronize();
    world_.reset();
}

void VulkanComputeBackend::synchronize() { gpu_->synchronize(); }

void VulkanComputeBackend::ensure_capacity(Buffer& buffer, VkDeviceSize bytes, VkBufferUsageFlags usage, MemoryUse use,
                                           const char* label, bool& changed) {
    if (buffer.size() >= bytes) return;
    // Rare: grow to twice what is needed, so growth does not recur every step.
    buffer = Buffer(gpu_->device(), std::max<VkDeviceSize>(bytes * 2, kMinimumBuffer), usage, use, label);
    changed = true;
}

void VulkanComputeBackend::upload_state(const std::vector<std::uint32_t>& state) {
    guard();
    if (!world_) throw compute::ComputeError("no world installed on the device", true);
    std::memcpy(world_->staging.mapped(), state.data(), state.size() * 4);
    world_->staging.flush();
    gpu_->copy(world_->staging.handle(), 0, world_->state[parity_].handle(), 0, state.size() * 4, false);
}

void VulkanComputeBackend::download_state(std::vector<std::uint32_t>& host) {
    guard();
    if (!world_) throw compute::ComputeError("no world installed on the device", true);
    const auto words = world_->tables->state_words();
    gpu_->copy(world_->state[parity_].handle(), 0, world_->staging.handle(), 0, words * 4, true);
    world_->staging.invalidate();
    host.resize(words);
    std::memcpy(host.data(), world_->staging.mapped(), words * 4);
    // Test hook: a device that computes a wrong value, for verification mode to catch.
    if (options_.fault.kind == FaultInjection::Kind::Mismatch && steps_ >= options_.fault.at_step && world_->tables->edge_count)
        host[world_->tables->edge_state(physics::EV_SPEED, 0)] ^= 1u;
}

// --- The step ----------------------------------------------------------------------------

void VulkanComputeBackend::record_step(int p) {
    auto& w = *world_;
    const auto& t = *w.tables;
    const auto& vk = gpu_->device().vk();
    const auto command = step_commands_[p];
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    check(vk.vkBeginCommandBuffer(command, &begin), "vkBeginCommandBuffer");
    const auto first = std::uint32_t(p) * kTimestampsPerStep;
    // Order this step after everything submitted before it.
    barrier(gpu_->device(), command, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, kDeviceWrites, kComputeAndTransfer, kDeviceAccess);
    if (timestamps_) {
        timestamps_->reset(command, first, kTimestampsPerStep);
        timestamps_->write(command, first);
    }

    // 1. Host updates: changed inputs, then patches to the committed state.
    vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, scatter_pipeline_->handle());
    vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, gpu_->pair_layout().pipeline_layout(), 0, 1, &w.scatter_inputs_set, 0, nullptr);
    vk.vkCmdDispatchIndirect(command, w.indirect.handle(), 0);
    vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, gpu_->pair_layout().pipeline_layout(), 0, 1, &w.scatter_state_set[p], 0, nullptr);
    vk.vkCmdDispatchIndirect(command, w.indirect.handle(), sizeof(VkDispatchIndirectCommand));
    vk.vkCmdFillBuffer(command, w.counters.handle(), 0, 16, 0);
    barrier(gpu_->device(), command, kComputeAndTransfer, kDeviceWrites, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
            VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT);
    if (timestamps_) timestamps_->write(command, first + 1);

    // 2. Nodes: rain and flood into the candidate state.
    vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, node_pipeline_->handle());
    vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, physics_layout_->pipeline_layout(), 0, 1, &w.physics_set[p], 0, nullptr);
    if (w.node_groups) vk.vkCmdDispatch(command, w.node_groups, 1, 1);
    // The edge pass reads the node values just written.
    barrier(gpu_->device(), command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
            VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT);
    if (timestamps_) timestamps_->write(command, first + 2);

    // 3. Edges: environment, traffic, and the reductions.
    vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, edge_pipeline_->handle());
    if (w.edge_groups) vk.vkCmdDispatch(command, w.edge_groups, 1, 1);
    barrier(gpu_->device(), command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_READ_BIT);
    if (timestamps_) timestamps_->write(command, first + 3);

    // 4. What the host needs every step: three edge fields, the partial sums
    // and the counters. Everything else stays on the device.
    if (t.edge_count) {
        const VkBufferCopy fields{t.edge_state_base() * 4, 0, VkDeviceSize(physics::EDGE_HOST_FIELDS) * t.edge_stride * 4};
        vk.vkCmdCopyBuffer(command, w.state[1 - p].handle(), w.readback.handle(), 1, &fields);
        const VkBufferCopy partials{0, w.readback_partials, VkDeviceSize(w.edge_groups) * 8};
        vk.vkCmdCopyBuffer(command, w.partials.handle(), w.readback.handle(), 1, &partials);
    }
    const VkBufferCopy counters{0, w.readback_counters, 16};
    vk.vkCmdCopyBuffer(command, w.counters.handle(), w.readback.handle(), 1, &counters);
    barrier(gpu_->device(), command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
    if (timestamps_) timestamps_->write(command, first + 4);
    check(vk.vkEndCommandBuffer(command), "vkEndCommandBuffer");
}

void VulkanComputeBackend::step(const compute::StepWork& work, std::vector<std::uint32_t>& host, compute::StepResult& result) {
    guard();
    if (!world_) throw compute::ComputeError("no world installed on the device", true);
    ++steps_;
    if (options_.fault.at_step == steps_) {
        if (options_.fault.kind == FaultInjection::Kind::Submit)
            throw compute::ComputeError("injected fault: vkQueueSubmit failed", true);
        if (options_.fault.kind == FaultInjection::Kind::DeviceLost) {
            gpu_->mark_lost();
            throw VulkanError("injected fault: vkWaitSemaphores", VK_ERROR_DEVICE_LOST, false);
        }
    }
    const auto started = Clock::now();
    auto& w = *world_;
    const auto& t = *w.tables;
    compute::StepTelemetry telemetry;

    // Inputs: wholesale when the dispatcher asks (a new world or a backend
    // switch), otherwise only the words that changed.
    std::uint32_t input_records = 0;
    bool changed = false;
    const auto& inputs = work.inputs;
    if (inputs.full_upload_pending()) {
        std::memcpy(w.staging.mapped(), inputs.words().data(), inputs.words().size() * 4);
        w.staging.flush();
        gpu_->copy(w.staging.handle(), 0, w.inputs.handle(), 0, inputs.words().size() * 4, false);
        telemetry.upload_bytes += inputs.words().size() * 4;
    } else {
        input_records = static_cast<std::uint32_t>(inputs.dirty().size());
        ensure_capacity(w.records_inputs, 16 + VkDeviceSize(input_records) * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Upload, "input updates", changed);
        auto* records = static_cast<std::uint32_t*>(w.records_inputs.mapped());
        records[0] = input_records;
        for (std::uint32_t i = 0; i < input_records; ++i) {
            const auto offset = inputs.dirty()[i];
            records[4 + 2 * i] = offset;
            records[5 + 2 * i] = inputs.get(offset);
        }
        w.records_inputs.flush();
        telemetry.upload_bytes += 16 + std::uint64_t(input_records) * 8;
    }
    const auto state_records = static_cast<std::uint32_t>(work.state_patches.size());
    ensure_capacity(w.records_state, 16 + VkDeviceSize(state_records) * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Upload, "state patches", changed);
    auto* patches = static_cast<std::uint32_t*>(w.records_state.mapped());
    patches[0] = state_records;
    for (std::uint32_t i = 0; i < state_records; ++i) {
        patches[4 + 2 * i] = work.state_patches[i].first;
        patches[5 + 2 * i] = work.state_patches[i].second;
    }
    w.records_state.flush();

    const auto& params = work.params.words;
    ensure_capacity(w.params, VkDeviceSize(params.size()) * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Upload, "step parameters", changed);
    std::memcpy(w.params.mapped(), params.data(), params.size() * 4);
    w.params.flush();
    telemetry.upload_bytes += params.size() * 4 + 16 + std::uint64_t(state_records) * 8;

    auto* indirect = static_cast<VkDispatchIndirectCommand*>(w.indirect.mapped());
    indirect[0] = {groups(input_records, gpu_->workgroup()), 1, 1};
    indirect[1] = {groups(state_records, gpu_->workgroup()), 1, 1};
    w.indirect.flush();

    if (changed) {
        // A host buffer grew: point the descriptor sets at the new buffers and
        // re-record the two step command buffers.
        for (int p = 0; p < 2; ++p) {
            write_set(gpu_->device(), w.physics_set[p], {w.params.handle(), w.static_words.handle(), w.inputs.handle(), w.state[p].handle(),
                                                   w.state[1 - p].handle(), w.partials.handle(), w.counters.handle()});
            write_set(gpu_->device(), w.scatter_state_set[p], {w.records_state.handle(), w.state[p].handle()});
        }
        write_set(gpu_->device(), w.scatter_inputs_set, {w.records_inputs.handle(), w.inputs.handle()});
        record_step(0);
        record_step(1);
    }

    const auto value = gpu_->timeline().submit(step_commands_[parity_]);
    try {
        gpu_->timeline().wait(value, options_.timeout_s);
    } catch (const compute::ComputeError& e) {
        if (e.device_lost() || !e.state_intact()) gpu_->mark_lost();
        throw;
    }

    // The step completed: read what the host needs, then commit.
    w.readback.invalidate();
    const auto* readback = static_cast<const std::uint8_t*>(w.readback.mapped());
    if (t.edge_count) std::memcpy(host.data() + t.edge_state_base(), readback, std::size_t(physics::EDGE_HOST_FIELDS) * t.edge_stride * 4);
    result = {};
    const auto* partials = reinterpret_cast<const std::uint64_t*>(readback + w.readback_partials);
    for (std::uint32_t g = 0; g < w.edge_groups; ++g) result.congestion_sum += partials[g];
    result.transitions = reinterpret_cast<const std::uint32_t*>(readback + w.readback_counters)[0];
    parity_ = 1 - parity_;

    telemetry.readback_bytes = std::uint64_t(physics::EDGE_HOST_FIELDS) * t.edge_stride * 4 + std::uint64_t(w.edge_groups) * 8 + 16;
    telemetry.dispatches = 4;
    if (timestamps_) {
        const auto ms = timestamps_->intervals(std::uint32_t(1 - parity_) * kTimestampsPerStep, kTimestampsPerStep);
        static const char* names[] = {"upload", "nodes", "edges", "readback"};
        for (std::size_t i = 0; i < ms.size(); ++i) {
            telemetry.passes.emplace_back(names[i], ms[i]);
            telemetry.device_ms += ms[i];
        }
    }
    telemetry.host_ms = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
    telemetry_ = std::move(telemetry);
}

} // namespace dstns::vulkan
