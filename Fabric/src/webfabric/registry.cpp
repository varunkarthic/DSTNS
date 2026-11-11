// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/webfabric/registry.hpp"

#include <optional>

#include "dstns/rng.hpp"
#include "dstns/utf8.hpp"
#include "support.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <regex>

namespace dstns::fabric {
namespace {
using json = nlohmann::json;

// Bounds, so one application cannot exhaust the server or the page. Nothing is
// silently discarded at these limits: a request over one is refused with a code.
constexpr std::size_t kMaxApps = 64, kMaxElements = 64, kMaxUiBytes = 4 * 1024 * 1024, kMaxEventQueue = 1000,
                      kMaxNotifications = 1000, kMaxAudit = 2000, kMaxFields = 128, kMaxPage = 200, kMaxTimers = 32,
                      kMaxTopics = 32, kMaxStorageKeys = 256, kMaxStorageBytes = 256 * 1024, kMaxMessageBytes = 16 * 1024;
constexpr double kNotificationBurst = 40, kNotificationsPerSecond = 20;
constexpr std::int64_t kSignatureWindowS = 60;
constexpr std::size_t kMaxLaunchCommands = 8, kMaxCommandBytes = 1024, kMaxProposals = 64;
constexpr std::size_t kMaxViewRequests = 32, kMaxHeldPlaces = 64;
constexpr double kViewBurst = 4, kViewPerSecond = 2;
constexpr std::int64_t kViewFreshMs = 5000;
constexpr int kManifestVersion = 1, kApiMajor = 1;

// Requested and granted without asking: they only add to the application's own
// surfaces. Everything else interrupts the viewer, runs the application's own
// code in the page, or changes the simulation, so a person grants it.
const std::set<std::string> kAutomatic = {"ui.header", "ui.status", "ui.panels", "ui.sidebar", "ui.deck", "ui.notifications", "ui.overlays",
                                          "ui.map-controls", "ui.indicators", "settings", "sim.read", "storage", "apps.messages"};
const std::set<std::string> kExplicit = {"ui.dialogs", "ui.frames", "ui.camera", "ui.layers", "control.playback", "control.events", "control.world"};
const std::map<std::string, std::string> kSlotCapability = {
    {"header", "ui.header"}, {"status", "ui.status"}, {"panel", "ui.panels"}, {"sidebar", "ui.sidebar"}, {"deck", "ui.deck"}, {"overlay", "ui.overlays"},
    {"map_control", "ui.map-controls"}, {"indicator", "ui.indicators"}, {"dialog", "ui.dialogs"}};
const std::set<std::string> kTones = {"neutral", "accent", "ok", "warn", "danger"};
// What an application may hold on or off: the same layers a person has, and no others.
const std::set<std::string> kLayers = {"traffic", "weather", "flooding", "events", "buildings", "signals", "roads", "vehicles", "incidents", "labels", "place_names", "other_places"};
const std::set<std::string> kReportedStates = {"initialized", "active", "failed"};
const std::regex kAppId("[a-z0-9]+([.-][a-z0-9]+)*");
const std::regex kKey("[a-z0-9][a-z0-9_-]{0,39}");
const std::regex kVersion("[0-9]+(\\.[0-9]+){0,2}([-+][0-9A-Za-z.-]+)?");

std::string lower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

[[noreturn]] void bad(const std::string& message) { throw Refusal(400, "INVALID_MANIFEST", message); }

std::string text_field(const json& object, const char* key, std::size_t limit, bool required, const std::string& where) {
    if (!object.contains(key)) {
        if (required) bad(where + " needs " + key);
        return {};
    }
    if (!object.at(key).is_string()) bad(where + "." + key + " must be a string");
    const auto value = object.at(key).get<std::string>();
    if ((required && value.empty()) || value.size() > limit)
        bad(where + "." + key + " must be " + (required ? "1 to " : "at most ") + std::to_string(limit) + " bytes");
    return value;
}

void valid_key(const json& object, const char* key, const std::string& where) {
    const auto value = text_field(object, key, 40, true, where);
    if (!std::regex_match(value, kKey)) bad(where + "." + key + " must match [a-z0-9][a-z0-9_-]*");
}

bool field_accepts(const json& field, const json& value) {
    const auto type = field.at("type").get<std::string>();
    if (type == "toggle") return value.is_boolean();
    if (type == "text") return value.is_string() && value.get_ref<const std::string&>().size() <= field.value("max_length", std::size_t{500});
    if (type == "number" || type == "slider") {
        if (!value.is_number() || !std::isfinite(value.get<double>())) return false;
        const auto number = value.get<double>();
        return (!field.contains("min") || number >= field.at("min").get<double>()) &&
               (!field.contains("max") || number <= field.at("max").get<double>());
    }
    if (type == "select") {
        for (const auto& option : field.at("options"))
            if (option.at("value") == value) return true;
        return false;
    }
    return false;
}

void validate_settings(const json& settings) {
    if (!settings.is_object()) bad("settings must be an object");
    if (!settings.value("version", json(1)).is_number_unsigned()) bad("settings.version must be a positive integer");
    if (!settings.contains("groups") || !settings.at("groups").is_array()) bad("settings.groups must be an array");
    std::set<std::string> seen;
    for (const auto& group : settings.at("groups")) {
        valid_key(group, "id", "settings group");
        text_field(group, "label", 60, true, "settings group");
        if (!group.contains("fields") || !group.at("fields").is_array()) bad("settings group needs fields");
        for (const auto& field : group.at("fields")) {
            valid_key(field, "id", "settings field");
            text_field(field, "label", 80, true, "settings field");
            text_field(field, "hint", 240, false, "settings field");
            const auto type = text_field(field, "type", 12, true, "settings field");
            if (!seen.insert(field.at("id").get<std::string>()).second) bad("settings field IDs must be unique: " + field.at("id").get<std::string>());
            if (type == "number" || type == "slider") {
                for (const char* key : {"min", "max", "step"})
                    if (field.contains(key) && !field.at(key).is_number()) bad(std::string("settings field ") + key + " must be a number");
                if (type == "slider" && !(field.contains("min") && field.contains("max"))) bad("a slider needs min and max");
                if (field.contains("min") && field.contains("max") && field.at("min").get<double>() > field.at("max").get<double>()) bad("settings field min exceeds max");
            } else if (type == "select") {
                if (!field.contains("options") || !field.at("options").is_array() || field.at("options").empty()) bad("a select needs options");
                for (const auto& option : field.at("options")) {
                    if (!option.is_object() || !option.contains("value") || !(option.at("value").is_string() || option.at("value").is_number())) bad("a select option needs a string or number value");
                    text_field(option, "label", 80, true, "select option");
                }
            } else if (type != "toggle" && type != "text") {
                bad("unknown settings field type: " + type);
            }
            if (!field.contains("default") || !field_accepts(field, field.at("default")))
                bad("settings field " + field.at("id").get<std::string>() + " needs a valid default");
        }
    }
    if (seen.size() > kMaxFields) bad("too many settings fields");
    if (settings.contains("migrations") && !settings.at("migrations").is_object()) bad("settings.migrations must be an object");
}

bool environment_flag(const char* name, bool fallback) {
    const char* value = std::getenv(name);
    if (!value || !*value) return fallback;
    const std::string text = lower(value);
    return !(text == "0" || text == "false" || text == "off" || text == "no");
}

// What a manifest may say about a web interface of the application's own: opened in a tab of its own, never in the page.
void check_web(const json& web) {
    if (!web.is_object()) bad("manifest.web must be an object");
    const auto url = web.value("url", json(nullptr));
    if (!url.is_string() || !(url.get<std::string>().starts_with("http://") || url.get<std::string>().starts_with("https://")) || url.get<std::string>().size() > 2000)
        bad("manifest.web.url must be an http or https URL");
    text_field(web, "label", 40, false, "manifest.web");
}

json validate_manifest(const json& manifest) {
    if (!manifest.is_object()) bad("the manifest must be an object");
    if (manifest.value("manifest_version", kManifestVersion) != kManifestVersion)
        throw Refusal(422, "APP_INCOMPATIBLE", "this server reads manifest_version " + std::to_string(kManifestVersion));
    if (manifest.value("requires_api", kApiMajor) != kApiMajor)
        throw Refusal(422, "APP_INCOMPATIBLE", "this server provides API major version " + std::to_string(kApiMajor));
    const auto id = text_field(manifest, "id", 64, true, "manifest");
    if (id.size() < 3 || !std::regex_match(id, kAppId)) bad("manifest.id must be 3 to 64 characters of lower-case letters, digits, dots and hyphens");
    // Fabric's own names and branding belong to DSTNS.
    for (const char* reserved : {"dstns", "fabric", "webfabric"})
        if (id == reserved || id.starts_with(std::string(reserved) + ".") || id.starts_with(std::string(reserved) + "-"))
            throw Refusal(403, "APP_ID_RESERVED", "application IDs may not use the reserved prefix " + std::string(reserved));
    const auto name = text_field(manifest, "name", 40, true, "manifest");
    for (const char* reserved : {"dstns", "fabric", "webfabric"})
        if (lower(name) == reserved) throw Refusal(403, "APP_NAME_RESERVED", "application names may not be " + name);
    if (!std::regex_match(text_field(manifest, "version", 32, true, "manifest"), kVersion)) bad("manifest.version must be a version number");
    text_field(manifest, "description", 280, false, "manifest");
    text_field(manifest, "author", 80, false, "manifest");
    if (manifest.contains("capabilities")) {
        if (!manifest.at("capabilities").is_array()) bad("manifest.capabilities must be an array");
        for (const auto& capability : manifest.at("capabilities")) {
            if (!capability.is_string() || (!kAutomatic.count(capability.get<std::string>()) && !kExplicit.count(capability.get<std::string>())))
                bad("unknown capability: " + capability.dump());
        }
    }
    if (manifest.contains("lease_s") && !(manifest.at("lease_s").is_number() && manifest.at("lease_s").get<double>() >= 1 && manifest.at("lease_s").get<double>() <= 3600))
        bad("manifest.lease_s must be in [1, 3600]");
    if (manifest.contains("settings")) validate_settings(manifest.at("settings"));
    if (manifest.contains("frame_origins")) {
        const auto& origins = manifest.at("frame_origins");
        if (!origins.is_array() || origins.size() > 16) bad("manifest.frame_origins must be an array of up to 16 origins");
        static const std::regex kOrigin("https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?");
        for (const auto& origin : origins)
            if (!origin.is_string() || !std::regex_match(origin.get<std::string>(), kOrigin)) bad("a frame origin is a scheme and a host, such as https://example.org");
    }
    if (manifest.contains("security") && !(manifest.at("security").is_object() && manifest.at("security").value("require_signatures", json(false)).is_boolean()))
        bad("manifest.security.require_signatures must be true or false");
    if (manifest.contains("web")) check_web(manifest.at("web"));
    return manifest;
}

// How an element arrives: one of the provided motions, or a custom spring within
// the guidelines. Lively is welcome; a spring that wobbles or dawdles is refused,
// because it would feel unlike the rest of the interface.
void check_motion(const json& motion) {
    static const std::set<std::string> kMotions = {"none", "fade", "rise", "slide", "scale", "pop", "drop"};
    if (motion.is_string()) {
        if (!kMotions.count(motion.get<std::string>()))
            throw Refusal(400, "INVALID_ELEMENT", "motion must be none, fade, rise, slide, scale, pop or drop, or a custom spring");
        return;
    }
    if (!motion.is_object() || !motion.value("stiffness", json(nullptr)).is_number() || !motion.value("damping", json(nullptr)).is_number())
        throw Refusal(400, "INVALID_ELEMENT", "a custom motion needs stiffness and damping");
    const auto k = motion.at("stiffness").get<double>();
    const auto c = motion.at("damping").get<double>();
    if (!(k >= 40 && k <= 1200) || !(c > 0)) throw Refusal(400, "INVALID_ELEMENT", "motion stiffness must be in [40, 1200], with positive damping");
    const double zeta = c / (2 * std::sqrt(k));
    if (zeta < 0.56) throw Refusal(400, "INVALID_ELEMENT", "motion overshoots more than 12%: raise damping");
    const double settle = zeta < 1 ? 4 / (zeta * std::sqrt(k)) : 4 / (std::sqrt(k) * (zeta - std::sqrt(zeta * zeta - 1)));
    if (settle > 1.5) throw Refusal(400, "INVALID_ELEMENT", "motion takes longer than 1.5 s to settle: raise stiffness or lower damping");
}

// What a feature tied to the road network may ask for. Whether its nodes and edges
// exist depends on the loaded world, which the routes check against the engine.
void check_feature(const json& feature) {
    const auto refuse = [](const std::string& message) { throw Refusal(400, "INVALID_ELEMENT", message); };
    if (!feature.is_object()) refuse("an overlay feature must be an object");
    // A colour is only ever a request: the observer makes it legible, and keeps to a person's colour vision setting.
    static const std::regex kColour("auto|#[0-9a-fA-F]{6}");
    if (feature.contains("color") && (!feature.at("color").is_string() || !std::regex_match(feature.at("color").get<std::string>(), kColour)))
        refuse("color must be \"auto\" or #RRGGBB");
    const auto type = feature.value("type", std::string{});
    if (type != "marker" && type != "entity" && type != "route" && type != "path") return;
    const auto number_in = [&](const char* key, double low, double high) {
        if (!feature.contains(key)) return;
        const auto& value = feature.at(key);
        if (!value.is_number() || !(value.get<double>() >= low && value.get<double>() <= high))
            refuse(std::string(key) + " must be a number in [" + std::to_string(low) + ", " + std::to_string(high) + "]");
    };
    const auto one_of = [&](const char* key, const std::set<std::string>& allowed) {
        if (feature.contains(key) && (!feature.at(key).is_string() || !allowed.count(feature.at(key).get<std::string>())))
            refuse(std::string(key) + " is not one of the shapes offered");
    };
    if (feature.contains("node") && !feature.at("node").is_number_unsigned()) refuse("node must be a node ID");
    if (feature.contains("edge") && !feature.at("edge").is_number_unsigned()) refuse("edge must be an edge ID");
    if (type == "marker") {
        if (!feature.contains("node")) refuse("a marker needs a node");
        one_of("shape", {"pin", "stop", "ring", "diamond"});
    }
    if (type == "entity") {
        if (!feature.contains("edge")) refuse("an entity needs an edge");
        number_in("at", 0, 1);
        one_of("shape", {"bus", "vehicle", "dot"});
    }
    if (type == "route" || type == "path") {
        if (!feature.contains("nodes") || !feature.at("nodes").is_array() || feature.at("nodes").size() < 2 || feature.at("nodes").size() > 4096)
            refuse("a " + type + " needs 2 to 4096 nodes");
        for (const auto& node : feature.at("nodes"))
            if (!node.is_number_unsigned()) refuse("nodes must be node IDs");
        number_in("draw_s", 0.05, 600);
        one_of("style", {"solid", "dashed", "dotted", "flow"});
        if (feature.contains("glow") && !feature.at("glow").is_boolean()) refuse("glow must be true or false");
    }
    if (type == "path") {
        if (!feature.contains("id") || !feature.at("id").is_string()) refuse("a path needs an id");
        number_in("speed_mps", 1, 1000);
        number_in("dwell_s", 0, 60);
        number_in("delay_s", 0, 600);
        number_in("run", 0, 9007199254740991.0);
        number_in("count", 1, 12);
        number_in("spacing_m", 2, 200);
        for (const char* key : {"loop", "bounce", "reveal", "trail", "paused", "drive", "obey_signals"})
            if (feature.contains(key) && !feature.at(key).is_boolean()) refuse(std::string(key) + " must be true or false");
        one_of("shape", {"bus", "vehicle", "dot", "none"});
        if (feature.contains("spring")) {
            static const std::set<std::string> kSprings = {"smooth", "standard", "lively", "snappy"};
            const auto& spring = feature.at("spring");
            if (spring.is_string()) {
                if (!kSprings.count(spring.get<std::string>())) refuse("spring must be smooth, standard, lively or snappy, or a custom spring");
            } else {
                check_motion(spring);
            }
        }
    }
}

// What is asked of the map, reduced to what is known and in range. Nothing else reaches the observer.
json check_view(const json& request) {
    const auto refuse = [](const std::string& message) { throw Refusal(400, "INVALID_VIEW", message); };
    if (!request.is_object() || !request.contains("action") || !request.at("action").is_string()) refuse("a view request needs an action");
    const auto action = request.at("action").get<std::string>();
    json out = {{"action", action}};
    const auto number = [&](const char* key, double low, double high) {
        if (!request.contains(key) || !request.at(key).is_number() || !(request.at(key).get<double>() >= low && request.at(key).get<double>() <= high))
            refuse(std::string(key) + " must be a number in [" + std::to_string(low) + ", " + std::to_string(high) + "]");
        out[key] = request.at(key);
    };
    const auto id = [&](const char* key) {
        if (!request.contains(key) || !request.at(key).is_number_unsigned()) refuse(std::string(key) + " must be an ID");
        out[key] = request.at(key);
    };
    const auto span = [&] {
        if (request.contains("span_m")) number("span_m", 10, 10000000);
    };
    constexpr double kFar = 100000000;
    if (action == "focus") {
        number("x_m", -kFar, kFar);
        number("y_m", -kFar, kFar);
        span();
    } else if (action == "node") {
        id("node");
        span();
    } else if (action == "edge") {
        id("edge");
        span();
    } else if (action == "bounds") {
        number("min_x_m", -kFar, kFar);
        number("min_y_m", -kFar, kFar);
        number("max_x_m", -kFar, kFar);
        number("max_y_m", -kFar, kFar);
        if (out.at("max_x_m").get<double>() <= out.at("min_x_m").get<double>() || out.at("max_y_m").get<double>() <= out.at("min_y_m").get<double>()) refuse("bounds must have an area");
    } else if (action == "zoom") {
        number("factor", 0.25, 4);
    } else if (action != "fit") {
        refuse("action must be focus, node, edge, bounds, zoom or fit");
    }
    return out;
}

json schema_fields(const json& manifest) {
    auto fields = json::array();
    if (manifest.contains("settings"))
        for (const auto& group : manifest.at("settings").at("groups"))
            for (const auto& field : group.at("fields")) fields.push_back(field);
    return fields;
}

std::int64_t wall_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
} // namespace

const Switches& switches() {
    static const Switches loaded = [] {
        Switches out;
        out.applications = environment_flag("DSTNS_FABRIC_APPS", true);
        out.legacy_api = environment_flag("DSTNS_LEGACY_API", true);
        out.launch_proposals = environment_flag("DSTNS_LAUNCH_PROPOSALS", true);
        out.require_signatures = environment_flag("DSTNS_REQUIRE_SIGNATURES", false);
        if (const char* list = std::getenv("DSTNS_DISABLED_CAPABILITIES")) {
            std::string text = list;
            for (std::size_t start = 0; start <= text.size();) {
                const auto comma = text.find(',', start);
                auto item = text.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
                item.erase(0, item.find_first_not_of(' '));
                item.erase(item.find_last_not_of(' ') + 1);
                if (kAutomatic.count(item) || kExplicit.count(item)) out.disabled.insert(item);
                if (comma == std::string::npos) break;
                start = comma + 1;
            }
        }
        // Only what is known, and only of the right kind, reaches the observer.
        if (const char* text = std::getenv("DSTNS_PRESENTATION"); text && *text) {
            try {
                const auto given = json::parse(text);
                for (const char* key : {"webfabric", "force_animate", "fast_boot", "dynamic_fastboot", "dynamic_particles", "demo", "music", "fullscreen"})
                    if (given.is_object() && given.contains(key) && given.at(key).is_boolean()) out.presentation[key] = given.at(key);
                const auto number = [&](const char* key) -> std::optional<double> {
                    if (given.is_object() && given.contains(key) && given.at(key).is_number()) return given.at(key).get<double>();
                    return std::nullopt;
                };
                if (const auto v = number("music_volume")) out.presentation["music_volume"] = std::clamp(*v, 0.0, 1.0);
                // Demo Mode's scenes, by id, in order: short names only, and not many of them.
                if (given.is_object() && given.contains("demo_scenes") && given.at("demo_scenes").is_array()) {
                    json scenes = json::array();
                    for (const auto& id : given.at("demo_scenes")) {
                        if (id.is_string() && !id.get<std::string>().empty() && id.get<std::string>().size() <= 32 && scenes.size() < 32) scenes.push_back(id);
                    }
                    out.presentation["demo_scenes"] = scenes;
                }
                // How hard the observer works: frames a second for the map's animation (0 lets it decide), the most
                // pixels per point it draws at, and how many particles the film has.
                if (const auto v = number("map_fps")) out.presentation["map_fps"] = *v >= 45 ? 60 : *v >= 1 ? 30 : 0;
                if (const auto v = number("render_scale")) out.presentation["render_scale"] = std::clamp(*v, 0.5, 3.0);
                if (const auto v = number("film_particles")) out.presentation["film_particles"] = static_cast<int>(std::clamp(*v, 4000.0, 32000.0));
            } catch (const json::exception&) {
                // A malformed setting leaves the defaults, rather than stopping the server.
            }
        }
        return out;
    }();
    return loaded;
}

AppRegistry::AppRegistry(std::filesystem::path store) : store_(std::move(store)) {
    std::ifstream in(store_);
    if (!in) return;
    // A damaged store must not stop the simulator: applications register again.
    try {
        const auto saved = json::parse(in);
        // Sealed with a key kept apart from it. One that does not match is set aside, not trusted:
        // it holds what proves who an application is and what it may do.
        if (saved.contains("integrity") && !fabric::same_secret(saved.at("integrity").get<std::string>(), fabric::hmac_sha256(store_key(), saved.at("apps").dump() + saved.value("launch", json::object()).dump()))) {
            store_rejected_ = true;
            in.close();
            std::error_code ignored;
            std::filesystem::rename(store_, store_.string() + ".rejected", ignored);
            return;
        }
        launch_ = saved.value("launch", json::object());
        for (const auto& [id, record] : saved.at("apps").items()) {
            App app;
            app.id = id;
            // An older store kept the token itself. It keeps working, and is kept only as a hash from here on.
            app.token_hash = record.contains("token_hash") ? record.at("token_hash").get<std::string>() : sha256(record.at("token").get<std::string>());
            app.signing_key = record.contains("signing_key") ? record.at("signing_key").get<std::string>() : Seed128::secure().hex() + Seed128::secure().hex();
            app.signatures_required = record.value("signatures_required", false);
            app.state = "unloaded";
            app.manifest = record.at("manifest");
            app.granted = record.at("granted").get<std::set<std::string>>();
            app.values = record.at("values");
            app.settings_version = record.at("settings_version");
            app.user_suspended = record.value("user_suspended", false);
            app.storage = record.value("storage", json::object());
            app.order = next_order_++;
            apps_.emplace(id, std::move(app));
        }
    } catch (const json::exception&) {
        apps_.clear();
        std::error_code ignored;
        std::filesystem::rename(store_, store_.string() + ".damaged", ignored);
    }
}

void AppRegistry::persist() {
    auto apps = json::object();
    for (const auto& [id, app] : apps_)
        apps[id] = {{"token_hash", app.token_hash}, {"signing_key", app.signing_key}, {"signatures_required", app.signatures_required}, {"manifest", app.manifest}, {"granted", app.granted}, {"values", app.values},
                    {"settings_version", app.settings_version}, {"user_suspended", app.user_suspended}, {"storage", app.storage}};
    // Written beside the target and renamed, so a crash leaves the old file whole.
    const auto temporary = store_.string() + ".tmp";
    {
        std::ofstream out(temporary, std::ios::trunc);
        if (!out) return;  // Settings still apply for this run.
        const auto seal = hmac_sha256(store_key(), apps.dump() + launch_.dump());
        out << dump_json(json{{"version", 2}, {"apps", std::move(apps)}, {"launch", launch_}, {"integrity", seal}});
        if (!out) return;
    }
    std::error_code ignored;
    // It holds application tokens, so it is as private as operator.token.
    std::filesystem::permissions(temporary, std::filesystem::perms::owner_read | std::filesystem::perms::owner_write, ignored);
    std::filesystem::rename(temporary, store_, ignored);
}

std::string AppRegistry::store_key() {
    if (!store_key_.empty()) return store_key_;
    const auto path = store_.string() + ".key";
    std::ifstream in(path);
    if (in) std::getline(in, store_key_);
    if (store_key_.size() < 32) {
        store_key_ = Seed128::secure().hex() + Seed128::secure().hex();
        std::ofstream out(path, std::ios::trunc);
        out << store_key_ << '\n';
        out.close();
        std::error_code ignored;
        std::filesystem::permissions(path, std::filesystem::perms::owner_read | std::filesystem::perms::owner_write, ignored);
    }
    return store_key_;
}

AppRegistry::App& AppRegistry::find(const std::string& id) {
    const auto found = apps_.find(id);
    if (found == apps_.end()) throw Refusal(404, "APP_NOT_FOUND", "no registered application has the ID " + id);
    return found->second;
}

// What an application shows belongs to it while it is loaded. One that has unregistered, or stopped answering, has no
// interface to change: it registers again first, rather than drawing what nobody will see.
static void require_loaded(const std::string& state) {
    if (state == "unloaded") throw Refusal(409, "APP_NOT_ACTIVE", "this application was unloaded; register again");
}

void AppRegistry::touch(App& app) {
    app.last_seen = Clock::now();
    if (app.lease_lapsed) {
        app.lease_lapsed = false;
        app.state = app.user_suspended ? "suspended" : "active";
        app.detail.clear();
        mark(app);
    }
}

void AppRegistry::sweep() {
    const auto now = Clock::now();
    for (auto& [id, app] : apps_) {
        if (app.state == "unloaded") continue;
        const auto silent = std::chrono::duration<double>(now - app.last_seen).count();
        if (silent > app.lease_s * 5) {
            app.state = "unloaded";
            app.detail = "The application stopped responding.";
            app.lease_lapsed = false;
            app.elements = json::array();
            app.presentation = nullptr;
            mark(app);
        } else if (silent > app.lease_s && !app.lease_lapsed) {
            app.lease_lapsed = true;
            ++app.lapses;
            app.state = "suspended";
            app.detail = "The application has not checked in.";
            app.presentation = nullptr;
            mark(app);
        }
    }
}

json AppRegistry::register_app(const json& raw, const std::string& presented, const std::string& launch_key) {
    if (!switches().applications) throw Refusal(403, "APPLICATIONS_DISABLED", "the operator has turned applications off on this server");
    const auto manifest = validate_manifest(raw);
    const auto id = manifest.at("id").get<std::string>();
    std::lock_guard lock(mutex_);
    sweep();
    const auto existing = apps_.find(id);
    bool returning = false;
    // The launcher started this very process, and gave it this key for the purpose. Used once.
    const auto key = launch_keys_.find(id);
    const bool launched = !launch_key.empty() && key != launch_keys_.end() && same_secret(sha256(launch_key), key->second);
    if (launched) launch_keys_.erase(key);
    if (existing != apps_.end()) {
        auto& previous = existing->second;
        const bool owner = launched || (!presented.empty() && same_secret(sha256(presented), previous.token_hash));
        if (!owner) {
            if (previous.state != "unloaded")
                throw Refusal(409, "APP_ID_CONFLICT", "an application with the ID " + id + " is already registered; present its token to update it");
            for (const auto& capability : previous.granted)
                if (kExplicit.count(capability))
                    throw Refusal(409, "APP_ID_CONFLICT", "the ID " + id + " holds granted permissions; present its token, or forget it in Settings");
        }
        returning = true;
    } else if (apps_.size() >= kMaxApps) {
        // What has gone, and that no person has given anything to, can make way. Otherwise a program that registers
        // under new names could use up every place for good.
        auto oldest = apps_.end();
        for (auto candidate = apps_.begin(); candidate != apps_.end(); ++candidate) {
            const auto& app = candidate->second;
            const bool granted = std::any_of(app.granted.begin(), app.granted.end(), [](const std::string& c) { return kExplicit.count(c) > 0; });
            if (app.state == "unloaded" && !granted && (oldest == apps_.end() || app.last_seen < oldest->second.last_seen)) oldest = candidate;
        }
        if (oldest == apps_.end()) throw Refusal(429, "APP_LIMIT_REACHED", "this server holds its maximum of " + std::to_string(kMaxApps) + " applications");
        ++revision_;
        forgotten_.emplace_back(revision_, oldest->first);
        if (forgotten_.size() > 256) forgotten_.pop_front();
        apps_.erase(oldest);
    }

    // Built aside and installed only once valid, so a refused update leaves the
    // application exactly as it was.
    App app = returning ? existing->second : App{};
    app.id = id;
    // Someone taking up an ID without its token is not the application that had it. They get what a person chose
    // for it, but not what it kept or was sent.
    if (returning && !launched && (presented.empty() || !same_secret(sha256(presented), app.token_hash))) {
        app.storage = json::object();
        app.event_queue.clear();
        app.timers.clear();
        app.topics.clear();
        app.stops.clear();
        app.nonces.clear();
    }
    // Only a hash is kept, so the token itself exists only here and with the application.
    auto token = presented;
    if (app.token_hash.empty() || !same_secret(sha256(presented), app.token_hash)) {
        token = Seed128::secure().hex() + Seed128::secure().hex();
        app.token_hash = sha256(token);
        app.signing_key = Seed128::secure().hex() + Seed128::secure().hex();
    }
    const auto requested = manifest.value("capabilities", std::vector<std::string>{});
    std::set<std::string> kept;
    // Permission to show frames was given for particular origins. Asking for more asks again.
    const auto old_origins = returning ? app.manifest.value("frame_origins", std::set<std::string>{}) : std::set<std::string>{};
    const auto new_origins = manifest.value("frame_origins", std::set<std::string>{});
    const bool widened = returning && !std::includes(old_origins.begin(), old_origins.end(), new_origins.begin(), new_origins.end());
    for (const auto& capability : requested) {
        if (switches().disabled.count(capability)) continue;
        if (kAutomatic.count(capability) || (returning && app.granted.count(capability) && !(capability == "ui.frames" && widened))) kept.insert(capability);
    }
    app.granted = std::move(kept);
    app.signatures_required = switches().require_signatures || (manifest.contains("security") && manifest.at("security").value("require_signatures", false));
    app.manifest = manifest;
    app.lease_s = manifest.value("lease_s", 60.0);
    app.elements = json::array();
    app.state = app.user_suspended ? "suspended" : "registered";
    app.detail.clear();
    app.lease_lapsed = false;
    app.presentation = nullptr;
    app.last_seen = app.bucket_at = app.view_bucket_at = app.registered_at = Clock::now();
    app.bucket = kNotificationBurst;
    if (!returning) app.order = next_order_++;
    adopt_settings(app);
    if (manifest.contains("ui")) {
        if (!manifest.at("ui").is_array()) bad("manifest.ui must be an array");
        if (manifest.at("ui").size() > kMaxElements || ui_bytes(manifest.at("ui")) > kMaxUiBytes) throw Refusal(413, "UI_TOO_LARGE", "the declared UI is too large");
        for (const auto& element : manifest.at("ui")) check_element(app, element);
        app.elements = manifest.at("ui");
        app.manifest.erase("ui");
    }
    auto& installed = apps_[id] = std::move(app);
    mark(installed);
    persist();
    return {{"app", public_view(installed, true)}, {"token", token}, {"signing_key", installed.signing_key}};
}

void AppRegistry::adopt_settings(App& app) {
    const auto version = app.manifest.contains("settings") ? app.manifest.at("settings").value("version", 1) : 0;
    auto values = app.values;
    const auto from = app.settings_version;
    // Controlled migration: renames the application declared, one version at a time.
    if (from > 0 && from < version && app.manifest.at("settings").contains("migrations")) {
        const auto& migrations = app.manifest.at("settings").at("migrations");
        for (int step = from; step < version; ++step) {
            const auto key = std::to_string(step);
            if (!migrations.contains(key) || !migrations.at(key).contains("rename")) continue;
            for (const auto& [old_name, new_name] : migrations.at(key).at("rename").items()) {
                if (new_name.is_string() && values.contains(old_name)) {
                    values[new_name.get<std::string>()] = values[old_name];
                    values.erase(old_name);
                }
            }
        }
    }
    // Only what the current schema defines survives, and only if still valid.
    auto kept = json::object();
    for (const auto& field : schema_fields(app.manifest)) {
        const auto name = field.at("id").get<std::string>();
        kept[name] = values.contains(name) && field_accepts(field, values.at(name)) ? values.at(name) : field.at("default");
    }
    app.values = std::move(kept);
    app.settings_version = version;
    if (from > 0 && from != version) push_event(app, "settings.migrated", {{"from", from}, {"to", version}, {"values", app.values}});
}

namespace {
// Widgets are drawn by the observer's own components, so most of what they say is only text. What could lead
// somewhere is checked: a link opens in a tab of its own, and only over http or https. Where a widget sits on the
// panel's grid is checked too, so that a layout can't ask for what the grid hasn't got.
void check_widgets(const json& widgets, int depth) {
    if (!widgets.is_array()) throw Refusal(400, "INVALID_ELEMENT", "widgets must be an array");
    if (depth > 3) throw Refusal(400, "INVALID_ELEMENT", "widgets may be nested 3 deep");
    for (const auto& widget : widgets) {
        if (!widget.is_object()) throw Refusal(400, "INVALID_ELEMENT", "a widget must be an object");
        const auto type = widget.value("type", json(nullptr));
        if (!type.is_string()) throw Refusal(400, "INVALID_ELEMENT", "a widget needs a type");
        if (type == "link") {
            const auto url = widget.value("url", json(nullptr));
            if (!url.is_string() || !(url.get<std::string>().starts_with("http://") || url.get<std::string>().starts_with("https://")) || url.get<std::string>().size() > 2000)
                throw Refusal(400, "INVALID_ELEMENT", "a link needs an http or https url");
        }
        if (type == "qr") {
            // What a QR code holds is drawn as a code of version 10 at most, which holds 213 bytes.
            const json held = widget.contains("url") ? widget.at("url") : widget.value("text", json(nullptr));
            if (!held.is_string() || held.get<std::string>().empty() || held.get<std::string>().size() > 213)
                throw Refusal(400, "INVALID_ELEMENT", "a qr widget needs a url or text of 1 to 213 bytes");
        }
        // What the newer widgets carry is bounded, so one widget can't grow without end.
        const auto bounded = [&](const char* key, std::size_t most, const char* what) {
            if (widget.contains(key) && !(widget.at(key).is_array() && widget.at(key).size() <= most))
                throw Refusal(400, "INVALID_ELEMENT", std::string(what) + " must be a list of at most " + std::to_string(most));
        };
        bounded("seats", 120, "seats");
        bounded("choices", 2000, "choices");
        bounded("fields", 12, "fields");
        bounded("lines_text", 200, "lines_text");
        if (type == "form" && widget.contains("fields"))
            for (const auto& field : widget.at("fields"))
                if (!field.is_object() || !field.value("id", json(nullptr)).is_string()) throw Refusal(400, "INVALID_ELEMENT", "each form field needs an id");
        if (type == "countdown" && !widget.value("until", json(nullptr)).is_number()) throw Refusal(400, "INVALID_ELEMENT", "a countdown needs until, in milliseconds since the epoch");
        if (widget.contains("area")) {
            const auto& area = widget.at("area");
            if (!area.is_object()) throw Refusal(400, "INVALID_ELEMENT", "area must be an object");
            for (const char* key : {"column", "row", "width", "height"})
                if (area.contains(key) && !(area.at(key).is_number_unsigned() && area.at(key).get<int>() >= 1 && area.at(key).get<int>() <= 12))
                    throw Refusal(400, "INVALID_ELEMENT", std::string("area.") + key + " must be 1 to 12");
        }
        if (widget.contains("tabs") && widget.at("tabs").is_array())
            for (const auto& tab : widget.at("tabs"))
                if (tab.is_object() && tab.contains("widgets")) check_widgets(tab.at("widgets"), depth + 1);
        if (widget.contains("widgets")) check_widgets(widget.at("widgets"), depth + 1);
    }
}
} // namespace

void AppRegistry::check_element(const App& app, const json& element) const {
    if (!element.is_object()) throw Refusal(400, "INVALID_ELEMENT", "a UI element must be an object");
    const auto id = element.value("id", json(nullptr));
    if (!id.is_string() || !std::regex_match(id.get<std::string>(), kKey)) throw Refusal(400, "INVALID_ELEMENT", "a UI element needs an id matching [a-z0-9][a-z0-9_-]*");
    const auto slot = element.value("slot", std::string{});
    if (element.contains("motion")) check_motion(element.at("motion"));
    if (element.contains("features")) {
        if (!element.at("features").is_array()) throw Refusal(400, "INVALID_ELEMENT", "features must be an array");
        for (const auto& feature : element.at("features")) check_feature(feature);
    }
    const auto capability = kSlotCapability.find(slot);
    if (capability == kSlotCapability.end()) throw Refusal(400, "INVALID_ELEMENT", "unknown UI slot: " + slot);
    if (element.contains("layout")) {
        const auto& layout = element.at("layout");
        const auto columns = layout.is_object() ? layout.value("columns", json(6)) : json(nullptr);
        if (!columns.is_number_unsigned() || columns.get<int>() < 1 || columns.get<int>() > 12) throw Refusal(400, "INVALID_ELEMENT", "layout.columns must be 1 to 12");
    }
    if (element.contains("widgets")) check_widgets(element.at("widgets"), 0);
    if (element.contains("tone") && (!element.at("tone").is_string() || !kTones.count(element.at("tone").get<std::string>())))
        throw Refusal(400, "INVALID_ELEMENT", "tone must be neutral, accent, ok, warn or danger; applications do not choose colours");
    // A declared URL is only ever loaded into a sandboxed frame, and only over http(s).
    if (element.contains("frame")) {
        const auto url = element.at("frame").is_string() ? element.at("frame").get<std::string>() : std::string{};
        if ((slot != "panel" && slot != "sidebar" && slot != "deck") || !(url.starts_with("http://") || url.starts_with("https://")) || url.size() > 2000)
            throw Refusal(400, "INVALID_ELEMENT", "frame must be an http or https URL on a panel or sidebar");
        // Declared origins are a promise: a frame cannot quietly come from somewhere else.
        if (app.manifest.contains("frame_origins")) {
            const auto scheme = url.find("://");
            const auto end = url.find_first_of("/?#", scheme + 3);
            const auto origin = url.substr(0, end);
            const auto& allowed = app.manifest.at("frame_origins");
            if (std::find(allowed.begin(), allowed.end(), origin) == allowed.end())
                throw Refusal(403, "FRAME_ORIGIN_NOT_DECLARED", "frame comes from " + origin + ", which the manifest does not declare");
        }
        if (app.manifest.contains("capabilities")) {
            const auto& requested = app.manifest.at("capabilities");
            if (std::find(requested.begin(), requested.end(), "ui.frames") == requested.end())
                throw Refusal(403, "CAPABILITY_NOT_REQUESTED", "frame needs the ui.frames capability in the manifest");
        } else {
            throw Refusal(403, "CAPABILITY_NOT_REQUESTED", "frame needs the ui.frames capability in the manifest");
        }
    }
    const auto& requested = app.manifest.contains("capabilities") ? app.manifest.at("capabilities") : json::array();
    if (std::find(requested.begin(), requested.end(), capability->second) == requested.end())
        throw Refusal(403, "CAPABILITY_NOT_REQUESTED", "the " + slot + " slot needs the " + capability->second + " capability in the manifest");
}

std::size_t AppRegistry::ui_bytes(const json& elements) const { return elements.dump().size(); }

void AppRegistry::authenticate(const std::string& id, const std::string& token) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (token.empty() || !same_secret(sha256(token), app.token_hash)) {
        ++app.refused;
        throw Refusal(401, "APP_TOKEN_INVALID", "this request needs the application's bearer token");
    }
    ++app.requests;
    touch(app);
}

