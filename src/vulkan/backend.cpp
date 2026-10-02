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

std::uint32_t choose_workgroup(const DeviceInfo& info, std::uint32_t requested) {
    const auto& limits = info.properties.limits;
    const auto fits = [&](std::uint32_t size) {
        return limits.maxComputeWorkGroupSize[0] >= size && limits.maxComputeWorkGroupInvocations >= size &&
               // the edge pass keeps one 64-bit partial sum per invocation in shared memory
               limits.maxComputeSharedMemorySize >= 256 * sizeof(std::uint64_t);
    };
    if (requested && fits(requested)) return requested;
    // 128 is the measured default (docs/deployment/performance.md): a multiple
    // of every vendor's SIMD width (32 or 64) and within every device's limits.
    for (const std::uint32_t size : {128u, 64u})
        if (fits(size)) return size;
    return 64;
}
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
    instance_ = std::make_unique<Instance>(options, log);
    devices_ = enumerate_devices(*instance_, options.allow_software_vulkan);
    std::string reason;
    const auto* chosen = select_device(devices_, options, reason);
    if (!chosen) throw std::runtime_error(reason);
    info_ = *chosen;
    device_ = std::make_unique<Device>(*instance_, info_);
    workgroup_ = choose_workgroup(info_, options.workgroup_size);

    cache_ = std::make_unique<PipelineCache>(*device_, options.cache_dir, shaders::kBundleSha256, log);
    physics_layout_ = std::make_unique<BindingLayout>(*device_, 7);
    pair_layout_ = std::make_unique<BindingLayout>(*device_, 2);
    auto shader = [](const char* name) -> const shaders::Binary& {
        const auto* binary = shaders::find(name);
        if (!binary) throw std::runtime_error(std::string("shader ") + name + " is missing from the bundle");
        return *binary;
    };
    if (options.fault.kind == FaultInjection::Kind::Pipeline) throw VulkanError("injected fault: vkCreateComputePipelines", VK_ERROR_INITIALIZATION_FAILED);
    node_pipeline_ = std::make_unique<ComputePipeline>(*device_, *physics_layout_, shader("node_step"), workgroup_, cache_->handle());
    edge_pipeline_ = std::make_unique<ComputePipeline>(*device_, *physics_layout_, shader("edge_step"), workgroup_, cache_->handle());
    scatter_pipeline_ = std::make_unique<ComputePipeline>(*device_, *pair_layout_, shader("scatter"), workgroup_, cache_->handle());
    self_test_pipeline_ = std::make_unique<ComputePipeline>(*device_, *pair_layout_, shader("self_test"), workgroup_, cache_->handle());
    cache_->save();

    commands_ = std::make_unique<CommandPool>(*device_, static_cast<std::uint32_t>(info_.queue_family));
    timeline_ = std::make_unique<Timeline>(*device_);
    if (info_.timestamps) timestamps_ = std::make_unique<Timestamps>(*device_, 2 * kTimestampsPerStep);
    step_commands_[0] = commands_->allocate();
    step_commands_[1] = commands_->allocate();
    transfer_command_ = commands_->allocate();

    // A device is used only after it has proved it computes correctly.
    self_test();
}

VulkanComputeBackend::~VulkanComputeBackend() {
    try {
        if (!lost_ && timeline_) timeline_->wait(timeline_->last(), options_.timeout_s);
    } catch (...) {
    }
    world_.reset();
    if (cache_ && !lost_) cache_->save();
}

