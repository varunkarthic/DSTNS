// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "gate.hpp"

#include "dstns/rng.hpp"
#include "dstns/webfabric/registry.hpp"

#include <algorithm>
#include <fstream>
#include <set>

namespace dstns::fabric {
using json = nlohmann::json;

namespace {
// Who may follow whom. none -> pending when a gated start is held; pending is decided (accepted, rejected) or
// cancelled by the operator; any decided state goes back to none when its run ends or another start comes.
const std::set<std::pair<std::string, std::string>> kMoves = {
    {"none", "pending"},        {"pending", "accepted"},  {"pending", "rejected"},  {"pending", "cancelled"},
    {"accepted", "none"},       {"rejected", "none"},     {"cancelled", "none"},    {"accepted", "pending"},
    {"rejected", "pending"},    {"cancelled", "pending"},
};

bool unstable(const json& identity) {
    const auto channel = identity.value("channel", std::string("stable"));
    return channel == "alpha" || channel == "beta";
}

std::string iso(std::chrono::system_clock::time_point at) {
    const auto t = std::chrono::system_clock::to_time_t(at);
    char out[32];
    std::strftime(out, sizeof out, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&t));
    return out;
}
} // namespace

namespace gate {
bool allowed(const std::string& from, const std::string& to) { return kMoves.count({from, to}) > 0; }
} // namespace gate

EnginePolicy EngineConfig::policy(const std::string& id) const {
    const auto found = engines.find(id);
    return found == engines.end() ? EnginePolicy{} : found->second;
}

json EngineConfig::to_json() const {
    json list = json::object();
    for (const auto& [id, p] : engines) list[id] = {{"enabled", p.enabled}, {"acknowledgment", {{"ui", p.ui}, {"enforce", p.enforce}}}};
    return {{"schema_version", schema_version}, {"selected", selected}, {"default", default_engine}, {"auto_switch", auto_switch}, {"engines", list}, {"warnings", warnings}};
}

EngineConfig EngineConfig::parse(const json& file) {
    EngineConfig out;
    if (!file.is_object()) throw std::invalid_argument("engines.json must be an object");
    out.schema_version = file.value("schema_version", 1);
    if (out.schema_version != 1) throw std::invalid_argument("engines.json schema_version " + std::to_string(out.schema_version) + " is newer than this server reads (1)");
    out.selected = file.value("selected", out.selected);
    out.default_engine = file.value("default", out.default_engine);
    out.auto_switch = file.value("auto_switch", out.auto_switch);
    if (out.auto_switch != "offer" && out.auto_switch != "off") throw std::invalid_argument("auto_switch is offer or off");
    // Held in a local: items() over the temporary that value() returns would read a destroyed object.
    const auto listed = file.value("engines", json::object());
    if (!listed.is_object()) throw std::invalid_argument("engines must be an object");
    for (const auto& [id, entry] : listed.items()) {
        if (!entry.is_object()) throw std::invalid_argument("engines." + id + " must be an object");
        EnginePolicy p;
        p.enabled = entry.value("enabled", true);
        const auto ack = entry.value("acknowledgment", json::object());
        p.enforce = ack.value("enforce", true);
        p.ui = ack.value("ui", true);
        // Enforcement off takes the observer's acknowledgment with it: there is nothing left to acknowledge.
        if (!p.enforce && p.ui) {
            out.warnings.push_back("engines." + id + ": acknowledgment.ui is on but enforce is off; ui is treated as off");
            p.ui = false;
        }
        out.engines[id] = p;
    }
    // The default engine must be one that can run, or nothing could start without a choice.
    if (!out.policy(out.default_engine).enabled) throw std::invalid_argument("the default engine " + out.default_engine + " is disabled");
    return out;
}

EngineConfig EngineConfig::load(const std::filesystem::path& file) {
    std::ifstream in(file);
    if (!in) return {};
    try {
        return parse(json::parse(in));
    } catch (const std::exception& e) {
        EngineConfig out;
        out.warnings.push_back(file.string() + " was not used (" + e.what() + "); the defaults apply, with every acknowledgment enforced");
        return out;
    }
}

EngineGate::EngineGate(EngineConfig config, Notify notify) : config_(std::move(config)), notify_(std::move(notify)) {}

bool EngineGate::gated(const json& identity) const {
    return unstable(identity) && config_.policy(identity.value("id", std::string())).enforce;
}

void EngineGate::require_enabled(const std::string& engine) const {
    if (!config_.policy(engine).enabled)
        throw Refusal(403, "ENGINE_DISABLED", "The engine " + engine + " is installed but disabled; enable it in the launcher's settings (Simulation, Engine) first.");
}

void EngineGate::move(const std::string& to) {
    if (!gate::allowed(state_, to)) throw Refusal(409, "APPROVAL_STATE", "The approval cannot go from " + state_ + " to " + to + ".");
    state_ = to;
    ++revision_;
    changed_.notify_all();
}

json EngineGate::hold(const json& request, const json& identity, const std::string& idempotency_key) {
    json event;
    json answer;
    {
        std::lock_guard lock(mutex_);
        if (state_ == "pending") {
            if (!idempotency_key.empty() && idempotency_key == key_) return deferred_locked(idempotency_key);
            throw Refusal(409, "APPROVAL_PENDING", "A start on " + identity_.value("id", std::string()) + " is waiting for acknowledgment (" + id_ + "). Decide it in the observer, or stop it first.");
        }
        if (state_ != "none") move("none");
        id_ = Seed128::secure().hex().substr(2, 16);
        key_ = idempotency_key;
        request_ = request;
        identity_ = identity;
        decision_.clear();
        then_.clear();
        reason_.clear();
        outcome_ = nullptr;
        since_ = std::chrono::system_clock::now();
        move("pending");
        answer = {{"state", "approval_required"},
                  {"deferred", true},
                  {"approval_id", id_},
                  {"engine", identity_},
                  {"acknowledge_in", config_.policy(identity_.value("id", std::string())).ui ? "observer" : "launcher"},
                  {"wait", "/api/v1/engine/approval/wait?since=" + std::to_string(revision_)}};
        event = {{"type", "engine.approval"}, {"state", state_}, {"approval_id", id_}, {"revision", revision_}};
    }
    if (notify_) notify_(event);
    return answer;
}