void AppRegistry::require_capability(const std::string& id, const std::string& capability) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (switches().disabled.count(capability)) {
        ++app.refused;
        throw Refusal(403, "CAPABILITY_DISABLED", "the operator has turned " + capability + " off on this server");
    }
    if (!app.granted.count(capability)) {
        ++app.refused;
        throw Refusal(403, "CAPABILITY_NOT_GRANTED", "this application has not been granted " + capability);
    }
    if (app.state == "suspended" || app.state == "unloaded" || app.state == "failed")
        throw Refusal(409, "APP_NOT_ACTIVE", "this application is " + app.state);
}

json AppRegistry::public_view(const App& app, bool with_ui) const {
    auto requested = app.manifest.value("capabilities", json::array());
    auto pending = json::array();
    for (const auto& capability : requested)
        if (!app.granted.count(capability.get<std::string>())) pending.push_back(capability);
    json view = {{"id", app.id}, {"name", app.manifest.value("name", app.id)}, {"version", app.manifest.value("version", "")},
                 {"description", app.manifest.value("description", "")}, {"author", app.manifest.value("author", "")},
                 {"state", app.state}, {"detail", app.detail}, {"user_suspended", app.user_suspended}, {"order", app.order},
                 {"capabilities", {{"requested", std::move(requested)}, {"granted", app.granted}, {"pending", std::move(pending)}}},
                 {"settings", app.manifest.value("settings", json(nullptr))},
                 {"security", {{"signatures_required", app.signatures_required}, {"frame_origins", app.manifest.value("frame_origins", json::array())}}},
                 {"web", app.manifest.value("web", json(nullptr))}};
    if (view["settings"].is_object()) view["settings"].erase("migrations");
    if (with_ui) {
        auto shown = json::array();
        auto blocked = json::array();
        const bool visible = app.state == "registered" || app.state == "initialized" || app.state == "active";
        for (const auto& element : app.elements) {
            const auto slot = element.value("slot", std::string{});
            const bool frame_refused = element.contains("frame") && !app.granted.count("ui.frames");
            if (frame_refused || !app.granted.count(kSlotCapability.at(slot))) blocked.push_back(element.at("id"));
            else if (visible) shown.push_back(element);
        }
        view["ui"] = std::move(shown);
        view["blocked_ui"] = std::move(blocked);
    }
    return view;
}

