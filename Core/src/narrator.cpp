// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/narrator.hpp"
#include "dstns/demand.hpp"
#include "dstns/graph.hpp"
#include "dstns/platform.hpp"
#include "dstns/rng.hpp"

#include <httplib.h>
#include <sqlite3.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <set>
#include <sstream>

#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;

namespace dstns {
namespace {

constexpr const char* kPromptVersion = "realistic-news-v2";

std::string hhmm(std::uint32_t s) {
    char buffer[8];
    std::snprintf(buffer, sizeof(buffer), "%02u:%02u", (s / 3600) % 24, (s / 60) % 60);
    return buffer;
}

std::string percent(double v) { return std::to_string(static_cast<int>(std::lround(v * 100))) + "%"; }

const char* road_phrase(RoadClass c) {
    switch (c) {
    case RoadClass::Motorway: return "a motorway";
    case RoadClass::Primary: return "a main road";
    case RoadClass::Secondary: return "a secondary road";
    case RoadClass::Tertiary: return "a local road";
    case RoadClass::Residential: return "a residential street";
    case RoadClass::Service: return "a service road";
    }
    return "a road";
}

std::string incident_kind(const std::string& type) {
    if (type == "road_closure") return "road closure";
    if (type == "accident") return "collision";
    if (type == "congestion") return "congestion bottleneck";
    if (type == "vehicle_breakdown") return "vehicle breakdown";
    if (type == "hazard_spill") return "hazardous cargo spill";
    return "incident";
}

/// The incident text the core puts between the time prefix and " on Edge #".
std::string incident_situation(const std::string& message) {
    auto text = message;
    if (!text.empty() && text.front() == '[') {
        const auto close = text.find("] ");
        if (close != std::string::npos) text.erase(0, close + 2);
    }
    if (const auto at = text.find(" on Edge #"); at != std::string::npos) text.erase(at);
    return text;
}

template <class T>
std::optional<T> field(const nlohmann::json& data, const char* key) {
    if (!data.is_object() || !data.contains(key)) return std::nullopt;
    try { return data.at(key).get<T>(); } catch (...) { return std::nullopt; }
}

std::string lower(std::string s) {
    for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

} // namespace

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

namespace {

constexpr double kNearbyM = 350.0;  // how far a place can be and still be "nearby"

/// A place kind as a reporter would name it, or "" for kinds not worth naming.
const char* place_label(PlaceKind kind) {
    switch (kind) {
    case PlaceKind::School: return "school";
    case PlaceKind::University: return "university";
    case PlaceKind::Office: return "offices";
    case PlaceKind::Retail: return "shops";
    case PlaceKind::Mall: return "shopping centre";
    case PlaceKind::Hospital: return "hospital";
    case PlaceKind::Pharmacy: return "pharmacy";
    case PlaceKind::Food: return "restaurant";
    case PlaceKind::Transport: return "station";
    case PlaceKind::Park: return "park";
    case PlaceKind::Worship: return "place of worship";
    case PlaceKind::Culture: return "venue";
    case PlaceKind::Hotel: return "hotel";
    default: return "";
    }
}

/// The hour as a reporter would put it. `coarse` gives the hour alone, so that
/// repeated events on one road within the hour share one cached item.
std::string time_of_day(std::uint32_t s, bool weekend, bool coarse = false) {
    const double h = double(s % 86400) / 3600.0;
    std::string period;
    if (h < 5) period = "the middle of the night";
    else if (h < 7) period = "early morning";
    else if (h < 9.5) period = weekend ? "morning" : "the morning rush hour";
    else if (h < 12) period = "late morning";
    else if (h < 14) period = "lunchtime";
    else if (h < 16.5) period = "the afternoon";
    else if (h < 19) period = weekend ? "early evening" : "the evening rush hour";
    else if (h < 22) period = "the evening";
    else period = "late at night";
    return (coarse ? "around " + hhmm(s - s % 3600) : hhmm(s)) + ", " + period;
}

/// Places worth a news item when they are at their busiest.
bool newsworthy(PlaceKind kind) {
    return kind == PlaceKind::School || kind == PlaceKind::University || kind == PlaceKind::Hospital ||
           kind == PlaceKind::Mall || kind == PlaceKind::Transport;
}

/// Why a place is busy, from the label the core gives its demand windows.
std::string demand_reason(const std::string& label, const std::string& kind) {
    const auto l = lower(label);
    if (l.find("school") != std::string::npos) return "the school run (pupils arriving or leaving)";
    if (l.find("office") != std::string::npos) return "the office commute";
    if (l.find("retail") != std::string::npos) return "shoppers at the busiest time of day";
    if (l.find("hospital") != std::string::npos) return "visitors, patients and staff changeovers";
    if (!kind.empty()) return "people coming and going from the " + kind;
    return "more people than usual coming and going";
}

} // namespace

NarrationContext::NarrationContext(const Scenario& scenario) : scenario_(scenario) {
    road_by_node_.assign(scenario.nodes.size(), {});
    for (const auto& e : scenario.edges) {
        if (e.name.empty()) continue;
        if (e.from.value < road_by_node_.size() && road_by_node_[e.from.value].empty()) road_by_node_[e.from.value] = e.name;
        if (e.to.value < road_by_node_.size() && road_by_node_[e.to.value].empty()) road_by_node_[e.to.value] = e.name;
    }
    for (std::size_t i = 0; i < scenario.features.size(); ++i) {
        const auto& f = scenario.features[i];
        feature_by_id_.emplace(f.id, i);
        if (!f.name.empty() && *place_label(classify_place(f))) named_places_.push_back(i);
    }
    if (scenario.nodes.empty()) return;
    double min_x = scenario.nodes.front().position.x_m, max_x = min_x;
    double min_y = scenario.nodes.front().position.y_m, max_y = min_y;
    for (const auto& n : scenario.nodes) {
        min_x = std::min(min_x, n.position.x_m); max_x = std::max(max_x, n.position.x_m);
        min_y = std::min(min_y, n.position.y_m); max_y = std::max(max_y, n.position.y_m);
    }
    cx_ = (min_x + max_x) / 2; cy_ = (min_y + max_y) / 2;
    hx_ = std::max(1.0, (max_x - min_x) / 2); hy_ = std::max(1.0, (max_y - min_y) / 2);
}

std::string NarrationContext::road(std::uint32_t edge) const {
    if (edge >= scenario_.edges.size()) return "a road";
    const auto& e = scenario_.edges[edge];
    return e.name.empty() ? road_phrase(e.road_class) : e.name;
}

std::string NarrationContext::road_near(std::uint32_t node) const {
    return node < road_by_node_.size() ? road_by_node_[node] : std::string();
}

// The same compass the observer uses (notificationModel.districtOf), so the
// narration and the notification name the same place.
std::string NarrationContext::district(std::uint32_t node) const {
    if (node >= scenario_.nodes.size()) return "the network";
    const auto& p = scenario_.nodes[node].position;
    const double dx = (p.x_m - cx_) / hx_, dy = (p.y_m - cy_) / hy_;
    if (std::hypot(dx, dy) < 0.34) return "the central district";
    static constexpr const char* names[]{"east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"};
    const double angle = std::atan2(dy, dx) * 180.0 / 3.141592653589793;
    const int index = static_cast<int>(std::lround(std::fmod(angle + 360.0, 360.0) / 45.0)) % 8;
    return std::string("the ") + names[index] + " district";
}

std::string NarrationContext::district_of_edge(std::uint32_t edge) const {
    return edge < scenario_.edges.size() ? district(scenario_.edges[edge].from.value) : std::string("the network");
}

std::string NarrationContext::city() const {
    if (scenario_.map_city.empty()) return "";
    return scenario_.map_country.empty() ? scenario_.map_city : scenario_.map_city + ", " + scenario_.map_country;
}

std::string NarrationContext::day() const { return scenario_.config.day == 1 ? "the weekend" : "a weekday"; }

Point NarrationContext::node_position(std::uint32_t node) const {
    return node < scenario_.nodes.size() ? scenario_.nodes[node].position : Point{};
}

Point NarrationContext::edge_midpoint(std::uint32_t edge) const {
    if (edge >= scenario_.edges.size()) return {};
    const auto& a = node_position(scenario_.edges[edge].from.value);
    const auto& b = node_position(scenario_.edges[edge].to.value);
    return {(a.x_m + b.x_m) / 2, (a.y_m + b.y_m) / 2, (a.lat + b.lat) / 2, (a.lon + b.lon) / 2};
}

std::vector<std::string> NarrationContext::places_near(const Point& where, std::size_t limit) const {
    std::vector<std::pair<double, std::size_t>> near;
    for (const auto i : named_places_) {
        const double d = point_distance(where, scenario_.features[i].center);
        if (d <= kNearbyM) near.emplace_back(d, i);
    }
    std::sort(near.begin(), near.end());
    std::vector<std::string> out;
    for (const auto& [d, i] : near) {
        const auto& f = scenario_.features[i];
        auto text = f.name + " (" + place_label(classify_place(f)) + ")";
        if (std::find(out.begin(), out.end(), text) == out.end()) out.push_back(std::move(text));
        if (out.size() >= limit) break;
    }
    return out;
}

std::string NarrationContext::weather_at(const Point& where, std::uint32_t when) const {
    if (!scenario_.config.dws) return "";
    double strongest = 0;
    for (const auto& e : scenario_.dws_events) {
        const auto start = std::uint32_t(std::uint64_t(e.start_ppm) * 86400 / 1'000'000);
        const auto end = std::uint32_t(std::uint64_t(e.end_ppm) * 86400 / 1'000'000);
        if (when < start || when >= end || e.epicenter.value >= scenario_.nodes.size()) continue;
        if (point_distance(where, scenario_.nodes[e.epicenter.value].position) <= e.radius_m * 1.3)
            strongest = std::max(strongest, e.intensity);
    }
    if (strongest <= 0) return "";
    return strongest > 0.6 ? "heavy rain" : "light rain";
}

std::vector<std::string> NarrationContext::earlier_incidents(std::uint32_t edge, std::uint32_t when, std::size_t limit) const {
    if (!scenario_.config.incidents || edge >= scenario_.edges.size()) return {};
    const auto here_road = road(edge);
    const auto here_district = district_of_edge(edge);
    std::vector<std::pair<std::uint32_t, std::string>> found;
    for (const auto& inc : scenario_.incidents) {
        if (inc.start_virtual_s >= when || (inc.edge.value == edge && inc.start_virtual_s + 60 >= when)) continue;
        const auto there_road = road(inc.edge.value);
        const bool same_road = !scenario_.edges[inc.edge.value].name.empty() && there_road == here_road;
        if (!same_road && district_of_edge(inc.edge.value) != here_district) continue;
        found.emplace_back(inc.start_virtual_s, "a " + incident_kind(to_string(inc.type)) + " at " + hhmm(inc.start_virtual_s) +
                                                   (same_road ? " on this same road" : " on " + there_road + ", nearby"));
    }
    std::sort(found.begin(), found.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
    std::vector<std::string> out;
    for (auto& [t, text] : found) {
        out.push_back(std::move(text));
        if (out.size() >= limit) break;
    }
    return out;
}

const MapFeature* NarrationContext::feature(const std::string& id) const {
    const auto it = feature_by_id_.find(id);
    return it == feature_by_id_.end() ? nullptr : &scenario_.features[it->second];
}

const Incident* NarrationContext::incident(std::uint64_t id) const {
    for (const auto& inc : scenario_.incidents) if (inc.id == id) return &inc;
    return nullptr;
}

std::optional<NarrationRequest> narration_request(const NarrationContext& context, const std::string& template_id,
                                                  const std::string& message, const nlohmann::json& data,
                                                  std::uint32_t due_s) {
    // Most news (signals, system, demand winding down) is not narrated: answer
    // that before building anything, since this runs on the physics thread.
    static const std::set<std::string, std::less<>> narrated{
        "INCIDENT_ACTIVATED", "INCIDENT_RESOLVED", "DWS_RAIN_STARTED", "DWS_RAIN_PEAK", "DWS_RAIN_ENDED",
        "FLOOD_STARTED", "TRAFFIC_SURGE_ACTIVE", "DEMAND_CHANGED"};
    if (!narrated.contains(template_id)) return std::nullopt;
    // A place's demand rises and falls in eight steps; only its peak is news.
    if (template_id == "DEMAND_CHANGED" && message.find(" peak · ") == std::string::npos) return std::nullopt;

    std::ostringstream f;
    auto line = [&](const char* label, const std::string& value) { if (!value.empty()) f << label << ": " << value << '\n'; };
    auto list = [](const std::vector<std::string>& items) {
        std::string out;
        for (const auto& item : items) out += (out.empty() ? "" : "; ") + item;
        return out;
    };
    const bool weekend = context.day() == "the weekend";
    // Common to every item: where and when.
    auto setting = [&](const Point& where, bool coarse = false) {
        line("City", context.city());
        line("Day", context.day());
        line("Time", time_of_day(due_s, weekend, coarse));
        line("Weather", context.weather_at(where, due_s));
    };

    if (template_id == "INCIDENT_ACTIVATED" || template_id == "INCIDENT_RESOLVED") {
        const auto edge = field<std::uint32_t>(data, "edge_id");
        if (!edge) return std::nullopt;
        const auto kind = incident_kind(field<std::string>(data, "type").value_or(""));
        const auto where = context.edge_midpoint(*edge);
        if (template_id == "INCIDENT_ACTIVATED") {
            line("Event", "an incident has just happened");
            line("Kind", kind);
            line("Situation", incident_situation(message));
            line("Road", context.road(*edge));
            line("Area", context.district_of_edge(*edge));
            setting(where);
            line("Nearby", list(context.places_near(where)));
            line("Earlier today", list(context.earlier_incidents(*edge, due_s)));
            if (const auto closed = field<bool>(data, "closed")) line("Road closed", *closed ? "yes, fully" : "no, still open but slow");
            if (const auto speed = field<double>(data, "speed_multiplier"); speed && *speed > 0 && *speed < 1)
                line("Traffic speed", percent(*speed) + " of normal");
            if (const auto capacity = field<double>(data, "capacity_multiplier"); capacity && *capacity > 0 && *capacity < 1)
                line("Road capacity", percent(*capacity) + " of normal");
            if (const auto end = field<std::uint32_t>(data, "end_virtual_s")) line("Expected to clear", hhmm(*end));
            line("Angle", "the scene and its knock-on effect on traffic; crews or recovery vehicles fit this kind of incident");
        } else {
            line("Event", "an incident has cleared");
            line("Kind", kind);
            if (const auto id = field<std::uint64_t>(data, "incident_id"))
                if (const auto* earlier = context.incident(*id)) {
                    line("What happened", incident_situation(earlier->description));
                    line("Started at", hhmm(earlier->start_virtual_s));
                }
            line("Road", context.road(*edge));
            line("Area", context.district_of_edge(*edge));
            setting(where);
            line("Traffic", "flowing normally again");
            line("Angle", "the road is moving again; refer back to what happened, exactly as described");
        }
    } else if (template_id == "DWS_RAIN_STARTED" || template_id == "DWS_RAIN_PEAK" || template_id == "DWS_RAIN_ENDED") {
        const auto epicenter = field<std::uint32_t>(data, "epicenter");
        if (!epicenter) {
            // The core's "rain ended" item carries no data; the node is in its text.
            const auto at = message.find("at Node ");
            if (at == std::string::npos) return std::nullopt;
            const auto node = static_cast<std::uint32_t>(std::strtoul(message.c_str() + at + 8, nullptr, 10));
            return narration_request(context, template_id, message, nlohmann::json{{"epicenter", node}}, due_s);
        }
        const auto where = context.node_position(*epicenter);
        const auto intensity = field<double>(data, "intensity");
        const bool heavy = intensity && *intensity > 0.6;
        line("Event", template_id == "DWS_RAIN_STARTED" ? "rain has started"
                      : template_id == "DWS_RAIN_PEAK"  ? "rain has reached its heaviest"
                                                        : "rain has cleared");
        line("Area", context.district(*epicenter));
        line("Near", context.road_near(*epicenter));
        line("City", context.city());
        line("Day", context.day());
        line("Time", time_of_day(due_s, weekend));
        line("Nearby", list(context.places_near(where)));
        if (template_id != "DWS_RAIN_ENDED" && intensity) line("Intensity", heavy ? "heavy" : "light to moderate");
        if (const auto radius = field<double>(data, "radius_m")) line("Radius", std::to_string(static_cast<int>(*radius)) + " m");
        if (template_id == "DWS_RAIN_PEAK") line("Road surface", "wet, reduced grip");
        if (template_id == "DWS_RAIN_ENDED") line("Roads", "drying out, returning to normal");
        line("Angle", "the weather and driving conditions only; no crashes, breakdowns or crews");
    } else if (template_id == "FLOOD_STARTED") {
        const auto edge = field<std::uint32_t>(data, "edge_id");
        if (!edge) return std::nullopt;
        const auto where = context.edge_midpoint(*edge);
        line("Event", "standing water is building up on a road");
        line("Road", context.road(*edge));
        line("Area", context.district_of_edge(*edge));
        setting(where, true);
        line("Nearby", list(context.places_near(where)));
        line("Angle", "water on the road and how drivers are coping; no crashes, breakdowns or crews");
    } else if (template_id == "TRAFFIC_SURGE_ACTIVE") {
        const auto node = field<std::uint32_t>(data, "node_id");
        if (!node) return std::nullopt;
        const auto where = context.node_position(*node);
        line("Event", "a sudden surge in traffic");
        line("Area", context.district(*node));
        line("Near", context.road_near(*node));
        setting(where, true);
        line("Angle", "suddenly heavy traffic and what is drawing it; no crashes or breakdowns");
        line("Nearby", list(context.places_near(where)));
        if (const auto factor = field<double>(data, "factor"); factor && *factor > 1)
            line("Extra traffic", "+" + std::to_string(static_cast<int>(std::lround((*factor - 1) * 100))) + "%");
        if (const auto until = field<std::string>(data, "end_time")) line("Until", until->substr(0, 5));
    } else {  // DEMAND_CHANGED, at its peak
        const auto id = field<std::string>(data, "feature_id");
        const auto* place = id ? context.feature(*id) : nullptr;
        // A busy hour at a named school, hospital, mall or station is news;
        // the thousands of other peaks a city has in a day keep their Standard wording.
        if (!place || place->name.empty() || !newsworthy(classify_place(*place))) return std::nullopt;
        const std::string kind = place_label(classify_place(*place));
        const auto label = message.substr(0, message.find(" · "));
        line("Event", "traffic is at its busiest around a local place");
        line("Place", place->name + " (" + kind + ")");
        line("Why", demand_reason(label, kind));
        line("Road", context.road_near(place->anchor.value));
        line("Area", context.district(place->anchor.value));
        setting(place->center, true);
        line("Angle", "why it is busy and what that means for traffic nearby; no crashes, breakdowns or crews");
    }

    NarrationRequest request;
    request.template_id = template_id;
    request.facts = f.str();
    request.key = sha256(std::string(kPromptVersion) + "\n" + template_id + "\n" + request.facts);
    request.due_s = due_s;
    return request;
}

const std::string& narration_instructions() {
    static const std::string text =
        "You write one item for the local traffic and travel news in the city named in the facts, the way a radio "
        "traffic reporter would say it. Write one to three short sentences, under 60 words. "
        "Follow the Angle line: it says what the story is about. Add a little ordinary, plausible colour that fits "
        "it, mention the road and the area, and only add advice to drivers if it is natural. "
        "Never contradict the facts, never invent incidents the facts do not describe, never add numbers or "
        "times that are not in the facts, never mention deaths, and never name real people, companies or brands. "
        "Vary your wording. No headlines, lists, labels, quotation marks, hashtags or emoji.";
    return text;
}

std::optional<std::string> accept_narration(const std::string& output, const std::string& facts) {
    // Clean: one paragraph, no wrapping quotes or markdown emphasis.
    std::string text;
    text.reserve(output.size());
    for (char c : output) {
        if (c == '\n' || c == '\r' || c == '\t') c = ' ';
        if (c == '*' || c == '#' || c == '`') continue;
        if (c == ' ' && !text.empty() && text.back() == ' ') continue;
        text.push_back(c);
    }
    auto trim = [](std::string& s) {
        while (!s.empty() && (s.front() == ' ' || s.front() == '"' || s.front() == '\'')) s.erase(s.begin());
        while (!s.empty() && (s.back() == ' ' || s.back() == '"' || s.back() == '\'')) s.pop_back();
    };
    trim(text);
    if (text.size() < 20 || text.size() > 420) return std::nullopt;
    if (!std::isupper(static_cast<unsigned char>(text.front()))) return std::nullopt;
    if (text.back() != '.' && text.back() != '!') text.push_back('.');
    if (std::count_if(text.begin(), text.end(), [](char c) { return c == '.' || c == '!' || c == '?'; }) > 6) return std::nullopt;

    const auto facts_lower = lower(facts);
    const auto text_lower = lower(text);
    // A label echoed back means the model listed the facts instead of writing.
    for (const char* label : {"event:", "kind:", "situation:", "facts", "road:", "area:", "time:", "nearby:", "angle:"})
        if (text_lower.find(label) != std::string::npos) return std::nullopt;

    // Every number it writes must be one it was given: a wrong time or
    // percentage reads as a fact.
    std::set<std::string> given;
    for (std::size_t i = 0; i < facts.size();) {
        if (!std::isdigit(static_cast<unsigned char>(facts[i]))) { ++i; continue; }
        std::size_t j = i;
        while (j < facts.size() && std::isdigit(static_cast<unsigned char>(facts[j]))) ++j;
        given.insert(facts.substr(i, j - i));
        i = j;
    }
    for (std::size_t i = 0; i < text.size();) {
        if (!std::isdigit(static_cast<unsigned char>(text[i]))) { ++i; continue; }
        std::size_t j = i;
        while (j < text.size() && std::isdigit(static_cast<unsigned char>(text[j]))) ++j;
        if (!given.contains(text.substr(i, j - i))) return std::nullopt;
        i = j;
    }

    // No deaths, and no model talking about itself.
    static constexpr const char* stems[]{"dead", "death", "died", "dying", "kill", "fatal", "casualt", "corpse", "body bag",
                                         "assistant", "language model", "sorry"};
    std::vector<std::string> tokens;
    {
        std::string token;
        for (char c : text_lower) {
            if (std::isalpha(static_cast<unsigned char>(c))) token.push_back(c);
            else if (!token.empty()) { tokens.push_back(token); token.clear(); }
        }
        if (!token.empty()) tokens.push_back(token);
    }
    for (const char* stem : stems) {
        if (facts_lower.find(stem) != std::string::npos) continue;
        if (std::string_view(stem).find(' ') != std::string_view::npos) {
            if (text_lower.find(stem) != std::string::npos) return std::nullopt;
            continue;
        }
        for (const auto& t : tokens) if (t.rfind(stem, 0) == 0) return std::nullopt;
    }
    for (const auto& t : tokens) if (t == "i") return std::nullopt;
    return text;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

namespace {

class ChatCompletionsBackend final : public NarrationBackend {
public:
    ChatCompletionsBackend(std::string endpoint, std::string model, std::chrono::milliseconds timeout)
        : endpoint_(std::move(endpoint)), model_(std::move(model)), timeout_(timeout) {
        if (endpoint_.rfind("unix:", 0) == 0) {
            socket_ = endpoint_.substr(5);
        } else {
            auto rest = endpoint_;
            if (rest.rfind("http://", 0) == 0) rest.erase(0, 7);
            else if (rest.find("://") != std::string::npos)
                throw std::invalid_argument("narrator endpoint must be http://host:port or unix:/path (no TLS in the engine)");
            if (const auto slash = rest.find('/'); slash != std::string::npos) {
                prefix_ = rest.substr(slash);
                rest.erase(slash);
                while (!prefix_.empty() && prefix_.back() == '/') prefix_.pop_back();
                if (prefix_.size() >= 3 && prefix_.ends_with("/v1")) prefix_.resize(prefix_.size() - 3);
            }
            const auto colon = rest.rfind(':');
            host_ = colon == std::string::npos ? rest : rest.substr(0, colon);
            port_ = colon == std::string::npos ? 80 : std::stoi(rest.substr(colon + 1));
            if (host_.empty()) throw std::invalid_argument("narrator endpoint has no host");
        }
    }

    bool ready() override {
        auto client = connect(std::chrono::seconds(2));
        auto response = client->Get(prefix_ + "/v1/models");
        return response && response->status == 200;
    }

    std::optional<std::string> complete(const std::string& instructions, const std::string& facts) override {
        const nlohmann::json body{
            {"model", model_},
            {"stream", false},
            // Some variety: two items about similar events should not read alike.
            // The text is cached by its facts, so an event keeps its wording.
            {"temperature", 0.7},
            {"max_tokens", 220},
            {"messages", nlohmann::json::array({{{"role", "system"}, {"content", instructions}},
                                                {{"role", "user"}, {"content", facts}}})}};
        if (cancelled_) return std::nullopt;
        auto client = connect(timeout_);
        {
            std::lock_guard lock(active_mutex_);
            active_.push_back(client.get());
        }
        auto response = client->Post(prefix_ + "/v1/chat/completions", body.dump(), "application/json");
        {
            std::lock_guard lock(active_mutex_);
            active_.erase(std::find(active_.begin(), active_.end(), client.get()));
        }
        if (!response || response->status != 200) return std::nullopt;
        try {
            const auto reply = nlohmann::json::parse(response->body);
            const auto& content = reply.at("choices").at(0).at("message").at("content");
            if (!content.is_string()) return std::nullopt;
            return content.get<std::string>();
        } catch (...) {
            return std::nullopt;
        }
    }

    [[nodiscard]] nlohmann::json describe() const override {
        return {{"kind", "chat-completions"}, {"endpoint", endpoint_}, {"model", model_}};
    }

    void cancel() override {
        cancelled_ = true;
        std::lock_guard lock(active_mutex_);
        for (auto* client : active_) client->stop();
    }

private:
    std::unique_ptr<httplib::Client> connect(std::chrono::milliseconds timeout) const {
        std::unique_ptr<httplib::Client> client;
        if (!socket_.empty()) {
            client = std::make_unique<httplib::Client>(socket_, 80);
            client->set_address_family(AF_UNIX);
        } else {
            client = std::make_unique<httplib::Client>(host_, port_);
        }
        client->set_connection_timeout(std::chrono::seconds(2));
        client->set_read_timeout(timeout);
        client->set_write_timeout(std::chrono::seconds(5));
        return client;
    }

    std::string endpoint_, model_, socket_, host_, prefix_;
    int port_{80};
    std::chrono::milliseconds timeout_;
    std::atomic<bool> cancelled_{false};
    std::mutex active_mutex_;
    std::vector<httplib::Client*> active_;
};

/// A child process this backend started and therefore stops.
class ManagedProcess {
public:
    ~ManagedProcess() { stop(); }
    bool start(const std::vector<std::string>& argv) {
        stop();
        std::vector<char*> args;
        for (const auto& a : argv) args.push_back(const_cast<char*>(a.c_str()));
        args.push_back(nullptr);
        posix_spawn_file_actions_t actions;
        posix_spawn_file_actions_init(&actions);
        posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
        posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0);
        const int rc = posix_spawn(&pid_, args[0], &actions, nullptr, args.data(), environ);
        posix_spawn_file_actions_destroy(&actions);
        if (rc != 0) pid_ = 0;
        return pid_ != 0;
    }
    bool running() {
        if (!pid_) return false;
        int status = 0;
        if (waitpid(pid_, &status, WNOHANG) == pid_) { pid_ = 0; return false; }
        return true;
    }
    void stop() {
        if (!pid_) return;
        kill(pid_, SIGTERM);
        for (int i = 0; i < 40; ++i) {
            int status = 0;
            if (waitpid(pid_, &status, WNOHANG) == pid_) { pid_ = 0; return; }
            usleep(50'000);
        }
        kill(pid_, SIGKILL);
        int status = 0;
        waitpid(pid_, &status, 0);
        pid_ = 0;
    }
private:
    pid_t pid_{};
};

class FmBackend final : public NarrationBackend {
public:
    explicit FmBackend(std::filesystem::path fm)
        : fm_(std::move(fm)),
          // sun_path holds 104 bytes on macOS: keep the socket in the short
          // temporary directory, not beside a possibly long log directory.
          socket_(std::filesystem::temp_directory_path() / ("dstns-fm-" + std::to_string(getpid()) + ".sock")),
          chat_("unix:" + socket_.string(), "system", std::chrono::seconds(20)) {}
    ~FmBackend() override {
        process_.stop();
        std::error_code ignored;
        std::filesystem::remove(socket_, ignored);
    }

    bool ready() override {
        std::lock_guard lock(mutex_);
        if (cancelled_) return false;
        if (process_.running() && chat_.ready()) return true;
        const auto now = std::chrono::steady_clock::now();
        if (attempted_ && now - last_start_ < std::chrono::seconds(30)) return false;
        attempted_ = true;
        last_start_ = now;
        std::error_code ignored;
        std::filesystem::remove(socket_, ignored);
        // A watchdog shell owns the server: it stops fm when DSTNS exits by any
        // route, including a signal that skips our destructors, so a model
        // server is never left running behind a dead simulation. It watches
        // its own parent rather than probing the pid: an exited DSTNS that has
        // not been reaped yet is a zombie, which kill -0 still reports alive,
        // whereas its children are re-parented the moment it exits.
        static constexpr const char* watchdog =
            "p=$1; f=$2; s=$3; \"$f\" serve --socket \"$s\" & c=$!; "
            "trap 'kill $c 2>/dev/null; exit 0' TERM INT HUP; "
            "while [ \"$(ps -o ppid= -p $$ | tr -d ' ')\" = \"$p\" ] && kill -0 \"$c\" 2>/dev/null; do sleep 1 & wait $!; done; "
            "kill \"$c\" 2>/dev/null; wait \"$c\" 2>/dev/null";
        if (!process_.start({"/bin/sh", "-c", watchdog, "sh", std::to_string(getpid()), fm_.string(), socket_.string()})) return false;
        for (int i = 0; i < 100 && !cancelled_; ++i) {  // up to ten seconds for the model to load
            if (std::filesystem::exists(socket_) && chat_.ready()) return true;
            if (!process_.running()) return false;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        return false;
    }

    std::optional<std::string> complete(const std::string& instructions, const std::string& facts) override {
        return chat_.complete(instructions, facts);
    }

    void cancel() override {
        cancelled_ = true;
        chat_.cancel();
    }

    [[nodiscard]] nlohmann::json describe() const override {
        return {{"kind", "apple-foundation-models"}, {"endpoint", "unix:" + socket_.string()}, {"model", "system"},
                {"command", fm_.string() + " serve"}, {"on_device", true}};
    }

private:
    std::filesystem::path fm_, socket_;
    ChatCompletionsBackend chat_;
    ManagedProcess process_;
    std::mutex mutex_;
    std::atomic<bool> cancelled_{false};
    bool attempted_{};
    std::chrono::steady_clock::time_point last_start_{};
};

} // namespace

std::unique_ptr<NarrationBackend> make_chat_backend(const std::string& endpoint, const std::string& model,
                                                    std::chrono::milliseconds timeout) {
    return std::make_unique<ChatCompletionsBackend>(endpoint, model, timeout);
}

std::optional<std::filesystem::path> find_fm() {
#if defined(__APPLE__)
    if (const char* path = std::getenv("PATH")) {
        std::stringstream dirs(path);
        for (std::string dir; std::getline(dirs, dir, ':');) {
            if (dir.empty()) continue;
            const auto candidate = std::filesystem::path(dir) / "fm";
            if (access(candidate.c_str(), X_OK) == 0) return candidate;
        }
    }
    if (access("/usr/bin/fm", X_OK) == 0) return std::filesystem::path("/usr/bin/fm");
#endif
    return std::nullopt;
}

std::unique_ptr<NarrationBackend> make_fm_backend(const std::filesystem::path& fm) {
    return std::make_unique<FmBackend>(fm);
}

// ---------------------------------------------------------------------------
// Narrator
// ---------------------------------------------------------------------------

Narrator::Narrator(std::unique_ptr<NarrationBackend> backend, NarratorOptions options)
    : backend_(std::move(backend)), options_(std::move(options)) {
    if (!options_.cache_path.empty()) open_cache();
    if (!backend_) {
        state_ = "disabled";
        return;
    }
    for (unsigned i = 0; i < std::max(1u, options_.workers); ++i) workers_.emplace_back([this] { work(); });
}

Narrator::~Narrator() {
    {
        std::lock_guard lock(mutex_);
        stopping_ = true;
    }
    changed_.notify_all();
    if (backend_) backend_->cancel();
    for (auto& w : workers_) w.join();
    backend_.reset();  // stops a managed model server
    if (db_) sqlite3_close(db_);
}

void Narrator::open_cache() {
    std::error_code ignored;
    std::filesystem::create_directories(options_.cache_path.parent_path(), ignored);
    if (sqlite3_open_v2(options_.cache_path.c_str(), &db_, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr) != SQLITE_OK) {
        last_error_ = "cannot open narration cache " + options_.cache_path.string();
        if (db_) sqlite3_close(db_);
        db_ = nullptr;
        return;
    }
    sqlite3_exec(db_, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"
                      "CREATE TABLE IF NOT EXISTS narrations(key TEXT PRIMARY KEY, template_id TEXT, facts TEXT, text TEXT,"
                      " model TEXT, created_at INTEGER);", nullptr, nullptr, nullptr);
    sqlite3_stmt* s{};
    if (sqlite3_prepare_v2(db_, "SELECT key, text FROM narrations ORDER BY created_at DESC LIMIT ?", -1, &s, nullptr) != SQLITE_OK) return;
    sqlite3_bind_int64(s, 1, static_cast<sqlite3_int64>(options_.memory_entries));
    std::vector<std::pair<std::string, std::string>> rows;
    while (sqlite3_step(s) == SQLITE_ROW)
        rows.emplace_back(reinterpret_cast<const char*>(sqlite3_column_text(s, 0)), reinterpret_cast<const char*>(sqlite3_column_text(s, 1)));
    sqlite3_finalize(s);
    // Oldest first, so the eviction order matches age.
    for (auto it = rows.rbegin(); it != rows.rend(); ++it) {
        if (cache_.emplace(it->first, Entry{it->second, 0}).second) cache_order_.push_back(it->first);
    }
}

void Narrator::request(const NarrationRequest& r, bool live) {
    std::lock_guard lock(mutex_);
    ++counters_.requested;
    if (cache_.contains(r.key)) { ++counters_.hits; return; }
    if (!backend_ || pending_.contains(r.key) || refused_.contains(r.key)) return;
    if (live) {
        live_.push_back(r);
    } else {
        const auto at = std::upper_bound(prefetch_.begin(), prefetch_.end(), r.due_s,
                                         [](std::uint32_t due, const NarrationRequest& x) { return due < x.due_s; });
        prefetch_.insert(at, r);
    }
    pending_.insert(r.key);
    // Bounded: shed the furthest-off prefetch first, then the oldest live item.
    while (live_.size() + prefetch_.size() > options_.queue_limit) {
        if (!prefetch_.empty()) { pending_.erase(prefetch_.back().key); prefetch_.pop_back(); }
        else { pending_.erase(live_.front().key); live_.pop_front(); }
        ++counters_.dropped;
    }
    changed_.notify_one();
}

std::optional<Narrator::Narration> Narrator::lookup(const std::string& key) const {
    std::lock_guard lock(mutex_);
    const auto it = cache_.find(key);
    if (it == cache_.end()) return std::nullopt;
    return Narration{it->second.text, it->second.sequence};
}

std::uint64_t Narrator::sequence() const {
    std::lock_guard lock(mutex_);
    return sequence_;
}

bool Narrator::wait_idle(std::chrono::milliseconds timeout) const {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] { return (live_.empty() && prefetch_.empty() && !in_flight_) || stopping_ || !backend_; });
}

void Narrator::remember(const NarrationRequest& r, const std::string& text) {
    {
        std::lock_guard lock(mutex_);
        if (cache_.insert_or_assign(r.key, Entry{text, ++sequence_}).second) cache_order_.push_back(r.key);
        while (cache_.size() > options_.memory_entries && !cache_order_.empty()) {
            cache_.erase(cache_order_.front());
            cache_order_.pop_front();
        }
    }
    if (!db_) return;
    std::lock_guard lock(db_mutex_);
    sqlite3_stmt* s{};
    if (sqlite3_prepare_v2(db_, "INSERT OR REPLACE INTO narrations(key, template_id, facts, text, model, created_at) VALUES(?,?,?,?,?,?)",
                           -1, &s, nullptr) != SQLITE_OK) return;
    const auto model = backend_->describe().value("model", std::string());
    sqlite3_bind_text(s, 1, r.key.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(s, 2, r.template_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(s, 3, r.facts.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(s, 4, text.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(s, 5, model.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(s, 6, static_cast<sqlite3_int64>(std::time(nullptr)));
    sqlite3_step(s);
    sqlite3_finalize(s);
}

void Narrator::work() {
    set_thread_role(ThreadRole::Presentation);
    for (;;) {
        NarrationRequest next;
        {
            std::unique_lock lock(mutex_);
            changed_.wait(lock, [&] { return stopping_ || !live_.empty() || !prefetch_.empty(); });
            if (stopping_) return;
            const auto now = std::chrono::steady_clock::now();
            if (now < backoff_until_) {
                changed_.wait_until(lock, backoff_until_, [&] { return stopping_; });
                continue;
            }
            if (!live_.empty()) { next = std::move(live_.front()); live_.pop_front(); }
            else { next = std::move(prefetch_.front()); prefetch_.erase(prefetch_.begin()); }
            ++in_flight_;
        }

        const bool up = backend_->ready();
        const auto started = std::chrono::steady_clock::now();
        const auto output = up ? backend_->complete(narration_instructions(), next.facts) : std::nullopt;
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        const auto accepted = output ? accept_narration(*output, next.facts) : std::nullopt;
        if (accepted) remember(next, *accepted);

        std::lock_guard lock(mutex_);
        --in_flight_;
        pending_.erase(next.key);
        if (accepted) {
            ++counters_.completed;
            counters_.total_ms += ms;
            counters_.max_ms = std::max(counters_.max_ms, ms);
            consecutive_failures_ = 0;
            state_ = "ready";
        } else if (output) {
            ++counters_.refused;
            refused_.insert(next.key);
            consecutive_failures_ = 0;
            state_ = "ready";
        } else {
            ++counters_.failed;
            last_error_ = up ? "the model did not answer" : "the model is not reachable";
            // Three misses in a row: stop asking for a while rather than
            // queueing every news item behind a dead endpoint.
            if (++consecutive_failures_ >= 3) {
                backoff_until_ = std::chrono::steady_clock::now() + std::chrono::seconds(30);
                state_ = up ? "backoff" : "unavailable";
            }
        }
        changed_.notify_all();
    }
}

nlohmann::json Narrator::status() const {
    nlohmann::json backend = backend_ ? backend_->describe() : nlohmann::json(nullptr);
    std::lock_guard lock(mutex_);
    const auto answered = counters_.completed;
    return {
        {"enabled", backend_ != nullptr},
        {"state", state_},
        {"backend", backend},
        {"queue", live_.size() + prefetch_.size()},
        {"live_queue", live_.size()},
        {"prefetch_queue", prefetch_.size()},
        {"in_flight", in_flight_},
        {"requested", counters_.requested},
        {"cache_hits", counters_.hits},
        {"completed", counters_.completed},
        {"refused", counters_.refused},
        {"failed", counters_.failed},
        {"dropped", counters_.dropped},
        {"latency_ms", {{"mean", answered ? counters_.total_ms / double(answered) : 0.0}, {"max", counters_.max_ms}}},
        {"cache", {{"entries", cache_.size()}, {"capacity", options_.memory_entries},
                   {"persistent", db_ != nullptr}, {"path", options_.cache_path.string()}}},
        {"sequence", sequence_},
        {"last_error", last_error_},
        {"brand", "Realistic News"},
        {"role", "presentation only: narrations never feed back into the simulation, and the API serves them only on request"}
    };
}

} // namespace dstns
