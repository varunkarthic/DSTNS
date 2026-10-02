// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "context.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string_view>

namespace dstns::vulkan {

const char* result_name(VkResult r) {
    switch (r) {
        case VK_SUCCESS: return "VK_SUCCESS";
        case VK_NOT_READY: return "VK_NOT_READY";
        case VK_TIMEOUT: return "VK_TIMEOUT";
        case VK_INCOMPLETE: return "VK_INCOMPLETE";
        case VK_ERROR_OUT_OF_HOST_MEMORY: return "VK_ERROR_OUT_OF_HOST_MEMORY";
        case VK_ERROR_OUT_OF_DEVICE_MEMORY: return "VK_ERROR_OUT_OF_DEVICE_MEMORY";
        case VK_ERROR_INITIALIZATION_FAILED: return "VK_ERROR_INITIALIZATION_FAILED";
        case VK_ERROR_DEVICE_LOST: return "VK_ERROR_DEVICE_LOST";
        case VK_ERROR_MEMORY_MAP_FAILED: return "VK_ERROR_MEMORY_MAP_FAILED";
        case VK_ERROR_LAYER_NOT_PRESENT: return "VK_ERROR_LAYER_NOT_PRESENT";
        case VK_ERROR_EXTENSION_NOT_PRESENT: return "VK_ERROR_EXTENSION_NOT_PRESENT";
        case VK_ERROR_FEATURE_NOT_PRESENT: return "VK_ERROR_FEATURE_NOT_PRESENT";
        case VK_ERROR_INCOMPATIBLE_DRIVER: return "VK_ERROR_INCOMPATIBLE_DRIVER";
        case VK_ERROR_TOO_MANY_OBJECTS: return "VK_ERROR_TOO_MANY_OBJECTS";
        case VK_ERROR_FORMAT_NOT_SUPPORTED: return "VK_ERROR_FORMAT_NOT_SUPPORTED";
        case VK_ERROR_FRAGMENTED_POOL: return "VK_ERROR_FRAGMENTED_POOL";
        case VK_ERROR_OUT_OF_POOL_MEMORY: return "VK_ERROR_OUT_OF_POOL_MEMORY";
        case VK_ERROR_INVALID_EXTERNAL_HANDLE: return "VK_ERROR_INVALID_EXTERNAL_HANDLE";
        case VK_ERROR_FRAGMENTATION: return "VK_ERROR_FRAGMENTATION";
        case VK_ERROR_UNKNOWN: return "VK_ERROR_UNKNOWN";
        default: return "VkResult(unknown)";
    }
}

std::string version_string(std::uint32_t v) {
    return std::to_string(VK_API_VERSION_MAJOR(v)) + "." + std::to_string(VK_API_VERSION_MINOR(v)) + "." + std::to_string(VK_API_VERSION_PATCH(v));
}

namespace {

constexpr const char* kValidationLayer = "VK_LAYER_KHRONOS_validation";

VKAPI_ATTR VkBool32 VKAPI_CALL on_message(VkDebugUtilsMessageSeverityFlagBitsEXT severity, VkDebugUtilsMessageTypeFlagsEXT,
                                          const VkDebugUtilsMessengerCallbackDataEXT* data, void* user) {
    auto* counters = static_cast<ValidationCounters*>(user);
    const bool error = severity & VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT;
    auto& count = error ? counters->errors : counters->warnings;
    const auto seen = count.fetch_add(1);
    // Report the first few in full; a flood of one message helps nobody.
    if (counters->log && seen < 20)
        counters->log(error ? "ERROR" : "WARN", std::string("compute.vulkan.validation ") + (data && data->pMessage ? data->pMessage : ""));
    return VK_FALSE;
}

bool has_extension(const std::vector<VkExtensionProperties>& list, const char* name) {
    return std::any_of(list.begin(), list.end(), [&](const auto& e) { return std::strcmp(e.extensionName, name) == 0; });
}

std::string format_uuid(const std::uint8_t* bytes) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (unsigned i = 0; i < VK_UUID_SIZE; ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) out << '-';
        out << std::setw(2) << int(bytes[i]);
    }
    return out.str();
}

std::string lower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

} // namespace

// --- Instance -------------------------------------------------------------------