json AppRegistry::list() {
    std::lock_guard lock(mutex_);
    sweep();
    auto items = json::array();
    for (const auto& [id, app] : apps_) items.push_back(public_view(app, false));
    return items;
}

json AppRegistry::describe(const std::string& id) {
    std::lock_guard lock(mutex_);
    sweep();
    return public_view(find(id), true);
}

json AppRegistry::state(std::uint64_t since, std::uint64_t notifications_since, std::uint64_t view_since) {
    std::lock_guard lock(mutex_);
    sweep();
    auto recent = json::array();
    for (const auto& item : notifications_) {
        if (item.at("sequence").get<std::uint64_t>() <= notifications_since) continue;
        recent.push_back(item);
        if (recent.size() >= kMaxPage) break;
    }
    // Only what is still fresh, from an application still allowed to ask: an observer coming back must not
    // be thrown around by what was asked while it was away.
    const auto live = [](const App& app) { return app.state != "suspended" && app.state != "unloaded" && app.state != "failed"; };
    auto views = json::array();
    const auto at = wall_ms();
    for (const auto& item : view_requests_) {
        if (item.at("request").get<std::uint64_t>() <= view_since || at - item.at("at_ms").get<std::int64_t>() > kViewFreshMs) continue;
        const auto asker = apps_.find(item.at("app").get<std::string>());
        if (asker != apps_.end() && live(asker->second) && asker->second.granted.count("ui.camera")) views.push_back(item);
    }
    auto held = json::array();
    std::vector<const App*> holders;
    for (const auto& [id, app] : apps_)
        if (!app.presentation.is_null() && live(app) && app.granted.count("ui.layers")) holders.push_back(&app);
    std::sort(holders.begin(), holders.end(), [](const App* a, const App* b) { return a->order < b->order; });
    for (const auto* app : holders)
        held.push_back({{"app", app->id}, {"name", app->manifest.value("name", app->id)}, {"revision", app->presentation_at}, {"layers", app->presentation.at("layers")}, {"places", app->presentation.at("places")}});
    json out = {{"revision", revision_}, {"notification_sequence", notification_sequence_}, {"notifications", std::move(recent)}, {"launch_plan", launch_plan_},
                {"view_sequence", view_sequence_}, {"view_requests", std::move(views)}, {"presentation", std::move(held)},
                {"reload_sequence", reload_sequence_}, {"reloads", json(reloads_)}};
    if (since == revision_) {
        out["unchanged"] = true;
        return out;
    }
    // A first request gets everything. After that, only what changed: an application
    // moving its buses once a second must not resend its whole network.
    auto apps = json::array();
    for (const auto& [id, app] : apps_) {
        if (since && app.changed_at <= since) continue;
        auto view = public_view(app, true);
        if (since && app.ui_all_at <= since) {
            auto patch = json::array();
            auto order = json::array();
            for (const auto& element : view["ui"]) {
                const auto name = element.at("id").get<std::string>();
                order.push_back(name);
                const auto rev = app.element_rev.find(name);
                if (rev != app.element_rev.end() && rev->second > since) patch.push_back(element);
            }
            view.erase("ui");
            view["ui_patch"] = std::move(patch);
            view["ui_order"] = std::move(order);
        }
        apps.push_back(std::move(view));
    }
    std::sort(apps.begin(), apps.end(), [](const json& a, const json& b) { return a.at("order") < b.at("order"); });
    auto removed = json::array();
    for (const auto& [rev, id] : forgotten_)
        if (rev > since) removed.push_back(id);
    out["unchanged"] = false;
    out["full"] = since == 0;
    out["apps"] = std::move(apps);
    out["removed"] = std::move(removed);
    return out;
}