json EngineGate::alternatives(const json& catalogue, const std::string& rejected) const {
    auto out = json::array();
    if (config_.auto_switch == "off") return out;
    // Only real, stable, enabled engines: never a pseudo-engine, never another unstable one.
    for (const auto& engine : catalogue) {
        const auto id = engine.value("id", std::string());
        if (id == rejected || engine.value("kind", std::string()) != "real" || engine.value("channel", std::string()) != "stable" || !config_.policy(id).enabled) continue;
        out.push_back(engine);
    }
    return out;
}

EngineGate::Decision EngineGate::decide(const std::string& id, const std::string& decision, const std::string& then, const std::string& engine, const json& catalogue) {
    Decision out;
    json event;
    {
        std::lock_guard lock(mutex_);
        if (id.empty() || id != id_) throw Refusal(404, "APPROVAL_NOT_FOUND", "No start is waiting under that approval ID.");
        if (decision != "accept" && decision != "reject") throw Refusal(400, "BAD_DECISION", "decision is accept or reject");
        if (state_ != "pending") {
            // The same answer twice is the same answer; a different one is too late.
            if (decision_ == decision && then_ == then) {
                out.answer = state_locked(catalogue);
                return out;
            }
            throw Refusal(409, "APPROVAL_DECIDED", "That start was already " + state_ + ".");
        }
        if (decision == "accept") {
            decision_ = decision;
            then_.clear();
            move("accepted");
            out.run = request_;
        } else {
            if (then != "" && then != "terminate" && then != "regenerate") throw Refusal(400, "BAD_DECISION", "then is terminate or regenerate");
            if (then == "regenerate") {
                const auto offered = alternatives(catalogue, identity_.value("id", std::string()));
                const auto chosen = std::find_if(offered.begin(), offered.end(), [&](const json& e) { return e.value("id", std::string()) == engine; });
                if (chosen == offered.end()) throw Refusal(400, "ENGINE_NOT_OFFERED", "Regenerate on one of the enabled stable engines offered: " + offered.dump());
                // Only the seed goes over. The world, its map selection and anything prepared for it do not:
                // another engine may make another world from the same seed.
                json fresh = request_;
                fresh["engine"] = engine;
                fresh.erase("map_selection");
                fresh["map_selection_version"] = "urban-crfg-v3";
                out.run = fresh;
            }
            decision_ = decision;
            then_ = then;
            move("rejected");
        }
        out.answer = state_locked(catalogue);
        event = {{"type", "engine.approval"}, {"state", state_}, {"approval_id", id_}, {"then", then_}, {"revision", revision_}};
    }
    if (notify_) notify_(event);
    return out;
}

void EngineGate::cancel(const std::string& why) {
    json event;
    {
        std::lock_guard lock(mutex_);
        if (state_ != "pending") return;
        reason_ = why;
        move("cancelled");
        event = {{"type", "engine.approval"}, {"state", state_}, {"approval_id", id_}, {"reason", why}, {"revision", revision_}};
    }
    if (notify_) notify_(event);
}

void EngineGate::run_ended() {
    std::lock_guard lock(mutex_);
    // A cancellation stays visible until the next start, which clears it.
    if (state_ == "accepted" || state_ == "rejected") move("none");
}

bool EngineGate::pending() const {
    std::lock_guard lock(mutex_);
    return state_ == "pending";
}

json EngineGate::state_locked(const json& catalogue) const {
    json out = {{"state", state_}, {"revision", revision_}};
    if (state_ == "none") return out;
    const auto engine = identity_.value("id", std::string());
    const auto policy = config_.policy(engine);
    out["approval"] = {{"id", id_}, {"engine", identity_}, {"seed", request_.value("seed", json(nullptr))}, {"requested_at", iso(since_)},
                       {"acknowledge_in", policy.ui ? "observer" : "launcher"}, {"decision", decision_}, {"then", then_}, {"reason", reason_}};
    if (state_ == "pending" || state_ == "rejected") out["alternatives"] = alternatives(catalogue, engine);
    return out;
}

json EngineGate::state(const json& catalogue) const {
    std::lock_guard lock(mutex_);
    return state_locked(catalogue);
}

json EngineGate::wait(std::uint64_t since, std::chrono::milliseconds timeout, const json& catalogue) {
    std::unique_lock lock(mutex_);
    changed_.wait_for(lock, timeout, [&] { return revision_ > since; });
    return state_locked(catalogue);
}

json EngineGate::deferred(const std::string& request_id) const {
    std::lock_guard lock(mutex_);
    return deferred_locked(request_id);
}

json EngineGate::deferred_locked(const std::string& request_id) const {
    return {{"state", "approval_required"},
            {"deferred", true},
            {"approval_id", id_},
            {"engine", identity_},
            {"request_id", request_id},
            {"retry", "Nothing was done. Retry once GET /api/v1/engine/approval says accepted; GET /api/v1/engine/approval/wait?since=" + std::to_string(revision_) + " returns when it changes."}};
}

} // namespace dstns::fabric
