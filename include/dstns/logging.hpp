// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include <filesystem>
#include <mutex>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

struct sqlite3;

namespace dstns {

class RuntimeLogger {
public:
    explicit RuntimeLogger(const std::filesystem::path& directory);
    ~RuntimeLogger();
    RuntimeLogger(const RuntimeLogger&)=delete;
    RuntimeLogger& operator=(const RuntimeLogger&)=delete;
    void system(std::string level,std::string component,std::string message);
    void lifecycle(std::string run_id,std::string from,std::string to,std::uint64_t revision);
    void event(std::string run_id,std::uint64_t event_id,std::string type,std::string status,std::uint32_t virtual_s,std::string payload);
    void api(std::string method,std::string path,int status,std::uint64_t latency_us);
    [[nodiscard]] std::vector<std::string> system_tail(std::size_t limit) const;
    [[nodiscard]] nlohmann::json rows(const std::string& table,std::size_t limit,std::size_t offset=0) const;
    [[nodiscard]] std::string database_path() const { return db_path_; }
    [[nodiscard]] std::filesystem::path log_directory() const { return system_path_.parent_path(); }
    void write_file(const std::string& filename, const std::string& content);
private:
    void exec(const char* sql);
    mutable std::mutex mutex_; sqlite3* db_{}; std::filesystem::path system_path_; std::string db_path_;
};

} // namespace dstns