void AppRegistry::remove(const std::string& id, bool forget) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (forget) {
        apps_.erase(id);
        ++revision_;
        forgotten_.emplace_back(revision_, id);
        if (forgotten_.size() > 256) forgotten_.pop_front();
    } else {
        app.state = "unloaded";
        app.detail = "The application unregistered itself.";
        app.elements = json::array();
        app.presentation = nullptr;
        app.lease_lapsed = false;
        mark(app);
    }
    persist();
}

void AppRegistry::heartbeat(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (app.state == "unloaded") throw Refusal(409, "APP_NOT_ACTIVE", "this application was unloaded; register again");
    touch(app);
    if (app.state == "registered" || app.state == "initialized") {
        app.state = "active";
        mark(app);
    }
}

void AppRegistry::set_state(const std::string& id, const std::string& state, const std::string& detail) {
    if (!kReportedStates.count(state)) throw std::invalid_argument("state must be initialized, active or failed");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    // An unloaded application registers again before it reports anything; a report is also a sign of life.
    require_loaded(app.state);
    if (app.user_suspended) throw Refusal(409, "APP_SUSPENDED", "the viewer has suspended this application");
    touch(app);
    app.state = state;
    app.detail = detail.substr(0, 280);
    mark(app);
}

void AppRegistry::suspend(const std::string& id, bool suspended) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (app.state == "unloaded") throw Refusal(409, "APP_NOT_ACTIVE", "this application is no longer running");
    app.user_suspended = suspended;
    // Resumed, one that has stopped checking in is still shown as not answering, not as active.
    app.state = suspended || app.lease_lapsed ? "suspended" : "active";
    app.detail = suspended ? "Suspended from Settings." : app.lease_lapsed ? "The application has not checked in." : "";
    if (suspended) app.presentation = nullptr;
    push_event(app, suspended ? "app.suspended" : "app.resumed", json::object());
    mark(app);
    persist();
}

