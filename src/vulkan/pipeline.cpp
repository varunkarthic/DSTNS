// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "pipeline.hpp"

#include <cctype>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <sstream>

namespace dstns::vulkan {
namespace {

constexpr char kCacheMagic[8] = {'D', 'S', 'T', 'N', 'S', 'P', 'C', '1'};

std::string sanitise(const std::string& text) {
    std::string out;
    for (const char c : text) out += (std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == '_') ? c : '_';
    return out.empty() ? "unknown" : out;
}

} // namespace

// --- Binding layout -----------------------------------------------------------------

BindingLayout::BindingLayout(const Device& device, std::uint32_t bindings) : device_(device), bindings_(bindings) {
    std::vector<VkDescriptorSetLayoutBinding> list(bindings);
    for (std::uint32_t i = 0; i < bindings; ++i) {
        list[i].binding = i;
        list[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        list[i].descriptorCount = 1;
        list[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    }
    VkDescriptorSetLayoutCreateInfo info{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
    info.bindingCount = bindings;
    info.pBindings = list.data();
    check(device.vk().vkCreateDescriptorSetLayout(device.handle(), &info, nullptr, &set_layout_), "vkCreateDescriptorSetLayout");
    VkPipelineLayoutCreateInfo layout{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
    layout.setLayoutCount = 1;
    layout.pSetLayouts = &set_layout_;
    const auto result = device.vk().vkCreatePipelineLayout(device.handle(), &layout, nullptr, &pipeline_layout_);
    if (result != VK_SUCCESS) {
        device.vk().vkDestroyDescriptorSetLayout(device.handle(), set_layout_, nullptr);
        throw VulkanError("vkCreatePipelineLayout", result);
    }
}

BindingLayout::~BindingLayout() {
    device_.vk().vkDestroyPipelineLayout(device_.handle(), pipeline_layout_, nullptr);
    device_.vk().vkDestroyDescriptorSetLayout(device_.handle(), set_layout_, nullptr);
}

// --- Pipeline cache ------------------------------------------------------------------

PipelineCache::PipelineCache(const Device& device, const std::string& directory, const std::string& bundle_hash, const compute::LogSink& log)
    : device_(device), bundle_hash_(bundle_hash), log_(log) {
    const auto& props = device.info().properties;
    std::vector<char> initial;
    if (!directory.empty()) {
        std::ostringstream id;
        id << std::hex << std::setfill('0') << std::setw(4) << props.vendorID << '-' << std::setw(4) << props.deviceID;
        path_ = std::filesystem::path(directory) / id.str() / sanitise(device.info().driver_name + "-" + device.info().driver_version_string()) / "pipeline.cache";
        std::ifstream in(path_, std::ios::binary);
        if (in) {
            std::vector<char> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
            // Our header: magic, the bundle hash, then the driver's own data.
            const std::size_t ours = sizeof(kCacheMagic) + 64;
            bool valid = bytes.size() > ours + 32 && std::memcmp(bytes.data(), kCacheMagic, sizeof(kCacheMagic)) == 0 &&
                         std::string(bytes.data() + sizeof(kCacheMagic), 64) == bundle_hash_;
            if (valid) {
                // The driver's header: size, version, vendor, device, cache UUID.
                std::uint32_t header[4];
                std::memcpy(header, bytes.data() + ours, sizeof(header));
                valid = header[0] >= 32 && header[1] == VK_PIPELINE_CACHE_HEADER_VERSION_ONE && header[2] == props.vendorID &&
                        header[3] == props.deviceID && std::memcmp(bytes.data() + ours + 16, props.pipelineCacheUUID, VK_UUID_SIZE) == 0;
            }
            if (valid) {
                initial.assign(bytes.begin() + static_cast<std::ptrdiff_t>(ours), bytes.end());
            } else if (log_) {
                log_("INFO", "compute.vulkan.pipeline_cache discarded a cache written by a different device, driver or shader bundle");
            }
        }
    }
    VkPipelineCacheCreateInfo info{VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO};
    info.initialDataSize = initial.size();
    info.pInitialData = initial.empty() ? nullptr : initial.data();
    if (device.vk().vkCreatePipelineCache(device.handle(), &info, nullptr, &cache_) != VK_SUCCESS) {
        // A cache the driver rejects is no cache at all: start empty.
        info.initialDataSize = 0;
        info.pInitialData = nullptr;
        initial.clear();
        check(device.vk().vkCreatePipelineCache(device.handle(), &info, nullptr, &cache_), "vkCreatePipelineCache");
    }
    state_ = path_.empty() ? "disabled" : (initial.empty() ? "cold" : "warm");
}

PipelineCache::~PipelineCache() { device_.vk().vkDestroyPipelineCache(device_.handle(), cache_, nullptr); }

void PipelineCache::save() const {
    if (path_.empty()) return;
    try {
        std::size_t size = 0;
        if (device_.vk().vkGetPipelineCacheData(device_.handle(), cache_, &size, nullptr) != VK_SUCCESS || size == 0) return;
        std::vector<char> data(size);
        if (device_.vk().vkGetPipelineCacheData(device_.handle(), cache_, &size, data.data()) != VK_SUCCESS) return;
        std::filesystem::create_directories(path_.parent_path());
        const auto temporary = path_.string() + ".tmp";
        {
            std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
            out.write(kCacheMagic, sizeof(kCacheMagic));
            out.write(bundle_hash_.data(), 64);
            out.write(data.data(), static_cast<std::streamsize>(size));
            if (!out) throw std::runtime_error("write failed");
        }
        std::filesystem::rename(temporary, path_);
    } catch (const std::exception& e) {
        if (log_) log_("INFO", std::string("compute.vulkan.pipeline_cache not saved: ") + e.what());
    }
}

// --- Pipelines -----------------------------------------------------------------------

ComputePipeline::ComputePipeline(const Device& device, const BindingLayout& layout, const shaders::Binary& shader,
                                 std::uint32_t workgroup_size, VkPipelineCache cache)
    : device_(device), layout_(layout) {
    VkShaderModuleCreateInfo module_info{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    module_info.codeSize = shader.word_count * sizeof(std::uint32_t);
    module_info.pCode = shader.words;
    VkShaderModule module{};
    check(device.vk().vkCreateShaderModule(device.handle(), &module_info, nullptr, &module), "vkCreateShaderModule");

    // The workgroup size is specialisation constant 0 in every shader.
    const VkSpecializationMapEntry entry{0, 0, sizeof(std::uint32_t)};
    VkSpecializationInfo specialisation{};
    specialisation.mapEntryCount = 1;
    specialisation.pMapEntries = &entry;
    specialisation.dataSize = sizeof(workgroup_size);
    specialisation.pData = &workgroup_size;

    VkComputePipelineCreateInfo info{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
    info.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    info.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    info.stage.module = module;
    info.stage.pName = "main";
    info.stage.pSpecializationInfo = &specialisation;
    info.layout = layout.pipeline_layout();
    const auto result = device.vk().vkCreateComputePipelines(device.handle(), cache, 1, &info, nullptr, &pipeline_);
    // The module is only needed while the pipeline is created.
    device.vk().vkDestroyShaderModule(device.handle(), module, nullptr);
    if (result != VK_SUCCESS) throw VulkanError(std::string("vkCreateComputePipelines(") + shader.name + ")", result);
    device.name(VK_OBJECT_TYPE_PIPELINE, reinterpret_cast<std::uint64_t>(pipeline_), shader.name);
}

ComputePipeline::~ComputePipeline() { device_.vk().vkDestroyPipeline(device_.handle(), pipeline_, nullptr); }

// --- Descriptors -----------------------------------------------------------------------

DescriptorPool::DescriptorPool(const Device& device, std::uint32_t sets, std::uint32_t buffers) : device_(device) {
    const VkDescriptorPoolSize size{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, buffers};
    VkDescriptorPoolCreateInfo info{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
    info.maxSets = sets;
    info.poolSizeCount = 1;
    info.pPoolSizes = &size;
    check(device.vk().vkCreateDescriptorPool(device.handle(), &info, nullptr, &pool_), "vkCreateDescriptorPool");
}

DescriptorPool::~DescriptorPool() { device_.vk().vkDestroyDescriptorPool(device_.handle(), pool_, nullptr); }

VkDescriptorSet DescriptorPool::allocate(const BindingLayout& layout) {
    const auto set_layout = layout.set_layout();
    VkDescriptorSetAllocateInfo info{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
    info.descriptorPool = pool_;
    info.descriptorSetCount = 1;
    info.pSetLayouts = &set_layout;
    VkDescriptorSet set{};
    check(device_.vk().vkAllocateDescriptorSets(device_.handle(), &info, &set), "vkAllocateDescriptorSets");
    return set;
}

void write_set(const Device& device, VkDescriptorSet set, const std::vector<VkBuffer>& buffers) {
    std::vector<VkDescriptorBufferInfo> infos(buffers.size());
    std::vector<VkWriteDescriptorSet> writes(buffers.size());
    for (std::size_t i = 0; i < buffers.size(); ++i) {
        infos[i] = {buffers[i], 0, VK_WHOLE_SIZE};
        writes[i] = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
        writes[i].dstSet = set;
        writes[i].dstBinding = static_cast<std::uint32_t>(i);
        writes[i].descriptorCount = 1;
        writes[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        writes[i].pBufferInfo = &infos[i];
    }
    device.vk().vkUpdateDescriptorSets(device.handle(), static_cast<std::uint32_t>(writes.size()), writes.data(), 0, nullptr);
}

} // namespace dstns::vulkan
