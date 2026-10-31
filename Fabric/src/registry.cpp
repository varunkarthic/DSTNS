// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/fabric/registry.hpp"

#include "dstns/rng.hpp"
#include "dstns/utf8.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <regex>

namespace dstns::fabric {
namespace {
using json = nlohmann::json;

// Bounds, so one application cannot exhaust the server or the page. Nothing is
// silently discarded at these limits: a request over one is refused with a code.
constexpr std::size_t kMaxApps = 64, kMaxElements = 64, kMaxUiBytes = 512 * 1024, kMaxEventQueue = 1000,
                      kMaxNotifications = 1000, kMaxAudit = 2000, kMaxFields = 128, kMaxPage = 200;
constexpr double kNotificationBurst = 40, kNotificationsPerSecond = 20;
constexpr int kManifestVersion = 1, kApiMajor = 1;

// Requested and granted without asking: they only add to the application's own
// surfaces. Everything else interrupts the viewer, runs the application's own
// code in the page, or changes the simulation, so a person grants it.
const std::set<std::string> kAutomatic = {"ui.header", "ui.status", "ui.panels", "ui.notifications", "ui.overlays",
                                          "ui.map-controls", "ui.indicators", "settings", "sim.read"};
const std::set<std::string> kExplicit = {"ui.dialogs", "ui.frames", "control.playback", "control.events", "control.world"};
const std::map<std::string, std::string> kSlotCapability = {
    {"header", "ui.header"}, {"status", "ui.status"}, {"panel", "ui.panels"}, {"overlay", "ui.overlays"},
    {"map_control", "ui.map-controls"}, {"indicator", "ui.indicators"}, {"dialog", "ui.dialogs"}};
const std::set<std::string> kTones = {"neutral", "accent", "ok", "warn", "danger"};
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
    return manifest;
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

AppRegistry::AppRegistry(std::filesystem::path store) : store_(std::move(store)) {
    std::ifstream in(store_);
    if (!in) return;
    // A damaged store must not stop the simulator: applications register again.
    try {
        const auto saved = json::parse(in);
        for (const auto& [id, record] : saved.at("apps").items()) {
            App app;
            app.id = id;
            app.token = record.at("token");
            app.state = "unloaded";
            app.manifest = record.at("manifest");
            app.granted = record.at("granted").get<std::set<std::string>>();
            app.values = record.at("values");
            app.settings_version = record.at("settings_version");
            app.user_suspended = record.value("user_suspended", false);
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
        apps[id] = {{"token", app.token}, {"manifest", app.manifest}, {"granted", app.granted}, {"values", app.values},
                    {"settings_version", app.settings_version}, {"user_suspended", app.user_suspended}};
    // Written beside the target and renamed, so a crash leaves the old file whole.
    const auto temporary = store_.string() + ".tmp";
    {
        std::ofstream out(temporary, std::ios::trunc);
        if (!out) return;  // Settings still apply for this run.
        out << dump_json(json{{"version", 1}, {"apps", std::move(apps)}});
        if (!out) return;
    }
    std::error_code ignored;
    // It holds application tokens, so it is as private as operator.token.
    std::filesystem::permissions(temporary, std::filesystem::perms::owner_read | std::filesystem::perms::owner_write, ignored);
    std::filesystem::rename(temporary, store_, ignored);
}

AppRegistry::App& AppRegistry::find(const std::string& id) {
    const auto found = apps_.find(id);
    if (found == apps_.end()) throw Refusal(404, "APP_NOT_FOUND", "no registered application has the ID " + id);
    return found->second;
}

void AppRegistry::touch(App& app) {
    app.last_seen = Clock::now();
    if (app.lease_lapsed) {
        app.lease_lapsed = false;
        app.state = app.user_suspended ? "suspended" : "active";
        app.detail.clear();
        changed();
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
            changed();
        } else if (silent > app.lease_s && !app.lease_lapsed) {
            app.lease_lapsed = true;
            app.state = "suspended";
            app.detail = "The application has not checked in.";
            changed();
        }
    }
}

json AppRegistry::register_app(const json& raw, const std::string& presented) {
    const auto manifest = validate_manifest(raw);
    const auto id = manifest.at("id").get<std::string>();
    std::lock_guard lock(mutex_);
    sweep();
    const auto existing = apps_.find(id);
    bool returning = false;
    if (existing != apps_.end()) {
        auto& previous = existing->second;
        const bool owner = !presented.empty() && presented == previous.token;
        if (!owner) {
            if (previous.state != "unloaded")
                throw Refusal(409, "APP_ID_CONFLICT", "an application with the ID " + id + " is already registered; present its token to update it");
            for (const auto& capability : previous.granted)
                if (kExplicit.count(capability))
                    throw Refusal(409, "APP_ID_CONFLICT", "the ID " + id + " holds granted permissions; present its token, or forget it in Settings");
        }
        returning = true;
    } else if (apps_.size() >= kMaxApps) {
        throw Refusal(429, "APP_LIMIT_REACHED", "this server holds its maximum of " + std::to_string(kMaxApps) + " applications");
    }

    // Built aside and installed only once valid, so a refused update leaves the
    // application exactly as it was.
    App app = returning ? existing->second : App{};
    app.id = id;
    if (app.token.empty() || presented != app.token) app.token = Seed128::secure().hex() + Seed128::secure().hex();
    const auto requested = manifest.value("capabilities", std::vector<std::string>{});
    std::set<std::string> kept;
    for (const auto& capability : requested) {
        if (kAutomatic.count(capability) || (returning && app.granted.count(capability))) kept.insert(capability);
    }
    app.granted = std::move(kept);
    app.manifest = manifest;
    app.lease_s = manifest.value("lease_s", 60.0);
    app.elements = json::array();
    app.state = app.user_suspended ? "suspended" : "registered";
    app.detail.clear();
    app.lease_lapsed = false;
    app.last_seen = app.bucket_at = Clock::now();
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
    const auto& installed = apps_[id] = std::move(app);
    changed();
    persist();
    return {{"app", public_view(installed, true)}, {"token", installed.token}};
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

void AppRegistry::check_element(const App& app, const json& element) const {
    if (!element.is_object()) throw Refusal(400, "INVALID_ELEMENT", "a UI element must be an object");
    const auto id = element.value("id", json(nullptr));
    if (!id.is_string() || !std::regex_match(id.get<std::string>(), kKey)) throw Refusal(400, "INVALID_ELEMENT", "a UI element needs an id matching [a-z0-9][a-z0-9_-]*");
    const auto slot = element.value("slot", std::string{});
    const auto capability = kSlotCapability.find(slot);
    if (capability == kSlotCapability.end()) throw Refusal(400, "INVALID_ELEMENT", "unknown UI slot: " + slot);
    if (element.contains("tone") && (!element.at("tone").is_string() || !kTones.count(element.at("tone").get<std::string>())))
        throw Refusal(400, "INVALID_ELEMENT", "tone must be neutral, accent, ok, warn or danger; applications do not choose colours");
    // A declared URL is only ever loaded into a sandboxed frame, and only over http(s).
    if (element.contains("frame")) {
        const auto url = element.at("frame").is_string() ? element.at("frame").get<std::string>() : std::string{};
        if (slot != "panel" || !(url.starts_with("http://") || url.starts_with("https://")) || url.size() > 2000)
            throw Refusal(400, "INVALID_ELEMENT", "frame must be an http or https URL on a panel");
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
    // Same length and every byte compared, so timing says nothing about a guess.
    unsigned difference = app.token.size() == token.size() ? 0 : 1;
    for (std::size_t i = 0; i < std::min(app.token.size(), token.size()); ++i) difference |= static_cast<unsigned>(app.token[i] ^ token[i]);
    if (difference || token.empty()) throw Refusal(401, "APP_TOKEN_INVALID", "this request needs the application's bearer token");
    touch(app);
}

void AppRegistry::require_capability(const std::string& id, const std::string& capability) {
    std::lock_guard lock(mutex_);
    const auto& app = find(id);
    if (!app.granted.count(capability)) throw Refusal(403, "CAPABILITY_NOT_GRANTED", "this application has not been granted " + capability);
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
                 {"settings", app.manifest.value("settings", json(nullptr))}};
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

json AppRegistry::state(std::uint64_t since, std::uint64_t notifications_since) {
    std::lock_guard lock(mutex_);
    sweep();
    auto recent = json::array();
    for (const auto& item : notifications_) {
        if (item.at("sequence").get<std::uint64_t>() <= notifications_since) continue;
        recent.push_back(item);
        if (recent.size() >= kMaxPage) break;
    }
    json out = {{"revision", revision_}, {"notification_sequence", notification_sequence_}, {"notifications", std::move(recent)}};
    if (since == revision_) {
        out["unchanged"] = true;
        return out;
    }
    auto apps = json::array();
    for (const auto& [id, app] : apps_) apps.push_back(public_view(app, true));
    std::sort(apps.begin(), apps.end(), [](const json& a, const json& b) { return a.at("order") < b.at("order"); });
    out["unchanged"] = false;
    out["apps"] = std::move(apps);
    return out;
}

void AppRegistry::remove(const std::string& id, bool forget) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (forget) {
        apps_.erase(id);
    } else {
        app.state = "unloaded";
        app.detail = "The application unregistered itself.";
        app.elements = json::array();
        app.lease_lapsed = false;
    }
    changed();
    persist();
}

void AppRegistry::heartbeat(const std::string& id) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (app.state == "unloaded") throw Refusal(409, "APP_NOT_ACTIVE", "this application was unloaded; register again");
    touch(app);
    if (app.state == "registered" || app.state == "initialized") {
        app.state = "active";
        changed();
    }
}

void AppRegistry::set_state(const std::string& id, const std::string& state, const std::string& detail) {
    if (!kReportedStates.count(state)) throw std::invalid_argument("state must be initialized, active or failed");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (app.user_suspended) throw Refusal(409, "APP_SUSPENDED", "the viewer has suspended this application");
    app.state = state;
    app.detail = detail.substr(0, 280);
    changed();
}

void AppRegistry::suspend(const std::string& id, bool suspended) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (app.state == "unloaded") throw Refusal(409, "APP_NOT_ACTIVE", "this application is no longer running");
    app.user_suspended = suspended;
    app.state = suspended ? "suspended" : "active";
    app.detail = suspended ? "Suspended from Settings." : "";
    push_event(app, suspended ? "app.suspended" : "app.resumed", json::object());
    changed();
    persist();
}

void AppRegistry::report_failure(const std::string& id, const std::string& detail) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    if (app.state == "unloaded" || app.user_suspended) return;
    app.state = "failed";
    app.detail = detail.substr(0, 280);
    push_event(app, "app.failed", {{"detail", app.detail}});
    changed();
}

void AppRegistry::set_ui(const std::string& id, const json& elements) {
    if (!elements.is_array()) throw Refusal(400, "INVALID_ELEMENT", "the UI must be an array of elements");
    if (elements.size() > kMaxElements) throw Refusal(413, "UI_TOO_LARGE", "at most " + std::to_string(kMaxElements) + " elements");
    if (ui_bytes(elements) > kMaxUiBytes) throw Refusal(413, "UI_TOO_LARGE", "the declared UI is too large");
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    std::set<std::string> ids;
    for (const auto& element : elements) {
        check_element(app, element);
        if (!ids.insert(element.at("id").get<std::string>()).second) throw Refusal(400, "INVALID_ELEMENT", "element IDs must be unique");
    }
    app.elements = elements;
    changed();
}

void AppRegistry::upsert_element(const std::string& id, const std::string& element, const json& value) {
    if (!value.is_object()) throw Refusal(400, "INVALID_ELEMENT", "a UI element must be an object");
    auto copy = value;
    copy["id"] = element;
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    check_element(app, copy);
    auto next = app.elements;
    const auto existing = std::find_if(next.begin(), next.end(), [&](const json& item) { return item.at("id") == element; });
    if (existing != next.end()) *existing = copy;
    else next.push_back(copy);
    if (next.size() > kMaxElements) throw Refusal(413, "UI_TOO_LARGE", "at most " + std::to_string(kMaxElements) + " elements");
    if (ui_bytes(next) > kMaxUiBytes) throw Refusal(413, "UI_TOO_LARGE", "the declared UI is too large");
    app.elements = std::move(next);
    changed();
}

void AppRegistry::remove_element(const std::string& id, const std::string& element) {
    std::lock_guard lock(mutex_);
    auto& app = find(id);
    auto& items = app.elements;
    const auto existing = std::find_if(items.begin(), items.end(), [&](const json& item) { return item.at("id") == element; });
    if (existing == items.end()) throw Refusal(404, "ELEMENT_NOT_FOUND", "no such element: " + element);
    items.erase(existing);
    changed();
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
    if (app.bucket < 1) throw Refusal(429, "RATE_LIMITED", "too many notifications; send fewer, or update a status element instead");
    app.bucket -= 1;
    notifications_.push_back({{"sequence", ++notification_sequence_}, {"app_id", id}, {"app_name", app.manifest.value("name", id)},
                              {"severity", severity}, {"title", title}, {"body", body}, {"at_ms", wall_ms()}});
    while (notifications_.size() > kMaxNotifications) notifications_.pop_front();
    return notification_sequence_;
}

void AppRegistry::push_event(App& app, const std::string& type, const json& data) {
    app.event_queue.push_back({{"sequence", ++app.event_sequence}, {"type", type}, {"data", data}, {"at_ms", wall_ms()}});
    while (app.event_queue.size() > kMaxEventQueue) app.event_queue.pop_front();
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
    changed();
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
    changed();
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
        granted.insert(name);
    }
    app.granted = std::move(granted);
    push_event(app, "capabilities.changed", {{"granted", app.granted}});
    changed();
    persist();
    return public_view(app, false);
}

void AppRegistry::audit(const std::string& id, const std::string& action, const json& params,
                        const std::string& run_id, double virtual_s, const std::string& outcome) {
    std::lock_guard lock(mutex_);
    audit_.push_back({{"sequence", ++audit_sequence_}, {"app_id", id}, {"action", action}, {"params", params}, {"run_id", run_id},
                      {"virtual_s", virtual_s}, {"outcome", outcome}, {"at_ms", wall_ms()}});
    while (audit_.size() > kMaxAudit) audit_.pop_front();
}

json AppRegistry::audit_log(std::size_t limit) {
    std::lock_guard lock(mutex_);
    auto items = json::array();
    const auto count = std::min(limit, audit_.size());
    for (auto entry = audit_.end() - static_cast<std::ptrdiff_t>(count); entry != audit_.end(); ++entry) items.push_back(*entry);
    return items;
}

} // namespace dstns::fabric