void AppRegistry::report_failure(const std::string& id, const std::string& detail) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (app.state == "unloaded" || app.user_suspended) return;
    app.state = "failed";
    app.detail = detail.substr(0, 280);
    push_event(app, "app.failed", {{"detail", app.detail}});
    mark(app);
}

void AppRegistry::set_ui(const std::string& id, const json& elements) {
    if (!elements.is_array()) throw Refusal(400, "INVALID_ELEMENT", "the UI must be an array of elements");
    if (elements.size() > kMaxElements) throw Refusal(413, "UI_TOO_LARGE", "at most " + std::to_string(kMaxElements) + " elements");
    if (ui_bytes(elements) > kMaxUiBytes) throw Refusal(413, "UI_TOO_LARGE", "the declared UI is too large");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    require_loaded(app.state);
    std::set<std::string> ids;
    for (const auto& element : elements) {
        check_element(app, element);
        if (!ids.insert(element.at("id").get<std::string>()).second) throw Refusal(400, "INVALID_ELEMENT", "element IDs must be unique");
    }
    app.elements = elements;
    mark(app);
}

void AppRegistry::upsert_element(const std::string& id, const std::string& element, const json& value) {
    if (!value.is_object()) throw Refusal(400, "INVALID_ELEMENT", "a UI element must be an object");
    auto copy = value;
    copy["id"] = element;
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    require_loaded(app.state);
    check_element(app, copy);
    auto next = app.elements;
    const auto existing = std::find_if(next.begin(), next.end(), [&](const json& item) { return item.at("id") == element; });
    if (existing != next.end()) *existing = copy;
    else next.push_back(copy);
    if (next.size() > kMaxElements) throw Refusal(413, "UI_TOO_LARGE", "at most " + std::to_string(kMaxElements) + " elements");
    if (ui_bytes(next) > kMaxUiBytes) throw Refusal(413, "UI_TOO_LARGE", "the declared UI is too large");
    app.elements = std::move(next);
    ++revision_;
    app.changed_at = revision_;
    app.element_rev[element] = revision_;
}

void AppRegistry::remove_element(const std::string& id, const std::string& element) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    require_loaded(app.state);
    auto& items = app.elements;
    const auto existing = std::find_if(items.begin(), items.end(), [&](const json& item) { return item.at("id") == element; });
    if (existing == items.end()) throw Refusal(404, "ELEMENT_NOT_FOUND", "no such element: " + element);
    items.erase(existing);
    ++revision_;
    app.changed_at = revision_;
}