compute::ComputeCapabilities VulkanComputeBackend::capabilities() const {
    compute::ComputeCapabilities c;
    c.available = !lost_;
    c.hardware_accelerated = !info_.software;
    c.name = info_.name;
    c.vendor = info_.vendor_name();
    c.vendor_id = info_.properties.vendorID;
    c.device_id = info_.properties.deviceID;
    c.driver = info_.driver_name;
    c.driver_version = info_.driver_version_string();
    c.device_type = info_.type_name();
    c.api_version = version_string(info_.properties.apiVersion);
    c.uuid = info_.uuid;
    c.device_memory_bytes = info_.device_local_bytes;
    c.moltenvk = info_.moltenvk();
    c.portability_subset = info_.portability_subset;
    c.timestamps = timestamps_ != nullptr;
    c.synchronization2 = device_->synchronization2();
    c.validation = instance_->validation();
    c.unified_memory = info_.unified_memory;
    c.queue_family = static_cast<std::uint32_t>(info_.queue_family);
    c.workgroup_size = workgroup_;
    c.pipeline_cache = cache_->state();
    c.shader_bundle = shaders::kBundleSha256;
    return c;
}

void VulkanComputeBackend::guard() const {
    if (lost_) throw VulkanError("the device was lost earlier", VK_ERROR_DEVICE_LOST, false);
}

// --- Self-test -------------------------------------------------------------------------

double VulkanComputeBackend::self_test() {
    guard();
    const auto started = Clock::now();
    constexpr std::uint32_t kCount = 1000; // more than one workgroup, and not a multiple of one
    Buffer input(*device_, 16 + kCount * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Upload, "self-test input");
    Buffer output(*device_, (kCount + 1) * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, MemoryUse::Readback, "self-test output");
    auto* in = static_cast<std::uint32_t*>(input.mapped());
    in[0] = kCount;
    in[1] = in[2] = in[3] = 0;
    for (std::uint32_t i = 0; i < kCount; ++i) in[4 + i] = i + 1; // 1, 2, 3, 4, ...
    input.flush();
    std::memset(output.mapped(), 0, (kCount + 1) * 4);

    DescriptorPool pool(*device_, 1, 2);
    const auto set = pool.allocate(*pair_layout_);
    write_set(*device_, set, {input.handle(), output.handle()});
    const auto& vk = device_->vk();
    const auto command = transfer_command_;
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(vk.vkBeginCommandBuffer(command, &begin), "vkBeginCommandBuffer");
    vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, self_test_pipeline_->handle());
    vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, pair_layout_->pipeline_layout(), 0, 1, &set, 0, nullptr);
    vk.vkCmdDispatch(command, groups(kCount, workgroup_), 1, 1);
    barrier(*device_, command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT, VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
    check(vk.vkEndCommandBuffer(command), "vkEndCommandBuffer");
    timeline_->wait(timeline_->submit(command), options_.timeout_s);
    output.invalidate();

    const auto* out = static_cast<const std::uint32_t*>(output.mapped());
    for (std::uint32_t i = 0; i < kCount; ++i) {
        const auto expected = (i + 1) * 7 + 3; // 10, 17, 24, 31, ...
        if (out[i] != expected) {
            std::ostringstream message;
            message << "self-test failed: element " << i << " is " << out[i] << ", expected " << expected;
            throw std::runtime_error(message.str());
        }
    }
    const auto root = static_cast<std::uint32_t>(physics::isqrt64((std::uint64_t(1) << 40) + 12345));
    if (out[kCount] != root)
        throw std::runtime_error("self-test failed: 64-bit integer arithmetic gave " + std::to_string(out[kCount]) + ", expected " + std::to_string(root));
    return std::chrono::duration<double, std::milli>(Clock::now() - started).count();
}

// --- World resources ----------------------------------------------------------------------