Instance::Instance(const compute::ComputeOptions& options, const compute::LogSink& log)
    : counters_(std::make_unique<ValidationCounters>()) {
    counters_->log = log;
    library_ = &load_library(options.library);
    if (!library_->loaded) throw std::runtime_error(library_->error);

    std::uint32_t loader_version = VK_API_VERSION_1_0;
    if (vkEnumerateInstanceVersion) vkEnumerateInstanceVersion(&loader_version);
    if (loader_version < VK_API_VERSION_1_2)
        throw std::runtime_error("the Vulkan loader supports only Vulkan " + version_string(loader_version) + "; DSTNS needs 1.2");
    api_version_ = std::min(loader_version & ~0xFFFu, VK_API_VERSION_1_3);

    std::uint32_t count = 0;
    vkEnumerateInstanceExtensionProperties(nullptr, &count, nullptr);
    std::vector<VkExtensionProperties> available(count);
    vkEnumerateInstanceExtensionProperties(nullptr, &count, available.data());

    std::vector<const char*> extensions, layers;
    VkInstanceCreateFlags flags = 0;
    // MoltenVK is a portability implementation: without this the loader hides it.
    if (has_extension(available, VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME)) {
        extensions.push_back(VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME);
        flags |= VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR;
    }

    bool layer_settings = false;
    if (options.validation) {
        std::uint32_t layer_count = 0;
        vkEnumerateInstanceLayerProperties(&layer_count, nullptr);
        std::vector<VkLayerProperties> found(layer_count);
        vkEnumerateInstanceLayerProperties(&layer_count, found.data());
        const bool present = std::any_of(found.begin(), found.end(), [](const auto& l) { return std::strcmp(l.layerName, kValidationLayer) == 0; });
        if (!present) {
            if (log) log("WARN", "compute.vulkan.validation requested, but the Khronos validation layer is not installed");
        } else {
            layers.push_back(kValidationLayer);
            validation_ = true;
            std::uint32_t layer_ext_count = 0;
            vkEnumerateInstanceExtensionProperties(kValidationLayer, &layer_ext_count, nullptr);
            std::vector<VkExtensionProperties> layer_ext(layer_ext_count);
            vkEnumerateInstanceExtensionProperties(kValidationLayer, &layer_ext_count, layer_ext.data());
            layer_settings = has_extension(layer_ext, VK_EXT_LAYER_SETTINGS_EXTENSION_NAME) || has_extension(available, VK_EXT_LAYER_SETTINGS_EXTENSION_NAME);
            if (layer_settings) extensions.push_back(VK_EXT_LAYER_SETTINGS_EXTENSION_NAME);
            available.insert(available.end(), layer_ext.begin(), layer_ext.end());
        }
    }
    if ((validation_ || options.validation) && has_extension(available, VK_EXT_DEBUG_UTILS_EXTENSION_NAME)) {
        extensions.push_back(VK_EXT_DEBUG_UTILS_EXTENSION_NAME);
        debug_utils_ = true;
    }

    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
    app.pApplicationName = "DSTNS";
    app.applicationVersion = VK_MAKE_API_VERSION(0, 2, 2, 0);
    app.pEngineName = "DSTNS compute";
    app.engineVersion = VK_MAKE_API_VERSION(0, 2, 2, 0);
    app.apiVersion = api_version_;

    VkDebugUtilsMessengerCreateInfoEXT messenger{VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT};
    messenger.messageSeverity = VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT | VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT;
    messenger.messageType = VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT | VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT |
                            VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT;
    messenger.pfnUserCallback = on_message;
    messenger.pUserData = counters_.get();

    // Synchronisation validation: the layer checks every barrier for hazards.
    const VkBool32 enabled = VK_TRUE;
    VkLayerSettingEXT setting{kValidationLayer, "validate_sync", VK_LAYER_SETTING_TYPE_BOOL32_EXT, 1, &enabled};
    VkLayerSettingsCreateInfoEXT settings{VK_STRUCTURE_TYPE_LAYER_SETTINGS_CREATE_INFO_EXT};
    settings.settingCount = 1;
    settings.pSettings = &setting;

    VkInstanceCreateInfo info{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
    info.flags = flags;
    info.pApplicationInfo = &app;
    info.enabledExtensionCount = static_cast<std::uint32_t>(extensions.size());
    info.ppEnabledExtensionNames = extensions.data();
    info.enabledLayerCount = static_cast<std::uint32_t>(layers.size());
    info.ppEnabledLayerNames = layers.data();
    const void* chain = nullptr;
    if (debug_utils_) {
        messenger.pNext = chain;
        chain = &messenger;
    }
    if (validation_ && layer_settings) {
        settings.pNext = chain;
        chain = &settings;
    }
    info.pNext = chain;
    auto result = vkCreateInstance(&info, nullptr, &instance_);
    if (result == VK_ERROR_LAYER_NOT_PRESENT && validation_) {
        // A validation layer that is registered but cannot be loaded must not
        // cost the simulation its GPU: carry on without it.
        if (log) log("WARN", "compute.vulkan.validation the Khronos validation layer failed to load; continuing without it");
        validation_ = false;
        layers.clear();
        if (layer_settings) extensions.erase(std::find(extensions.begin(), extensions.end(), std::string_view(VK_EXT_LAYER_SETTINGS_EXTENSION_NAME)));
        info.enabledLayerCount = 0;
        info.ppEnabledLayerNames = nullptr;
        info.enabledExtensionCount = static_cast<std::uint32_t>(extensions.size());
        info.ppEnabledExtensionNames = extensions.data();
        info.pNext = debug_utils_ ? &messenger : nullptr;
        messenger.pNext = nullptr;
        result = vkCreateInstance(&info, nullptr, &instance_);
    }
    check(result, "vkCreateInstance");
    volkLoadInstanceTable(&table_, instance_);
    if (debug_utils_) {
        messenger.pNext = nullptr;
        if (table_.vkCreateDebugUtilsMessengerEXT(instance_, &messenger, nullptr, &messenger_) != VK_SUCCESS) messenger_ = VK_NULL_HANDLE;
    }
}

Instance::~Instance() {
    if (messenger_) table_.vkDestroyDebugUtilsMessengerEXT(instance_, messenger_, nullptr);
    if (instance_) table_.vkDestroyInstance(instance_, nullptr);
}

// --- Physical devices ---------------------------------------------------------------

bool DeviceInfo::moltenvk() const {
    return driver_id == VK_DRIVER_ID_MOLTENVK || lower(driver_name).find("moltenvk") != std::string::npos;
}

std::string DeviceInfo::type_name() const {
    switch (properties.deviceType) {
        case VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU: return "discrete";
        case VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU: return "integrated";
        case VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU: return "virtual";
        case VK_PHYSICAL_DEVICE_TYPE_CPU: return "cpu";
        default: return "other";
    }
}

std::string DeviceInfo::vendor_name() const {
    switch (properties.vendorID) {
        case 0x1002: return "AMD";
        case 0x10DE: return "NVIDIA";
        case 0x8086: return "Intel";
        case 0x106B: return "Apple";
        case 0x13B5: return "ARM";
        case 0x5143: return "Qualcomm";
        case 0x1010: return "Imagination";
        case 0x10005: return "Mesa";
        default: {
            std::ostringstream out;
            out << "0x" << std::hex << properties.vendorID;
            return out.str();
        }
    }
}

std::string DeviceInfo::driver_version_string() const {
    // Vendors pack driverVersion differently; NVIDIA uses 10.8.8.6 bits.
    const auto v = properties.driverVersion;
    if (properties.vendorID == 0x10DE)
        return std::to_string((v >> 22) & 0x3FF) + "." + std::to_string((v >> 14) & 0xFF) + "." + std::to_string((v >> 6) & 0xFF);
    if (!driver_info.empty()) return driver_info;
    return version_string(v);
}

nlohmann::json DeviceInfo::json() const {
    return {
        {"index", index}, {"name", name}, {"vendor", vendor_name()}, {"vendor_id", properties.vendorID},
        {"device_id", properties.deviceID}, {"type", type_name()}, {"api_version", version_string(properties.apiVersion)},
        {"driver", driver_name}, {"driver_version", driver_version_string()}, {"uuid", uuid},
        {"memory_bytes", device_local_bytes}, {"max_allocation_bytes", max_allocation},
        {"max_storage_buffer_bytes", properties.limits.maxStorageBufferRange},
        {"max_workgroup_size", properties.limits.maxComputeWorkGroupSize[0]},
        {"max_workgroup_invocations", properties.limits.maxComputeWorkGroupInvocations},
        {"int64", int64}, {"timeline_semaphores", timeline}, {"synchronization2", synchronization2},
        {"portability_subset", portability_subset}, {"memory_budget", memory_budget}, {"moltenvk", moltenvk()},
        {"software", software}, {"unified_memory", unified_memory}, {"timestamps", timestamps},
        {"compute_queue_family", queue_family}, {"dedicated_compute_queue", dedicated_compute},
        {"usable", usable}, {"unusable_reason", unusable_reason}, {"score", score}
    };
}

std::vector<DeviceInfo> enumerate_devices(const Instance& instance, bool allow_software) {
    const auto& vk = instance.vk();
    std::uint32_t count = 0;
    check(vk.vkEnumeratePhysicalDevices(instance.handle(), &count, nullptr), "vkEnumeratePhysicalDevices");
    std::vector<VkPhysicalDevice> handles(count);
    check(vk.vkEnumeratePhysicalDevices(instance.handle(), &count, handles.data()), "vkEnumeratePhysicalDevices");

    std::vector<DeviceInfo> devices;
    for (std::uint32_t i = 0; i < count; ++i) {
        DeviceInfo d;
        d.handle = handles[i];
        d.index = i;
        vk.vkGetPhysicalDeviceProperties(d.handle, &d.properties);
        d.name = d.properties.deviceName;
        vk.vkGetPhysicalDeviceMemoryProperties(d.handle, &d.memory);
        const bool v12 = d.properties.apiVersion >= VK_API_VERSION_1_2;
        const bool v13 = d.properties.apiVersion >= VK_API_VERSION_1_3 && instance.api_version() >= VK_API_VERSION_1_3;

        std::uint32_t ext_count = 0;
        vk.vkEnumerateDeviceExtensionProperties(d.handle, nullptr, &ext_count, nullptr);
        std::vector<VkExtensionProperties> extensions(ext_count);
        vk.vkEnumerateDeviceExtensionProperties(d.handle, nullptr, &ext_count, extensions.data());
        d.portability_subset = has_extension(extensions, "VK_KHR_portability_subset");
        d.memory_budget = has_extension(extensions, VK_EXT_MEMORY_BUDGET_EXTENSION_NAME);
        const bool sync2_ext = has_extension(extensions, VK_KHR_SYNCHRONIZATION_2_EXTENSION_NAME);

        if (v12) {
            VkPhysicalDeviceVulkan11Properties p11{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES};
            VkPhysicalDeviceDriverProperties driver{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES};
            p11.pNext = &driver;
            VkPhysicalDeviceProperties2 p2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2};
            p2.pNext = &p11;
            vk.vkGetPhysicalDeviceProperties2(d.handle, &p2);
            d.uuid = format_uuid(p11.deviceUUID);
            d.max_allocation = p11.maxMemoryAllocationSize;
            d.driver_id = driver.driverID;
            d.driver_name = driver.driverName;
            d.driver_info = driver.driverInfo;

            VkPhysicalDeviceVulkan13Features f13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
            VkPhysicalDeviceSynchronization2FeaturesKHR fsync{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SYNCHRONIZATION_2_FEATURES_KHR};
            VkPhysicalDeviceVulkan12Features f12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES};
            if (v13) f12.pNext = &f13;
            else if (sync2_ext) f12.pNext = &fsync;
            VkPhysicalDeviceFeatures2 f2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2};
            f2.pNext = &f12;
            vk.vkGetPhysicalDeviceFeatures2(d.handle, &f2);
            d.int64 = f2.features.shaderInt64;
            d.timeline = f12.timelineSemaphore;
            d.synchronization2_core = v13 && f13.synchronization2;
            d.synchronization2 = d.synchronization2_core || (sync2_ext && fsync.synchronization2);
        }

        std::uint32_t family_count = 0;
        vk.vkGetPhysicalDeviceQueueFamilyProperties(d.handle, &family_count, nullptr);
        std::vector<VkQueueFamilyProperties> families(family_count);
        vk.vkGetPhysicalDeviceQueueFamilyProperties(d.handle, &family_count, families.data());
        for (std::uint32_t f = 0; f < family_count; ++f) {
            if (!(families[f].queueFlags & VK_QUEUE_COMPUTE_BIT) || families[f].queueCount == 0) continue;
            const bool dedicated = !(families[f].queueFlags & VK_QUEUE_GRAPHICS_BIT);
            if (d.queue_family < 0 || (dedicated && !d.dedicated_compute)) {
                d.queue_family = static_cast<int>(f);
                d.dedicated_compute = dedicated;
                d.timestamp_bits = families[f].timestampValidBits;
            }
        }
        d.timestamps = d.queue_family >= 0 && d.timestamp_bits > 0 && d.properties.limits.timestampPeriod > 0;

        for (std::uint32_t h = 0; h < d.memory.memoryHeapCount; ++h)
            if (d.memory.memoryHeaps[h].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT)
                d.device_local_bytes = std::max<std::uint64_t>(d.device_local_bytes, d.memory.memoryHeaps[h].size);
        d.software = d.properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_CPU;
        d.unified_memory = d.properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU || d.software;

        if (!v12) d.unusable_reason = "Vulkan " + version_string(d.properties.apiVersion) + " (1.2 required)";
        else if (!d.int64) d.unusable_reason = "no 64-bit shader integers (shaderInt64)";
        else if (!d.timeline) d.unusable_reason = "no timeline semaphores";
        else if (d.queue_family < 0) d.unusable_reason = "no compute queue";
        else if (d.properties.limits.maxComputeWorkGroupSize[0] < 64 || d.properties.limits.maxComputeWorkGroupInvocations < 64)
            d.unusable_reason = "compute workgroups smaller than 64";
        d.usable = d.unusable_reason.empty();

        // Prefer real GPUs, then newer APIs, more memory and the optional
        // features that make telemetry and synchronisation cheaper. Integrated
        // GPUs score close to discrete ones: with unified memory they avoid the
        // transfers that a discrete card pays for.
        int score = 0;
        switch (d.properties.deviceType) {
            case VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU: score = 1000; break;
            case VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU: score = 900; break;
            case VK_PHYSICAL_DEVICE_TYPE_VIRTUAL_GPU: score = 500; break;
            case VK_PHYSICAL_DEVICE_TYPE_CPU: score = 50; break;
            default: score = 300; break;
        }
        score += 10 * static_cast<int>(VK_API_VERSION_MINOR(d.properties.apiVersion));
        score += 5 * static_cast<int>(std::min<std::uint64_t>(64, d.device_local_bytes >> 30));
        score += d.timestamps ? 20 : 0;
        score += d.synchronization2 ? 5 : 0;
        score += d.dedicated_compute ? 5 : 0;
        if (d.software && !allow_software) score -= 1000;
        d.score = score;
        devices.push_back(std::move(d));
    }
    return devices;
}