std::uint64_t AppRegistry::notify(const std::string& id, const json& notification) {
    if (!notification.is_object()) throw Refusal(400, "INVALID_NOTIFICATION", "a notification must be an object");
    const auto severity = notification.value("severity", std::string("info"));
    if (severity != "info" && severity != "warning" && severity != "alert")
        throw Refusal(400, "INVALID_NOTIFICATION", "severity must be info, warning or alert");
    const auto title = notification.value("title", std::string{});
    const auto body = notification.value("body", std::string{});
    if (title.empty() || title.size() > 120 || body.size() > 600)
        throw Refusal(400, "INVALID_NOTIFICATION", "a notification needs a title of up to 120 bytes and a body of up to 600");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    const auto now = Clock::now();
    app.bucket = std::min(kNotificationBurst, app.bucket + std::chrono::duration<double>(now - app.bucket_at).count() * kNotificationsPerSecond);
    app.bucket_at = now;
    // Refused, not dropped: the application is told, and can send again.
    if (app.bucket < 1) {
        ++app.rate_limited;
        throw Refusal(429, "RATE_LIMITED", "too many notifications; send fewer, or update a status element instead");
    }
    app.bucket -= 1;
    notifications_.push_back({{"sequence", ++notification_sequence_}, {"app_id", id}, {"app_name", app.manifest.value("name", id)},
                              {"severity", severity}, {"title", title}, {"body", body}, {"at_ms", wall_ms()}});
    while (notifications_.size() > kMaxNotifications) notifications_.pop_front();
    return notification_sequence_;
}

void AppRegistry::push_event(App& app, const std::string& type, const json& data) {
    app.event_queue.push_back({{"sequence", ++app.event_sequence}, {"type", type}, {"data", data}, {"at_ms", wall_ms()}});
    while (app.event_queue.size() > kMaxEventQueue) {
        app.event_queue.pop_front();
        ++app.dropped_events;
    }
}

json AppRegistry::events(const std::string& id, std::uint64_t since) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    auto items = json::array();
    for (const auto& event : app.event_queue) {
        if (event.at("sequence").get<std::uint64_t>() <= since) continue;
        items.push_back(event);
        if (items.size() >= kMaxPage) break;
    }
    const auto oldest = app.event_queue.empty() ? app.event_sequence + 1 : app.event_queue.front().at("sequence").get<std::uint64_t>();
    return {{"items", std::move(items)}, {"sequence", app.event_sequence}, {"dropped", oldest > since + 1 ? oldest - since - 1 : 0}};
}

void AppRegistry::post_event(const std::string& id, const std::string& type, const json& data) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    push_event(app, type, data);
}

json AppRegistry::settings(const std::string& id) {
    std::lock_guard lock(mutex_);
    const auto& app = find(id);
    return {{"version", app.settings_version}, {"values", app.values}};
}

json AppRegistry::update_settings(const std::string& id, const json& changes) {
    if (!changes.is_object()) throw Refusal(400, "INVALID_SETTINGS", "settings must be an object of field IDs and values");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    const auto fields = schema_fields(app.manifest);
    for (const auto& [key, value] : changes.items()) {
        const auto field = std::find_if(fields.begin(), fields.end(), [&](const json& item) { return item.at("id") == key; });
        if (field == fields.end()) throw Refusal(400, "INVALID_SETTINGS", "unknown setting: " + key);
        if (!field_accepts(*field, value)) throw Refusal(400, "INVALID_SETTINGS", "invalid value for " + key);
    }
    // Checked in full first, so a request applies completely or not at all.
    for (const auto& [key, value] : changes.items()) app.values[key] = value;
    push_event(app, "settings.changed", {{"changes", changes}, {"values", app.values}});
    mark(app);
    persist();
    return {{"version", app.settings_version}, {"values", app.values}};
}

json AppRegistry::reset_settings(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    auto values = json::object();
    for (const auto& field : schema_fields(app.manifest)) values[field.at("id").get<std::string>()] = field.at("default");
    app.values = std::move(values);
    push_event(app, "settings.changed", {{"changes", app.values}, {"values", app.values}, {"reset", true}});
    mark(app);
    persist();
    return {{"version", app.settings_version}, {"values", app.values}};
}

json AppRegistry::set_grants(const std::string& id, const json& capabilities) {
    if (!capabilities.is_array()) throw std::invalid_argument("capabilities must be an array");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    const auto requested = app.manifest.value("capabilities", std::set<std::string>{});
    std::set<std::string> granted;
    for (const auto& capability : capabilities) {
        const auto name = capability.get<std::string>();
        if (!requested.count(name)) throw Refusal(400, "CAPABILITY_NOT_REQUESTED", "the application did not ask for " + name);
        if (switches().disabled.count(name)) throw Refusal(403, "CAPABILITY_DISABLED", "the operator has turned " + name + " off on this server");
        granted.insert(name);
    }
    app.granted = std::move(granted);
    if (!app.granted.count("ui.layers")) app.presentation = nullptr;
    push_event(app, "capabilities.changed", {{"granted", app.granted}});
    mark(app);
    persist();
    return public_view(app, false);
}

void AppRegistry::audit(const std::string& id, const std::string& action, const json& params,
                        const std::string& run_id, double virtual_s, const std::string& outcome) {
    std::lock_guard lock(mutex_);
    // The record says what was asked, not everything sent: a few bytes for each of 2000 entries is fine, and megabytes are not.
    json entry = {{"sequence", ++audit_sequence_}, {"app_id", id}, {"action", action}, {"params", params.dump().size() > 2048 ? json{{"truncated", true}} : params}, {"run_id", run_id},
                  {"virtual_s", virtual_s}, {"outcome", outcome}, {"at_ms", wall_ms()}, {"previous", audit_head_}};
    audit_head_ = sha256(entry.dump());
    entry["hash"] = audit_head_;
    audit_.push_back(std::move(entry));
    while (audit_.size() > kMaxAudit) audit_.pop_front();
}

json AppRegistry::audit_verify() {
    std::lock_guard lock(mutex_);
    std::string previous = audit_.empty() ? std::string{} : audit_.front().at("previous").get<std::string>();
    std::size_t checked = 0;
    for (auto entry : audit_) {
        const auto claimed = entry.at("hash").get<std::string>();
        entry.erase("hash");
        if (entry.at("previous") != previous || sha256(entry.dump()) != claimed)
            return {{"intact", false}, {"checked", checked}, {"first_bad_sequence", entry.at("sequence")}};
        previous = claimed;
        ++checked;
    }
    return {{"intact", previous == audit_head_ || audit_.empty()}, {"checked", checked}, {"head", audit_head_}};
}

json AppRegistry::audit_log(std::size_t limit) {
    std::lock_guard lock(mutex_);
    auto items = json::array();
    const auto count = std::min(limit, audit_.size());
    for (auto entry = audit_.end() - static_cast<std::ptrdiff_t>(count); entry != audit_.end(); ++entry) items.push_back(*entry);
    return items;
}

json AppRegistry::discovery() {
    auto slots = json::array();
    for (const auto& [slot, capability] : kSlotCapability) slots.push_back({{"slot", slot}, {"capability", capability}});
    return {
        {"manifest_version", kManifestVersion},
        {"requires_api", kApiMajor},
        {"capabilities", {{"automatic", kAutomatic}, {"needs_a_person", kExplicit}}},
        {"slots", std::move(slots)},
        {"widgets", {"text", "heading", "note", "stat", "stats", "metric", "keyvalues", "table", "gauge", "bars", "progress", "sparkline", "chart", "route", "timeline", "status", "chips", "list", "legend", "tabs", "card", "divider", "link", "qr", "input", "button", "toggle", "select", "slider", "seats", "combobox", "player", "form", "countdown", "notice", "code", "empty"}},
        {"overlay_features", {"route", "path", "marker", "circle", "polygon", "line", "label", "heatmap"}},
        {"layout", {{"columns", {{"min", 1}, {"max", 12}, {"default", 6}}}, {"area", {"column", "row", "width", "height"}}}},
        {"switches", {{"applications", switches().applications}, {"launch_proposals", switches().launch_proposals}, {"require_signatures", switches().require_signatures}, {"disabled_capabilities", switches().disabled}}},
        {"path_styles", {"solid", "dashed", "dotted", "flow"}},
        {"view_actions", {"focus", "node", "edge", "bounds", "zoom", "fit"}},
        {"layers", kLayers},
        {"motions", {"none", "fade", "rise", "slide", "scale", "pop", "drop"}},
        {"tones", kTones},
        {"topics", {"lifecycle", "world", "news", "news.<category>"}},
        {"security", {{"token_rotation", true}, {"signed_requests", "hmac-sha256"}, {"signature_window_s", kSignatureWindowS}, {"frame_origins", true}, {"response_digest", "sha256"}}},
        {"limits", {{"apps", kMaxApps}, {"elements", kMaxElements}, {"ui_bytes", kMaxUiBytes}, {"events_kept", kMaxEventQueue}, {"timers", kMaxTimers},
                    {"topics", kMaxTopics}, {"storage_keys", kMaxStorageKeys}, {"storage_bytes", kMaxStorageBytes}, {"message_bytes", kMaxMessageBytes}}},
    };
}

void AppRegistry::batch_ui(const std::string& id, const json& upsert, const json& remove) {
    if (!upsert.is_array() || !remove.is_array()) throw Refusal(400, "INVALID_ELEMENT", "upsert and remove must be arrays");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    require_loaded(app.state);
    auto next = app.elements;
    std::vector<std::string> changed;
    for (const auto& element : remove) {
        if (!element.is_string()) throw Refusal(400, "INVALID_ELEMENT", "remove lists element IDs");
        const auto existing = std::find_if(next.begin(), next.end(), [&](const json& item) { return item.at("id") == element; });
        if (existing == next.end()) throw Refusal(404, "ELEMENT_NOT_FOUND", "no such element: " + element.get<std::string>());
        next.erase(existing);
    }
    for (const auto& element : upsert) {
        check_element(app, element);
        const auto existing = std::find_if(next.begin(), next.end(), [&](const json& item) { return item.at("id") == element.at("id"); });
        if (existing != next.end()) *existing = element;
        else next.push_back(element);
        changed.push_back(element.at("id").get<std::string>());
    }
    // Every check comes before any change, so a refused batch leaves everything as it was.
    if (next.size() > kMaxElements) throw Refusal(413, "UI_TOO_LARGE", "at most " + std::to_string(kMaxElements) + " elements");
    if (ui_bytes(next) > kMaxUiBytes) throw Refusal(413, "UI_TOO_LARGE", "the declared UI is too large");
    app.elements = std::move(next);
    if (remove.empty()) {
        ++revision_;
        app.changed_at = revision_;
        for (const auto& element : changed) app.element_rev[element] = revision_;
    } else {
        mark(app);
    }
}