void VulkanComputeBackend::install(const compute::StaticTables& tables) {
    guard();
    release();
    if (options_.fault.kind == FaultInjection::Kind::Allocation)
        throw compute::ComputeError("injected fault: device memory allocation failed", true);

    const auto& limits = info_.properties.limits;
    const auto state_bytes = bytes_of(tables.state_words());
    const auto static_bytes = bytes_of(tables.node_words.size() + tables.edge_words.size());
    const auto input_bytes = bytes_of(tables.input_words());
    const auto edge_groups = groups(tables.edge_count, workgroup_);
    const auto partial_bytes = std::max<VkDeviceSize>(kMinimumBuffer, VkDeviceSize(edge_groups) * 8);
    const auto host_field_bytes = VkDeviceSize(physics::EDGE_HOST_FIELDS) * tables.edge_stride * 4;
    const auto readback_bytes = host_field_bytes + partial_bytes + 16;
    const auto staging_bytes = std::max({state_bytes, static_bytes, input_bytes});

    // Refuse a world that cannot fit before allocating any of it, rather than
    // discovering it as VK_ERROR_OUT_OF_DEVICE_MEMORY halfway through.
    const auto largest = std::max({state_bytes, static_bytes, input_bytes});
    if (largest > limits.maxStorageBufferRange)
        throw compute::ComputeError("the world needs a " + std::to_string(largest >> 20) + " MiB storage buffer; " + info_.name +
                                    " binds at most " + std::to_string(limits.maxStorageBufferRange >> 20) + " MiB", true);
    if (info_.max_allocation && largest > info_.max_allocation)
        throw compute::ComputeError("the world needs a larger single allocation than " + info_.name + " allows", true);
    const auto total = static_bytes + input_bytes + 2 * state_bytes + partial_bytes + readback_bytes + staging_bytes + 3 * 65536;
    const auto budget = device_->memory_budget();
    if (total > budget / 2)
        throw compute::ComputeError("the world needs " + std::to_string(total >> 20) + " MiB of device memory; " +
                                    std::to_string(budget >> 20) + " MiB is available", true);

    auto world = std::make_unique<World>();
    world->tables = &tables;
    constexpr auto storage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    constexpr auto src = VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
    constexpr auto dst = VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    world->static_words = Buffer(*device_, static_bytes, storage | dst, MemoryUse::Device, "static tables");
    world->inputs = Buffer(*device_, input_bytes, storage | dst, MemoryUse::Device, "inputs");
    world->state[0] = Buffer(*device_, state_bytes, storage | src | dst, MemoryUse::Device, "state A");
    world->state[1] = Buffer(*device_, state_bytes, storage | src | dst, MemoryUse::Device, "state B");
    world->partials = Buffer(*device_, partial_bytes, storage | src | dst, MemoryUse::Device, "partial sums");
    world->counters = Buffer(*device_, kMinimumBuffer, storage | src | dst, MemoryUse::Device, "counters");
    world->params = Buffer(*device_, 4096, storage, MemoryUse::Upload, "step parameters");
    world->records_inputs = Buffer(*device_, 65536, storage, MemoryUse::Upload, "input updates");
    world->records_state = Buffer(*device_, 4096, storage, MemoryUse::Upload, "state patches");
    world->indirect = Buffer(*device_, 64, VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, MemoryUse::Upload, "scatter dispatch sizes");
    world->readback = Buffer(*device_, readback_bytes, dst, MemoryUse::Readback, "readback");
    world->staging = Buffer(*device_, staging_bytes, src | dst, MemoryUse::Readback, "staging");
    world->node_groups = groups(tables.node_count, workgroup_);
    world->edge_groups = edge_groups;
    world->readback_partials = host_field_bytes;
    world->readback_counters = host_field_bytes + partial_bytes;
    std::memset(world->records_inputs.mapped(), 0, 16);
    std::memset(world->records_state.mapped(), 0, 16);

    world->descriptors = std::make_unique<DescriptorPool>(*device_, 5, 2 * 7 + 3 * 2);
    for (int p = 0; p < 2; ++p) {
        world->physics_set[p] = world->descriptors->allocate(*physics_layout_);
        world->scatter_state_set[p] = world->descriptors->allocate(*pair_layout_);
    }
    world->scatter_inputs_set = world->descriptors->allocate(*pair_layout_);
    world_ = std::move(world);

    // Both state buffers start as zeros, padding included: the kernels never
    // write the words between an array's last element and its stride, and a
    // device need not zero new memory.
    {
        const auto& vk = device_->vk();
        const auto command = transfer_command_;
        VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
        begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        check(vk.vkBeginCommandBuffer(command, &begin), "vkBeginCommandBuffer");
        barrier(*device_, command, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, kDeviceWrites, VK_PIPELINE_STAGE_TRANSFER_BIT, kTransferAccess);
        for (auto* buffer : {&world_->state[0], &world_->state[1], &world_->inputs, &world_->partials})
            vk.vkCmdFillBuffer(command, buffer->handle(), 0, VK_WHOLE_SIZE, 0);
        barrier(*device_, command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, kComputeAndTransfer, kDeviceAccess);
        check(vk.vkEndCommandBuffer(command), "vkEndCommandBuffer");
        timeline_->wait(timeline_->submit(command), options_.timeout_s);
    }

    // The static tables go up once, through the staging buffer.
    auto* staging = static_cast<std::uint8_t*>(world_->staging.mapped());
    std::memcpy(staging, tables.node_words.data(), tables.node_words.size() * 4);
    std::memcpy(staging + tables.node_words.size() * 4, tables.edge_words.data(), tables.edge_words.size() * 4);
    world_->staging.flush();
    transfer(world_->staging.handle(), 0, world_->static_words.handle(), 0, (tables.node_words.size() + tables.edge_words.size()) * 4, false);

    parity_ = 0;
    for (int p = 0; p < 2; ++p) {
        write_set(*device_, world_->physics_set[p], {world_->params.handle(), world_->static_words.handle(), world_->inputs.handle(),
                                                     world_->state[p].handle(), world_->state[1 - p].handle(),
                                                     world_->partials.handle(), world_->counters.handle()});
        write_set(*device_, world_->scatter_state_set[p], {world_->records_state.handle(), world_->state[p].handle()});
    }
    write_set(*device_, world_->scatter_inputs_set, {world_->records_inputs.handle(), world_->inputs.handle()});
    record_step(0);
    record_step(1);
}