const DeviceInfo* select_device(const std::vector<DeviceInfo>& devices, const compute::ComputeOptions& options, std::string& reason) {
    if (devices.empty()) {
        reason = "the Vulkan loader found no devices (no GPU driver is installed, or it is not exposed to this process)";
        return nullptr;
    }
    std::vector<const DeviceInfo*> ranked;
    for (const auto& d : devices) ranked.push_back(&d);
    std::sort(ranked.begin(), ranked.end(), [](const DeviceInfo* a, const DeviceInfo* b) {
        if (a->score != b->score) return a->score > b->score;
        if (a->uuid != b->uuid) return a->uuid < b->uuid;
        return a->index < b->index;
    });

    const auto wanted = lower(options.device);
    if (!wanted.empty() && wanted != "auto") {
        const DeviceInfo* match = nullptr;
        if (std::all_of(wanted.begin(), wanted.end(), [](unsigned char c) { return std::isdigit(c); }) && wanted.size() < 6) {
            const auto index = static_cast<std::uint32_t>(std::stoul(wanted));
            for (const auto& d : devices) if (d.index == index) match = &d;
        } else {
            for (const auto* d : ranked) if (lower(d->uuid) == wanted) { match = d; break; }
            if (!match)
                for (const auto* d : ranked) if (lower(d->name).find(wanted) != std::string::npos) { match = d; break; }
        }
        if (!match) {
            reason = "DSTNS_GPU_DEVICE \"" + options.device + "\" matches no Vulkan device";
            return nullptr;
        }
        if (!match->usable) {
            reason = match->name + " cannot run DSTNS: " + match->unusable_reason;
            return nullptr;
        }
        return match; // named explicitly: a software device is allowed
    }
    for (const auto* d : ranked) {
        if (!d->usable) continue;
        if (d->software && !options.allow_software_vulkan) continue;
        return d;
    }
    const auto software = std::find_if(ranked.begin(), ranked.end(), [](const DeviceInfo* d) { return d->usable && d->software; });
    if (software != ranked.end())
        reason = "only a software Vulkan implementation is available (" + (*software)->name +
                 "); it is slower than the CPU backend, so it is used only when allowed explicitly";
    else
        reason = ranked.front()->name + " cannot run DSTNS: " + ranked.front()->unusable_reason;
    return nullptr;
}