json AppRegistry::subscribe(const std::string& id, const json& topics) {
    if (!topics.is_array() || topics.size() > kMaxTopics) throw Refusal(400, "INVALID_TOPICS", "topics must be an array of up to " + std::to_string(kMaxTopics));
    static const std::regex kTopic("lifecycle|world|news(\\.[a-z_]{1,32})?");
    std::set<std::string> wanted;
    for (const auto& topic : topics) {
        if (!topic.is_string() || !std::regex_match(topic.get<std::string>(), kTopic)) throw Refusal(400, "INVALID_TOPICS", "unknown topic: " + topic.dump());
        wanted.insert(topic.get<std::string>());
    }
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    app.topics = std::move(wanted);
    return {{"topics", app.topics}};
}

json AppRegistry::set_timer(const std::string& id, const std::string& timer, const json& spec) {
    if (!spec.is_object() || !spec.value("at_s", json(nullptr)).is_number()) throw Refusal(400, "INVALID_TIMER", "a timer needs at_s, in simulated seconds");
    const auto at_s = spec.at("at_s").get<double>();
    const auto every_s = spec.value("every_s", 0.0);
    if (!std::isfinite(at_s) || at_s < 0 || !std::isfinite(every_s) || every_s < 0 || (every_s > 0 && every_s < 1))
        throw Refusal(400, "INVALID_TIMER", "at_s must not be negative, and every_s must be at least 1");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (!app.timers.count(timer) && app.timers.size() >= kMaxTimers) throw Refusal(413, "TOO_MANY_TIMERS", "at most " + std::to_string(kMaxTimers) + " timers");
    App::Timer entry{at_s, every_s, at_s, false, spec.value("data", json(nullptr))};
    if (app.seen_virtual >= 0 && every_s > 0)
        while (entry.next_s <= app.seen_virtual) entry.next_s += every_s;
    app.timers[timer] = std::move(entry);
    return {{"id", timer}, {"at_s", at_s}, {"every_s", every_s}};
}

void AppRegistry::clear_timer(const std::string& id, const std::string& timer) {
    std::lock_guard lock(mutex_);
    if (!find(id).timers.erase(timer)) throw Refusal(404, "TIMER_NOT_FOUND", "no such timer: " + timer);
}

json AppRegistry::timers(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto items = json::array();
    for (const auto& [name, timer] : find(id).timers)
        items.push_back({{"id", name}, {"at_s", timer.at_s}, {"every_s", timer.every_s}, {"next_s", timer.next_s}, {"done", timer.done}});
    return {{"items", std::move(items)}};
}

bool AppRegistry::follows_simulation(const std::string& id) {
    std::lock_guard lock(mutex_);
    const auto& app = find(id);
    return !app.topics.empty() || !app.timers.empty();
}

std::uint64_t AppRegistry::news_cursor(const std::string& id) {
    std::lock_guard lock(mutex_);
    return find(id).news_seen;
}

void AppRegistry::pump(const std::string& id, const std::string& run_id, const std::string& lifecycle, double virtual_s, const json& news) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    const auto wants = [&](const std::string& topic) { return app.topics.count(topic) > 0; };
    const bool new_run = run_id != app.seen_run;
    if (new_run) {
        if (!app.seen_run.empty() && wants("world")) push_event(app, "world.changed", {{"run_id", run_id}});
        app.seen_run = run_id;
        app.news_seen = 0;
    }
    if (lifecycle != app.seen_lifecycle) {
        if (wants("lifecycle")) push_event(app, "lifecycle.changed", {{"from", app.seen_lifecycle}, {"to", lifecycle}, {"run_id", run_id}, {"virtual_s", virtual_s}});
        app.seen_lifecycle = lifecycle;
    }
    if (news.is_array()) {
        for (const auto& item : news) {
            const auto number = item.value("news_id", std::uint64_t{0});
            if (number <= app.news_seen) continue;
            app.news_seen = number;
            const auto category = item.value("category", std::string{});
            if (wants("news") || wants("news." + category)) push_event(app, "news", item);
        }
    }
    // Moving back through the day, by a reset or a replay, sets the timers going again.
    if (new_run || virtual_s + 1e-6 < app.seen_virtual)
        for (auto& [name, timer] : app.timers) {
            timer.done = false;
            timer.next_s = timer.at_s;
            if (timer.every_s > 0)
                while (timer.next_s < virtual_s) timer.next_s += timer.every_s;
        }
    app.seen_virtual = virtual_s;
    for (auto& [name, timer] : app.timers) {
        if (timer.done || virtual_s < timer.next_s) continue;
        push_event(app, "timer", {{"id", name}, {"at_s", timer.next_s}, {"virtual_s", virtual_s}, {"data", timer.data}});
        if (timer.every_s > 0) {
            while (timer.next_s <= virtual_s) timer.next_s += timer.every_s;
        } else {
            timer.done = true;
        }
    }
}

json AppRegistry::storage(const std::string& id) {
    std::lock_guard lock(mutex_);
    const auto& app = find(id);
    auto keys = json::array();
    for (const auto& [key, value] : app.storage.items()) keys.push_back(key);
    return {{"keys", std::move(keys)}, {"bytes", app.storage.dump().size()}, {"limit_bytes", kMaxStorageBytes}};
}

json AppRegistry::storage_get(const std::string& id, const std::string& key) {
    std::lock_guard lock(mutex_);
    const auto& app = find(id);
    if (!app.storage.contains(key)) throw Refusal(404, "KEY_NOT_FOUND", "nothing is stored under " + key);
    return {{"key", key}, {"value", app.storage.at(key)}};
}

void AppRegistry::storage_put(const std::string& id, const std::string& key, const json& value) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    auto next = app.storage;
    next[key] = value;
    if (next.size() > kMaxStorageKeys) throw Refusal(413, "STORAGE_FULL", "at most " + std::to_string(kMaxStorageKeys) + " keys");
    if (next.dump().size() > kMaxStorageBytes) throw Refusal(413, "STORAGE_FULL", "the store is limited to " + std::to_string(kMaxStorageBytes) + " bytes");
    app.storage = std::move(next);
    persist();
}

void AppRegistry::storage_delete(const std::string& id, const std::string& key) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (!app.storage.erase(key)) throw Refusal(404, "KEY_NOT_FOUND", "nothing is stored under " + key);
    persist();
}

void AppRegistry::send_message(const std::string& from, const std::string& to, const json& message) {
    if (!message.is_object() || !message.value("type", json(nullptr)).is_string()) throw Refusal(400, "INVALID_MESSAGE", "a message needs a type");
    if (message.dump().size() > kMaxMessageBytes) throw Refusal(413, "MESSAGE_TOO_LARGE", "a message is limited to " + std::to_string(kMaxMessageBytes) + " bytes");
    std::lock_guard lock(mutex_);
    auto& sender = find(from);
    auto& recipient = find(to);
    if (!recipient.granted.count("apps.messages")) throw Refusal(403, "RECIPIENT_NOT_LISTENING", to + " does not accept messages");
    const auto now = Clock::now();
    sender.bucket = std::min(kNotificationBurst, sender.bucket + std::chrono::duration<double>(now - sender.bucket_at).count() * kNotificationsPerSecond);
    sender.bucket_at = now;
    if (sender.bucket < 1) {
        ++sender.rate_limited;
        throw Refusal(429, "RATE_LIMITED", "too many messages; send fewer");
    }
    sender.bucket -= 1;
    ++sender.messages_sent;
    ++recipient.messages_received;
    push_event(recipient, "message", {{"from", from}, {"type", message.at("type")}, {"data", message.value("data", json(nullptr))}});
}

json AppRegistry::health(const std::string& id) {
    std::lock_guard lock(mutex_);
    const auto& app = find(id);
    const auto now = Clock::now();
    const auto ago = [&](Clock::time_point when) { return when == Clock::time_point{} ? json(nullptr) : json(std::chrono::duration<double>(now - when).count()); };
    return {{"id", id}, {"state", app.state}, {"detail", app.detail}, {"lease_s", app.lease_s}, {"last_seen_s", ago(app.last_seen)}, {"uptime_s", ago(app.registered_at)},
            {"requests", app.requests}, {"refused", app.refused}, {"rate_limited", app.rate_limited}, {"lease_lapses", app.lapses},
            {"events", {{"sequence", app.event_sequence}, {"queued", app.event_queue.size()}, {"dropped", app.dropped_events}}},
            {"messages", {{"sent", app.messages_sent}, {"received", app.messages_received}}},
            {"ui", {{"elements", app.elements.size()}, {"bytes", ui_bytes(app.elements)}}},
            {"storage", {{"keys", app.storage.size()}, {"bytes", app.storage.dump().size()}}},
            {"timers", app.timers.size()}, {"topics", app.topics}};
}

void AppRegistry::verify_signature(const std::string& id, const std::string& method, const std::string& target, const std::string& timestamp,
                                   const std::string& nonce, const std::string& signature, const std::string& body) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (signature.empty()) {
        if (!app.signatures_required) return;
        ++app.refused;
        throw Refusal(401, "SIGNATURE_REQUIRED", "this application asked for its requests to be signed");
    }
    const auto refuse = [&](const std::string& code, const std::string& message) {
        ++app.refused;
        throw Refusal(401, code, message);
    };
    std::int64_t at = 0;
    try {
        at = std::stoll(timestamp);
    } catch (const std::exception&) {
        refuse("SIGNATURE_INVALID", "X-DSTNS-Timestamp must be seconds since the epoch");
    }
    const std::int64_t now = wall_ms() / 1000;
    if (std::llabs(now - at) > kSignatureWindowS) refuse("SIGNATURE_EXPIRED", "the signature's timestamp is more than " + std::to_string(kSignatureWindowS) + " seconds out");
    if (nonce.size() < 8 || nonce.size() > 128) refuse("SIGNATURE_INVALID", "X-DSTNS-Nonce must be 8 to 128 characters");
    if (!same_secret(signature, hmac_sha256(app.signing_key, method + "\n" + target + "\n" + timestamp + "\n" + nonce + "\n" + sha256(body))))
        refuse("SIGNATURE_INVALID", "the signature does not match this request");
    // Checked last, so that a forgery cannot use up a nonce.
    for (auto seen = app.nonces.begin(); seen != app.nonces.end();) seen = seen->second < now - kSignatureWindowS * 2 ? app.nonces.erase(seen) : std::next(seen);
    if (!app.nonces.emplace(nonce, at).second) refuse("SIGNATURE_REPLAYED", "this nonce has been used");
}