void VulkanComputeBackend::release() {
    if (!world_) return;
    synchronize();
    world_.reset();
}

void VulkanComputeBackend::synchronize() {
    if (lost_ || !timeline_) return;
    timeline_->wait(timeline_->last(), options_.timeout_s);
}

void VulkanComputeBackend::ensure_capacity(Buffer& buffer, VkDeviceSize bytes, VkBufferUsageFlags usage, MemoryUse use,
                                           const char* label, bool& changed) {
    if (buffer.size() >= bytes) return;
    // Rare: grow to twice what is needed, so growth does not recur every step.
    buffer = Buffer(*device_, std::max<VkDeviceSize>(bytes * 2, kMinimumBuffer), usage, use, label);
    changed = true;
}

// One-shot copy between buffers, waited for. Used for full uploads and
// downloads, which happen at world installation, checkpoints, seeks and
// backend switches, never in the per-step path.
void VulkanComputeBackend::transfer(VkBuffer source, VkDeviceSize source_offset, VkBuffer target, VkDeviceSize target_offset,
                                    VkDeviceSize bytes, bool to_host) {
    if (bytes == 0) return;
    const auto& vk = device_->vk();
    const auto command = transfer_command_;
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    check(vk.vkBeginCommandBuffer(command, &begin), "vkBeginCommandBuffer");
    barrier(*device_, command, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, kDeviceWrites, VK_PIPELINE_STAGE_TRANSFER_BIT, kTransferAccess);
    const VkBufferCopy region{source_offset, target_offset, bytes};
    vk.vkCmdCopyBuffer(command, source, target, 1, &region);
    if (to_host) barrier(*device_, command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
    else barrier(*device_, command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, kComputeAndTransfer, kDeviceAccess);
    check(vk.vkEndCommandBuffer(command), "vkEndCommandBuffer");
    timeline_->wait(timeline_->submit(command), options_.timeout_s);
}

void VulkanComputeBackend::upload_state(const std::vector<std::uint32_t>& state) {
    guard();
    if (!world_) throw compute::ComputeError("no world installed on the device", true);
    std::memcpy(world_->staging.mapped(), state.data(), state.size() * 4);
    world_->staging.flush();
    transfer(world_->staging.handle(), 0, world_->state[parity_].handle(), 0, state.size() * 4, false);
}

void VulkanComputeBackend::download_state(std::vector<std::uint32_t>& host) {
    guard();
    if (!world_) throw compute::ComputeError("no world installed on the device", true);
    const auto words = world_->tables->state_words();
    transfer(world_->state[parity_].handle(), 0, world_->staging.handle(), 0, words * 4, true);
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
    const auto& vk = device_->vk();
    const auto command = step_commands_[p];
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    check(vk.vkBeginCommandBuffer(command, &begin), "vkBeginCommandBuffer");
    const auto first = std::uint32_t(p) * kTimestampsPerStep;
    // Order this step after everything submitted before it.
    barrier(*device_, command, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, kDeviceWrites, kComputeAndTransfer, kDeviceAccess);
    if (timestamps_) {
        timestamps_->reset(command, first, kTimestampsPerStep);
        timestamps_->write(command, first);
    }

    // 1. Host updates: changed inputs, then patches to the committed state.
    vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, scatter_pipeline_->handle());
    vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, pair_layout_->pipeline_layout(), 0, 1, &w.scatter_inputs_set, 0, nullptr);
    vk.vkCmdDispatchIndirect(command, w.indirect.handle(), 0);
    vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, pair_layout_->pipeline_layout(), 0, 1, &w.scatter_state_set[p], 0, nullptr);
    vk.vkCmdDispatchIndirect(command, w.indirect.handle(), sizeof(VkDispatchIndirectCommand));
    vk.vkCmdFillBuffer(command, w.counters.handle(), 0, 16, 0);
    barrier(*device_, command, kComputeAndTransfer, kDeviceWrites, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
            VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT);
    if (timestamps_) timestamps_->write(command, first + 1);

    // 2. Nodes: rain and flood into the candidate state.
    vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, node_pipeline_->handle());
    vk.vkCmdBindDescriptorSets(command, VK_PIPELINE_BIND_POINT_COMPUTE, physics_layout_->pipeline_layout(), 0, 1, &w.physics_set[p], 0, nullptr);
    if (w.node_groups) vk.vkCmdDispatch(command, w.node_groups, 1, 1);
    // The edge pass reads the node values just written.
    barrier(*device_, command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
            VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT);
    if (timestamps_) timestamps_->write(command, first + 2);

    // 3. Edges: environment, traffic, and the reductions.
    vk.vkCmdBindPipeline(command, VK_PIPELINE_BIND_POINT_COMPUTE, edge_pipeline_->handle());
    if (w.edge_groups) vk.vkCmdDispatch(command, w.edge_groups, 1, 1);
    barrier(*device_, command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_ACCESS_SHADER_WRITE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_READ_BIT);
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
    barrier(*device_, command, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_ACCESS_TRANSFER_WRITE_BIT, VK_PIPELINE_STAGE_HOST_BIT, VK_ACCESS_HOST_READ_BIT);
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
            lost_ = true;
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
        transfer(w.staging.handle(), 0, w.inputs.handle(), 0, inputs.words().size() * 4, false);
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
    indirect[0] = {groups(input_records, workgroup_), 1, 1};
    indirect[1] = {groups(state_records, workgroup_), 1, 1};
    w.indirect.flush();

    if (changed) {
        // A host buffer grew: point the descriptor sets at the new buffers and
        // re-record the two step command buffers.
        for (int p = 0; p < 2; ++p) {
            write_set(*device_, w.physics_set[p], {w.params.handle(), w.static_words.handle(), w.inputs.handle(), w.state[p].handle(),
                                                   w.state[1 - p].handle(), w.partials.handle(), w.counters.handle()});
            write_set(*device_, w.scatter_state_set[p], {w.records_state.handle(), w.state[p].handle()});
        }
        write_set(*device_, w.scatter_inputs_set, {w.records_inputs.handle(), w.inputs.handle()});
        record_step(0);
        record_step(1);
    }

    const auto value = timeline_->submit(step_commands_[parity_]);
    try {
        timeline_->wait(value, options_.timeout_s);
    } catch (const compute::ComputeError& e) {
        if (e.device_lost() || !e.state_intact()) lost_ = true;
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