// --- Logical device ----------------------------------------------------------------------

Device::Device(const Instance& instance, const DeviceInfo& info) : instance_(instance), info_(info) {
    const float priority = 1.0f;
    VkDeviceQueueCreateInfo queue{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
    queue.queueFamilyIndex = static_cast<std::uint32_t>(info.queue_family);
    queue.queueCount = 1;
    queue.pQueuePriorities = &priority;

    std::vector<const char*> extensions;
    if (info.portability_subset) extensions.push_back("VK_KHR_portability_subset");
    if (info.memory_budget) extensions.push_back(VK_EXT_MEMORY_BUDGET_EXTENSION_NAME);

    VkPhysicalDeviceVulkan13Features f13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    VkPhysicalDeviceSynchronization2FeaturesKHR fsync{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SYNCHRONIZATION_2_FEATURES_KHR};
    VkPhysicalDeviceVulkan12Features f12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES};
    f12.timelineSemaphore = VK_TRUE;
    if (info.synchronization2_core) {
        f13.synchronization2 = VK_TRUE;
        f12.pNext = &f13;
    } else if (info.synchronization2) {
        fsync.synchronization2 = VK_TRUE;
        f12.pNext = &fsync;
        extensions.push_back(VK_KHR_SYNCHRONIZATION_2_EXTENSION_NAME);
    }
    synchronization2_ = info.synchronization2;
    VkPhysicalDeviceFeatures2 features{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2};
    features.features.shaderInt64 = VK_TRUE;
    features.pNext = &f12;

    VkDeviceCreateInfo create{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
    create.pNext = &features;
    create.queueCreateInfoCount = 1;
    create.pQueueCreateInfos = &queue;
    create.enabledExtensionCount = static_cast<std::uint32_t>(extensions.size());
    create.ppEnabledExtensionNames = extensions.data();
    check(instance.vk().vkCreateDevice(info.handle, &create, nullptr, &device_), "vkCreateDevice");
    volkLoadDeviceTable(&table_, device_);
    table_.vkGetDeviceQueue(device_, queue.queueFamilyIndex, 0, &queue_);
}

Device::~Device() {
    if (device_) {
        table_.vkDeviceWaitIdle(device_);
        table_.vkDestroyDevice(device_, nullptr);
    }
}

void Device::name(VkObjectType type, std::uint64_t handle, const char* label) const {
    const auto& vk = instance_.vk();
    if (!instance_.debug_utils() || !vk.vkSetDebugUtilsObjectNameEXT) return;
    VkDebugUtilsObjectNameInfoEXT info{VK_STRUCTURE_TYPE_DEBUG_UTILS_OBJECT_NAME_INFO_EXT};
    info.objectType = type;
    info.objectHandle = handle;
    info.pObjectName = label;
    vk.vkSetDebugUtilsObjectNameEXT(device_, &info);
}

std::uint64_t Device::memory_budget() const {
    if (!info_.memory_budget) return info_.device_local_bytes;
    VkPhysicalDeviceMemoryBudgetPropertiesEXT budget{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_BUDGET_PROPERTIES_EXT};
    VkPhysicalDeviceMemoryProperties2 props{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_PROPERTIES_2};
    props.pNext = &budget;
    instance_.vk().vkGetPhysicalDeviceMemoryProperties2(info_.handle, &props);
    std::uint64_t best = 0;
    for (std::uint32_t h = 0; h < props.memoryProperties.memoryHeapCount; ++h)
        if (props.memoryProperties.memoryHeaps[h].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT)
            best = std::max<std::uint64_t>(best, budget.heapBudget[h] > budget.heapUsage[h] ? budget.heapBudget[h] - budget.heapUsage[h] : 0);
    return best ? best : info_.device_local_bytes;
}

} // namespace dstns::vulkan
