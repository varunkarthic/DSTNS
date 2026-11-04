// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#include "dstns/daemon.hpp"
#include "dstns/daemon_catalogue.hpp"

#include <cmath>
#include <cstdio>
#include <regex>

namespace dstns::daemon {

namespace {
std::int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}
// Readers who have asked in the last minute are subscribed.
constexpr auto kSubscribed = std::chrono::seconds(60);
} // namespace

json Message::to_json() const {
    return {{"sequence", sequence}, {"id", id}, {"level", level}, {"queue", queue}, {"daemon", daemon}, {"title", title}, {"text", text},
            {"data", data}, {"time_ms", time_ms}, {"acknowledged_by", json(std::vector<std::string>(acknowledged.begin(), acknowledged.end()))}};
}

std::uint64_t Queue::push(Message message) {
    std::uint64_t sequence;
    {
        std::lock_guard lock(mutex_);
        sequence = message.sequence = next_++;
        message.queue = name_;
        items_.push_back(std::move(message));
        while (items_.size() > capacity_) items_.pop_front();
    }
    changed_.notify_all();
    return sequence;
}

json Queue::read(std::uint64_t since, std::size_t limit, double wait_s, const std::string& reader) {
    std::unique_lock lock(mutex_);
    if (!reader.empty()) readers_[reader] = std::chrono::steady_clock::now();
    const auto fresh = [&] { return closing_ || (!items_.empty() && items_.back().sequence > since); };
    if (wait_s > 0 && !fresh()) changed_.wait_for(lock, std::chrono::duration<double>(wait_s), fresh);
    json items = json::array();
    for (const auto& item : items_) {
        if (item.sequence <= since) continue;
        if (items.size() >= limit) break;
        items.push_back(item.to_json());
    }
    const std::uint64_t latest = items_.empty() ? next_ - 1 : items_.back().sequence;
    // A reader that fell behind the queue's memory is told what it missed.
    const std::uint64_t oldest = items_.empty() ? next_ : items_.front().sequence;
    return {{"queue", name_}, {"items", std::move(items)}, {"latest_sequence", latest}, {"missed", since + 1 < oldest ? oldest - since - 1 : 0}};
}

bool Queue::acknowledge(std::uint64_t sequence, const std::string& by) {
    std::lock_guard lock(mutex_);
    for (auto& item : items_) {
        if (item.sequence == sequence) {
            item.acknowledged.insert(by);
            return true;
        }
    }
    return false;
}

json Queue::summary() const {
    std::lock_guard lock(mutex_);
    const auto now = std::chrono::steady_clock::now();
    std::vector<std::string> subscribed;
    for (const auto& [reader, seen] : readers_)
        if (now - seen < kSubscribed) subscribed.push_back(reader);
    return {{"length", items_.size()}, {"latest_sequence", items_.empty() ? next_ - 1 : items_.back().sequence}, {"subscribers", subscribed}};
}

void Queue::wake() {
    {
        std::lock_guard lock(mutex_);
        closing_ = true;
    }
    changed_.notify_all();
}

Gateway::Gateway() : templates_(json::parse(kMessagesJson)) {}

std::string fill(const std::string& text, const json& data) {
    static const std::regex field(R"(\{([a-z_]+)\})");
    std::string out;
    auto begin = std::sregex_iterator(text.begin(), text.end(), field);
    std::size_t at = 0;
    for (auto it = begin; it != std::sregex_iterator(); ++it) {
        out += text.substr(at, static_cast<std::size_t>(it->position()) - at);
        const auto name = (*it)[1].str();
        if (data.contains(name)) {
            const auto& value = data.at(name);
            if (value.is_string()) out += value.get<std::string>();
            else if (value.is_number_float()) {
                // Readings read best rounded: whole numbers once they are large.
                const double v = value.get<double>();
                char buffer[32];
                std::snprintf(buffer, sizeof buffer, std::abs(v) >= 100 ? "%.0f" : "%.1f", v);
                out += buffer;
            } else out += value.dump();
        } else out += it->str();
        at = static_cast<std::size_t>(it->position() + it->length());
    }
    return out + text.substr(at);
}

std::uint64_t Gateway::publish(const std::string& id, const std::string& daemon, const json& data) {
    const auto& messages = templates_.at("messages");
    const auto found = messages.find(id);
    if (found == messages.end()) throw std::invalid_argument("no daemon message " + id);
    Message message;
    message.id = id;
    message.level = found->value("level", "info");
    message.daemon = daemon;
    message.title = fill(found->value("title", id), data);
    message.text = fill(found->value("text", ""), data);
    message.data = data;
    message.time_ms = now_ms();
    if (log_) log_(message.level == "info" ? "INFO" : message.level == "warning" ? "WARN" : "ERROR", message.title + ": " + message.text);
    // Alerts and emergencies are what everyone must hear at once; the rest is news.
    const bool urgent = message.level == "alert" || message.level == "emergency";
    return (urgent ? emergency_ : notification_).push(std::move(message));
}

void Gateway::close() {
    emergency_.wake();
    notification_.wake();
}

Sustained::Change Sustained::update(bool holds, double sustain_s, std::chrono::steady_clock::time_point now) {
    if (holds != holds_) {
        holds_ = holds;
        since_ = now;
    }
    const bool settled = std::chrono::duration<double>(now - since_).count() >= sustain_s;
    if (settled && holds_ != reported_) {
        reported_ = holds_;
        return reported_ ? Change::Began : Change::Ended;
    }
    return Change::None;
}

} // namespace dstns::daemon
