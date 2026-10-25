// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include "dstns/model.hpp"

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <nlohmann/json.hpp>

struct sqlite3;

namespace dstns {

/**
 * Narration: plain-language wording for news the core has already decided.
 *
 * The core composes its news as terse technical text ("Multi-vehicle
 * collision: lane blocked ... on Edge #412"). A narrator hands the facts of
 * such an item to a language model - Apple's on-device Foundation Model by
 * default - and keeps the sentence it writes. It is presentation only: the
 * model sees facts after the simulation has fixed them, its words are checked
 * against those facts before they are kept, and nothing it returns is ever read
 * back by the simulation. With no model available every item keeps the core's
 * own wording, exactly as before.
 */

/// The facts of one news item, as the model will see them.
struct NarrationRequest {
    std::string key;         // content hash: identical facts share one narration
    std::string template_id;
    std::string facts;       // "Label: value" lines, in a fixed order
    std::uint32_t due_s{};   // virtual second the item fires; earlier is narrated first
};

/**
 * Per-world lookups the fact builder needs: road names by junction and the
 * district grid. Built once when a world is installed, so a news item costs a
 * few table reads rather than a scan of the network.
 */
class NarrationContext {
public:
    explicit NarrationContext(const Scenario& scenario);
    [[nodiscard]] std::string road(std::uint32_t edge) const;      // "Uhuru Street" or "a residential street"
    [[nodiscard]] std::string road_near(std::uint32_t node) const; // nearest named road, or ""
    [[nodiscard]] std::string district(std::uint32_t node) const;  // "the north-east district"
    [[nodiscard]] std::string district_of_edge(std::uint32_t edge) const;
private:
    const Scenario& scenario_;
    std::vector<std::string> road_by_node_;
    double cx_{}, cy_{}, hx_{1}, hy_{1};
};

/// The request for a news item, or nothing when its template is not narrated.
[[nodiscard]] std::optional<NarrationRequest> narration_request(const NarrationContext& context, const std::string& template_id,
                                                                const std::string& message, const nlohmann::json& data,
                                                                std::uint32_t due_s);

/**
 * Check what the model wrote against the facts it was given.
 *
 * Returns the cleaned sentence, or nothing if it should not be shown: too long,
 * a list rather than prose, a number that is not among the facts, or words that
 * claim things the facts do not (injuries, causes, advice, speculation).
 */
[[nodiscard]] std::optional<std::string> accept_narration(const std::string& output, const std::string& facts);

/// The instructions every request carries.
[[nodiscard]] const std::string& narration_instructions();

/// Something that turns instructions and facts into text.
class NarrationBackend {
public:
    virtual ~NarrationBackend() = default;
    /// Whether the model can be reached; may start it. Called off the simulation thread.
    virtual bool ready() = 0;
    /// One completion, or nothing on failure. Called off the simulation thread.
    virtual std::optional<std::string> complete(const std::string& instructions, const std::string& facts) = 0;
    [[nodiscard]] virtual nlohmann::json describe() const = 0;
    /// Abandon in-flight work promptly; called once, before shutdown. Thread-safe.
    virtual void cancel() {}
};

/**
 * An OpenAI-style Chat Completions endpoint: `fm serve`, llama.cpp, Ollama,
 * vLLM and the like. `endpoint` is "http://host:port" or "unix:/path/to.sock".
 */
[[nodiscard]] std::unique_ptr<NarrationBackend> make_chat_backend(const std::string& endpoint, const std::string& model,
                                                                  std::chrono::milliseconds timeout = std::chrono::seconds(20));

/// Where the `fm` command is installed, if it is.
[[nodiscard]] std::optional<std::filesystem::path> find_fm();

/**
 * Apple's on-device Foundation Model, through `fm serve` on a private Unix
 * socket. The server is started on first use and stopped with the backend.
 */
[[nodiscard]] std::unique_ptr<NarrationBackend> make_fm_backend(const std::filesystem::path& fm);

struct NarratorOptions {
    std::filesystem::path cache_path;   // SQLite file; empty keeps the cache in memory only
    std::size_t memory_entries{4096};
    std::size_t queue_limit{256};
    unsigned workers{2};
};

class Narrator {
public:
    Narrator(std::unique_ptr<NarrationBackend> backend, NarratorOptions options = {});
    ~Narrator();
    Narrator(const Narrator&) = delete;
    Narrator& operator=(const Narrator&) = delete;

    /**
     * Ask for a narration. Never blocks on the model: a cached item returns at
     * once, anything else is queued. `live` items (news that has just fired)
     * go ahead of prefetched ones.
     */
    void request(const NarrationRequest& request, bool live);

    struct Narration { std::string text; std::uint64_t sequence{}; };
    /// The kept narration for a key. `sequence` orders completions in this process; 0 if loaded from disk.
    [[nodiscard]] std::optional<Narration> lookup(const std::string& key) const;
    /// Highest completion sequence so far.
    [[nodiscard]] std::uint64_t sequence() const;
    [[nodiscard]] nlohmann::json status() const;
    /// Wait until nothing is queued or in flight, or the timeout passes. For tests and benchmarks.
    bool wait_idle(std::chrono::milliseconds timeout) const;

private:
    void work();
    void remember(const NarrationRequest& request, const std::string& text);
    void open_cache();

    std::unique_ptr<NarrationBackend> backend_;
    NarratorOptions options_;
    mutable std::mutex mutex_;
    mutable std::condition_variable changed_;
    std::deque<NarrationRequest> live_;
    std::vector<NarrationRequest> prefetch_;     // kept sorted by due_s
    std::unordered_set<std::string> pending_;    // queued or in flight
    std::unordered_set<std::string> refused_;    // the model's text failed the checks; not retried
    struct Entry { std::string text; std::uint64_t sequence{}; };
    std::unordered_map<std::string, Entry> cache_;
    std::deque<std::string> cache_order_;
    std::uint64_t sequence_{};
    std::size_t in_flight_{};
    std::string state_{"starting"};
    std::string last_error_;
    std::chrono::steady_clock::time_point backoff_until_{};
    unsigned consecutive_failures_{};
    struct Counters { std::uint64_t requested{}, hits{}, completed{}, refused{}, failed{}, dropped{}; double total_ms{}, max_ms{}; } counters_;
    std::mutex db_mutex_;
    sqlite3* db_{};
    bool stopping_{};
    std::vector<std::thread> workers_;
};

} // namespace dstns