std::string AppRegistry::sign_response(const std::string& id, int status, const std::string& method, const std::string& target, const std::string& timestamp, const std::string& nonce, const std::string& signature, const std::string& body, const std::string& digest) {
    std::lock_guard lock(mutex_);
    const auto found = apps_.find(id);
    if (found == apps_.end()) return {};
    const auto& key = found->second.signing_key;
    if (!same_secret(signature, hmac_sha256(key, method + "\n" + target + "\n" + timestamp + "\n" + nonce + "\n" + sha256(body)))) return {};
    return hmac_sha256(key, std::to_string(status) + "\n" + nonce + "\n" + digest);
}

bool AppRegistry::requires_signature(const std::string& id) {
    std::lock_guard lock(mutex_);
    const auto found = apps_.find(id);
    return found != apps_.end() && found->second.signatures_required;
}

json AppRegistry::rotate_credentials(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    const auto token = Seed128::secure().hex() + Seed128::secure().hex();
    app.token_hash = sha256(token);
    app.signing_key = Seed128::secure().hex() + Seed128::secure().hex();
    app.nonces.clear();
    push_event(app, "credentials.rotated", json::object());
    persist();
    return {{"token", token}, {"signing_key", app.signing_key}};
}

json AppRegistry::security() {
    std::lock_guard lock(mutex_);
    std::size_t signing = 0;
    for (const auto& [id, app] : apps_) signing += app.signatures_required ? 1 : 0;
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
    const bool tls_built = true;
#else
    const bool tls_built = false;
#endif
    const char* cert = std::getenv("DSTNS_TLS_CERT");
    return {{"transport", {{"tls", cert && *cert}, {"tls_available", tls_built}}},
            {"store", {{"sealed", true}, {"rejected", store_rejected_}, {"tokens", "hashed"}}},
            {"applications", {{"registered", apps_.size()}, {"requiring_signatures", signing}}},
            {"audit", {{"entries", audit_.size()}, {"head", audit_head_}}}};
}

json AppRegistry::propose_launch(const std::string& id, const json& spec, const std::string& proposed_by) {
    if (proposed_by == "application" && !switches().launch_proposals)
        throw Refusal(403, "LAUNCH_PROPOSALS_DISABLED", "the operator has turned launch proposals off on this server");
    const auto refuse = [](const std::string& message) { throw Refusal(400, "INVALID_LAUNCH", message); };
    if (!std::regex_match(id, kAppId) || id.size() < 3 || id.size() > 64) refuse("the ID must be 3 to 64 lower-case letters, digits, dots and hyphens");
    if (!spec.is_object() || !spec.contains("commands") || !spec.at("commands").is_array() || spec.at("commands").empty() || spec.at("commands").size() > kMaxLaunchCommands)
        refuse("commands must be an array of 1 to " + std::to_string(kMaxLaunchCommands) + " commands");
    for (const auto& command : spec.at("commands"))
        if (!command.is_string() || command.get<std::string>().empty() || command.get<std::string>().size() > kMaxCommandBytes) refuse("a command is text of up to " + std::to_string(kMaxCommandBytes) + " bytes");
    if (spec.dump().size() > 16 * 1024) refuse("the proposal is too large");
    std::lock_guard lock(mutex_);
    if (!launch_.contains(id) && launch_.size() >= kMaxProposals) throw Refusal(429, "TOO_MANY_PROPOSALS", "too many launch proposals are waiting");
    launch_[id] = {{"id", id}, {"spec", spec}, {"proposed_by", proposed_by}, {"at_ms", wall_ms()}};
    persist();
    return launch_[id];
}

void AppRegistry::withdraw_launch(const std::string& id) {
    std::lock_guard lock(mutex_);
    if (!launch_.erase(id)) throw Refusal(404, "PROPOSAL_NOT_FOUND", "no launch proposal for " + id);
    persist();
}

json AppRegistry::launch_proposals() {
    std::lock_guard lock(mutex_);
    auto items = json::array();
    for (const auto& [id, proposal] : launch_.items()) items.push_back(proposal);
    return {{"items", std::move(items)}};
}

// Moving the view and changing what it shows share one allowance: both are things a person sees happen.
void AppRegistry::spend_direction(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    const auto now = Clock::now();
    app.view_bucket = std::min(kViewBurst, app.view_bucket + std::chrono::duration<double>(now - app.view_bucket_at).count() * kViewPerSecond);
    app.view_bucket_at = now;
    if (app.view_bucket < 1) {
        ++app.rate_limited;
        throw Refusal(429, "RATE_LIMITED", "too many changes to the view; send fewer");
    }
    app.view_bucket -= 1;
}

json AppRegistry::request_view(const std::string& id, const json& request) {
    const auto wanted = check_view(request);
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    view_requests_.push_back({{"request", ++view_sequence_}, {"app", id}, {"name", app.manifest.value("name", id)}, {"view", wanted}, {"at_ms", wall_ms()}});
    while (view_requests_.size() > kMaxViewRequests) view_requests_.pop_front();
    return {{"request", view_sequence_}};
}

void AppRegistry::view_outcome(const std::string& id, std::uint64_t request, const std::string& outcome, const std::string& reason) {
    if (outcome != "applied" && outcome != "declined") throw Refusal(400, "INVALID_VIEW", "outcome must be applied or declined");
    std::lock_guard lock(mutex_);
    push_event(find(id), "view." + outcome, {{"request", request}, {"reason", sanitize_message(reason, 80)}});
}

json AppRegistry::set_presentation(const std::string& id, const json& request) {
    const auto refuse = [](const std::string& message) { throw Refusal(400, "INVALID_PRESENTATION", message); };
    if (!request.is_object()) refuse("a presentation must be an object");
    json held = {{"layers", json::object()}, {"places", json::object()}};
    for (const auto& [key, value] : request.items()) {
        if ((key != "layers" && key != "places") || !value.is_object()) refuse("a presentation has layers and places, each an object");
        if (key == "places" && value.size() > kMaxHeldPlaces) refuse("at most " + std::to_string(kMaxHeldPlaces) + " places");
        for (const auto& [name, on] : value.items()) {
            if (key == "layers" && !kLayers.count(name)) refuse("unknown layer: " + name);
            if (key == "places" && !std::regex_match(name, kKey)) refuse("unknown place kind: " + name);
            if (!on.is_boolean()) refuse(name + " must be true or false");
            held[key][name] = on;
        }
    }
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    app.presentation = held;
    app.presentation_at = ++presentation_revision_;
    return held;
}

void AppRegistry::clear_presentation(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    app.presentation = nullptr;
}

void AppRegistry::set_launch_key(const std::string& id, const std::string& key_hash) {
    static const std::regex kHash("[0-9a-f]{64}");
    if (!std::regex_match(id, kAppId) || !std::regex_match(key_hash, kHash)) throw Refusal(400, "INVALID_LAUNCH", "a launch key is an application ID and a SHA-256 hash");
    std::lock_guard lock(mutex_);
    launch_keys_[id] = key_hash;
    while (launch_keys_.size() > kMaxApps * 2) launch_keys_.erase(launch_keys_.begin());
}

json AppRegistry::reload(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    // The link ends now: nothing the old process holds works any more.
    app.token_hash = sha256(Seed128::secure().hex());
    app.signing_key = Seed128::secure().hex() + Seed128::secure().hex();
    app.nonces.clear();
    app.elements = json::array();
    app.event_queue.clear();
    app.timers.clear();
    app.topics.clear();
    app.stops.clear();
    app.presentation = nullptr;
    // Started by the launcher, it comes back with a key the launcher gives it, and keeps what a person granted.
    // Otherwise nobody can prove to be it, so it starts again as new, and asks again for anything a person gives.
    bool managed = false;
    if (launch_plan_.is_object() && launch_plan_.contains("apps") && launch_plan_.at("apps").is_array())
        for (const auto& entry : launch_plan_.at("apps"))
            managed = managed || (entry.is_object() && entry.value("id", std::string{}) == id);
    if (!managed)
        for (auto capability = app.granted.begin(); capability != app.granted.end();)
            capability = kExplicit.count(*capability) ? app.granted.erase(capability) : std::next(capability);
    app.state = managed ? "reloading" : "unloaded";
    app.detail = "Reloading.";
    reloads_.push_back({{"sequence", ++reload_sequence_}, {"app", id}, {"at_ms", wall_ms()}});
    while (reloads_.size() > 64) reloads_.pop_front();
    mark(app);
    persist();
    return {{"reloading", true}, {"managed", managed}, {"sequence", reload_sequence_}};
}

void AppRegistry::set_launch_plan(const json& plan) {
    std::lock_guard lock(mutex_);
    launch_plan_ = plan;
}

void AppRegistry::set_stops(const std::string& id, const json& nodes) {
    if (!nodes.is_array() || nodes.size() > 4096) throw Refusal(400, "INVALID_STOPS", "stops must be an array of up to 4096 node IDs");
    std::vector<std::uint32_t> stops;
    for (const auto& node : nodes) {
        // Above 32 bits it would wrap, and name some other junction.
        if (!node.is_number_unsigned() || node.get<std::uint64_t>() > 0xFFFFFFFFu) throw Refusal(400, "INVALID_STOPS", "a stop is a node ID");
        stops.push_back(node.get<std::uint32_t>());
    }
    std::lock_guard lock(mutex_);
    find(id).stops = std::move(stops);
}

std::vector<std::uint32_t> AppRegistry::stops(const std::string& id) {
    std::lock_guard lock(mutex_);
    return find(id).stops;
}

} // namespace dstns::fabric
