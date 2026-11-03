// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// What the HTTP tests share: a real server in a directory of its own, requests to it, programs run and watched, and a
// stand-in for an upstream service. Each test is a program of its own, which ctest runs as dstns_http_<name>; it
// prints what passed and exits 0, or says what failed, where, and with what reply, and exits 1.
#pragma once

#include "dstns/rng.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <exception>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

extern char** environ;

namespace check {

using json = nlohmann::json;
namespace fs = std::filesystem;
using Headers = std::map<std::string, std::string>;
using Env = std::vector<std::pair<std::string, std::string>>;
inline constexpr std::nullopt_t none = std::nullopt;

// ---------------------------------------------------------------------------------------------------- Failing clearly

struct Reply;
inline std::string show(const json& value) { return value.dump(); }
inline std::string show(const std::string& value) { return value; }
inline std::string show(const char* value) { return value; }
inline std::string show(const Reply& reply);
template <class T> std::string show(const T& value) {
    std::ostringstream out;
    out << value;
    return out.str();
}
template <class... T> std::string describe(const T&... values) {
    std::string out;
    ((out += "\n    " + show(values)), ...);
    return out;
}

// Every process group started and not yet reaped. A failure exits without unwinding, so it stops them here, or a
// failed test would leave its servers running.
inline std::mutex children_lock;
inline std::set<pid_t> children;
inline void kill_children() {
    std::lock_guard guard(children_lock);
    for (const pid_t pid : children) ::killpg(pid, SIGKILL);
}

[[noreturn]] inline void fail(const std::string& what, const char* file, int line) {
    std::cerr << "FAIL " << fs::path(file).filename().string() << ':' << line << ": " << what << std::endl;
    kill_children();
    std::exit(1);
}

// Where the test had got to, for an exception nothing caught: a reply without the field a check reads, say.
inline const char* last_file = "";
inline int last_line = 0;
inline const bool terminate_handler_installed = [] {
    std::set_terminate([] {
        std::string what = "unknown";
        try {
            if (auto error = std::current_exception()) std::rethrow_exception(error);
        } catch (const std::exception& error) {
            what = error.what();
        } catch (...) {
        }
        std::cerr << "FAIL " << fs::path(last_file).filename().string() << ':' << last_line << " (or just after): " << what << std::endl;
        kill_children();
        std::_Exit(1);
    });
    return true;
}();

// EXPECT(condition, anything that helps to explain a failure...)
#define EXPECT(condition, ...) \
    do { \
        ::check::last_file = __FILE__; \
        ::check::last_line = __LINE__; \
        if (!(condition)) ::check::fail(std::string(#condition) + ::check::describe(__VA_ARGS__), __FILE__, __LINE__); \
    } while (0)

// ---------------------------------------------------------------------------------------------------- Places and time

inline fs::path root() { return DSTNS_SOURCE_DIR; }

inline std::string env(const char* name, std::string fallback = "") {
    const char* value = std::getenv(name);
    return value && *value ? value : fallback;
}

inline std::string server_binary() { return env("DSTNS_SERVER", (root() / "build" / "dstns_server").string()); }

inline double now() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
inline void delay(double seconds) { std::this_thread::sleep_for(std::chrono::duration<double>(seconds)); }

inline std::string read(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(in), {}};
}
inline void write(const fs::path& path, std::string_view text) {
    std::ofstream(path, std::ios::binary) << text;
}
inline std::string trim(std::string text) {
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.pop_back();
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) text.erase(0, 1);
    return text;
}
inline bool contains(std::string_view text, std::string_view part) { return text.find(part) != std::string_view::npos; }

inline std::string random_hex(std::size_t bytes) {
    static std::random_device device;
    std::string out;
    for (std::size_t i = 0; i < bytes; ++i) {
        static const char* digits = "0123456789abcdef";
        const auto byte = device() & 0xff;
        out += digits[byte >> 4];
        out += digits[byte & 15];
    }
    return out;
}

// A directory of its own, removed afterwards.
struct TempDir {
    fs::path path;
    explicit TempDir(const std::string& prefix = "dstns-test-") {
        std::string pattern = (fs::temp_directory_path() / (prefix + "XXXXXX")).string();
        if (!::mkdtemp(pattern.data())) fail("mkdtemp failed", __FILE__, __LINE__);
        path = fs::canonical(pattern);
    }
    ~TempDir() {
        std::error_code ignored;
        fs::remove_all(path, ignored);
    }
    TempDir(const TempDir&) = delete;
    TempDir& operator=(const TempDir&) = delete;
    fs::path operator/(const std::string& name) const { return path / name; }
    std::string str() const { return path.string(); }
};

// A port nothing is listening on. (Not an httplib::Server: it never closes a socket it bound but did not serve, which
// would then take the first connection meant for the real server.)
inline int free_port() {
    const int sock = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t length = sizeof address;
    ::bind(sock, reinterpret_cast<sockaddr*>(&address), sizeof address);
    ::getsockname(sock, reinterpret_cast<sockaddr*>(&address), &length);
    ::close(sock);
    return ntohs(address.sin_port);
}

// Calls fn until it gives something true, or fails after `seconds`. Exceptions count as not yet.
template <class F> auto until(F fn, double seconds = 8, const char* what = "the condition") {
    const double end = now() + seconds;
    while (now() < end) {
        try {
            if (auto result = fn()) return result;
        } catch (const std::exception&) {
        }
        delay(0.02);
    }
    fail(std::string("timed out waiting for ") + what, __FILE__, __LINE__);
}

// ---------------------------------------------------------------------------------------------------- Requests

struct Unreachable : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct Reply {
    int status = 0;
    json body;
    httplib::Headers headers;
    std::string text;
    const json& data() const { return body.at("data"); }
    // The error code, or "" when there is none.
    std::string code() const {
        return body.is_object() && body.contains("error") && body["error"].is_object() ? body["error"].value("code", "") : "";
    }
    // Every header of that name, joined as one, as HTTP allows. (Their order is not kept.)
    std::string header(const std::string& name) const {
        std::string joined;
        for (auto [at, end] = headers.equal_range(name); at != end; ++at) joined += (joined.empty() ? "" : ", ") + at->second;
        return joined;
    }
};
inline std::string show(const Reply& reply) { return std::to_string(reply.status) + " " + reply.text.substr(0, 2000); }

inline Reply request(int port, const std::string& method, const std::string& route, const std::optional<json>& data = none,
                     const Headers& headers = {}, double timeout = 20, std::optional<std::string> raw = std::nullopt) {
    httplib::Client client("127.0.0.1", port);
    client.set_connection_timeout(std::chrono::milliseconds(static_cast<int>(timeout * 1000)));
    client.set_read_timeout(std::chrono::milliseconds(static_cast<int>(timeout * 1000)));
    client.set_write_timeout(std::chrono::milliseconds(static_cast<int>(timeout * 1000)));
    // The path as it is written, for paths that are wrong on purpose.
    client.set_path_encode(false);
    httplib::Request req;
    req.method = method;
    req.path = route;
    req.set_header("Content-Type", "application/json");
    for (const auto& [key, value] : headers) {
        req.headers.erase(key);
        req.set_header(key, value);
    }
    if (raw) req.body = *raw;
    else if (data) req.body = data->dump();
    if (!req.body.empty() || method == "POST" || method == "PUT") req.set_header("Content-Length", std::to_string(req.body.size()));
    auto result = client.send(req);
    if (!result) throw Unreachable(method + " " + route + ": " + httplib::to_string(result.error()));
    Reply reply{result->status, json::parse(result->body, nullptr, false), result->headers, result->body};
    if (reply.body.is_discarded()) reply.body = nullptr;
    return reply;
}

// ---------------------------------------------------------------------------------------------------- Programs

// A program's path: as given when it names a path, else as found on PATH.
inline std::string which(const std::string& name) {
    if (name.find('/') != std::string::npos) return name;
    std::stringstream path(env("PATH", "/usr/bin:/bin"));
    for (std::string dir; std::getline(path, dir, ':');) {
        if (::access((fs::path(dir) / name).c_str(), X_OK) == 0) return (fs::path(dir) / name).string();
    }
    return name;
}

// A program run in a process group of its own, with the environment it is given and none of the caller's DSTNS_
// settings, so a test never reaches the operator's own server, token or files.
// What of a program's output to keep: none of it, all of it (stdout and stderr as one), or only what it writes to stderr.
enum class Capture { Nothing, Output, Errors };

struct Process {
    pid_t pid = -1;
    int status = -1;

    static Process start(const std::vector<std::string>& argv, const Env& extra = {}, Capture capture = Capture::Nothing, const fs::path& cwd = root()) {
        std::vector<std::string> environment;
        for (char** item = environ; *item; ++item) {
            const std::string entry = *item;
            if (entry.rfind("DSTNS_", 0) == 0 && entry.rfind("DSTNS_SERVER=", 0) != 0) continue;
            environment.push_back(entry);
        }
        for (const auto& [key, value] : extra) {
            std::erase_if(environment, [&](const std::string& entry) { return entry.rfind(key + "=", 0) == 0; });
            environment.push_back(key + "=" + value);
        }
        const std::string program = which(argv.at(0));
        int pipe_ends[2] = {-1, -1};
        if (capture != Capture::Nothing && ::pipe(pipe_ends) != 0) fail("pipe failed", __FILE__, __LINE__);
        Process process;
        process.pid = ::fork();
        if (process.pid == 0) {
            ::setpgid(0, 0);
            const int null = ::open("/dev/null", O_RDWR);
            ::dup2(null, 0);
            ::dup2(capture == Capture::Output ? pipe_ends[1] : null, 1);
            ::dup2(capture != Capture::Nothing ? pipe_ends[1] : null, 2);
            if (::chdir(cwd.c_str()) != 0) ::_exit(126);
            std::vector<char*> args, envp;
            for (const auto& arg : argv) args.push_back(const_cast<char*>(arg.c_str()));
            for (const auto& entry : environment) envp.push_back(const_cast<char*>(entry.c_str()));
            args.push_back(nullptr);
            envp.push_back(nullptr);
            ::execve(program.c_str(), args.data(), envp.data());
            ::_exit(127);
        }
        if (process.pid < 0) fail("fork failed", __FILE__, __LINE__);
        {
            std::lock_guard guard(children_lock);
            children.insert(process.pid);
        }
        if (capture != Capture::Nothing) {
            ::close(pipe_ends[1]);
            process.output_fd = pipe_ends[0];
            auto* sink = process.captured.get();
            auto* lock = process.lock.get();
            process.reader = std::make_shared<std::thread>([fd = pipe_ends[0], sink, lock] {
                char buffer[4096];
                ssize_t got;
                while ((got = ::read(fd, buffer, sizeof buffer)) > 0) {
                    std::lock_guard guard(*lock);
                    sink->append(buffer, static_cast<std::size_t>(got));
                }
                ::close(fd);
            });
        }
        return process;
    }

    bool running() {
        if (pid < 0 || status != -1) return false;
        int raw = 0;
        if (::waitpid(pid, &raw, WNOHANG) == pid) {
            status = WIFEXITED(raw) ? WEXITSTATUS(raw) : 128 + WTERMSIG(raw);
            std::lock_guard guard(children_lock);
            children.erase(pid);
            return false;
        }
        return true;
    }

    // The exit status, or -1 if it is still running after `seconds`.
    int wait(double seconds) {
        const double end = now() + seconds;
        while (running() && now() < end) delay(0.02);
        if (status == -1) return -1;
        finish();
        return status;
    }

    void signal_group(int sig) {
        if (pid > 0) ::killpg(pid, sig);
    }

    // SIGTERM, a moment's grace, then SIGKILL.
    int stop(double grace = 10) {
        if (!running()) {
            finish();
            return status;
        }
        signal_group(SIGTERM);
        if (wait(grace) == -1) {
            signal_group(SIGKILL);
            wait(5);
        }
        finish();
        return status;
    }

    std::string output() {
        std::lock_guard guard(*lock);
        return *captured;
    }

    // The output once the program has ended and closed it.
    std::string finish() {
        if (reader && reader->joinable() && status != -1) reader->join();
        return output();
    }

    int output_fd = -1;
    std::shared_ptr<std::string> captured = std::make_shared<std::string>();
    std::shared_ptr<std::mutex> lock = std::make_shared<std::mutex>();
    std::shared_ptr<std::thread> reader;
};

struct Ran {
    int code;
    std::string output;
};

// Runs a program to its end, with its output, stopping it after `timeout` seconds (exit status 124).
inline Ran run(const std::vector<std::string>& argv, const Env& extra = {}, double timeout = 120, Capture capture = Capture::Output, const fs::path& cwd = root()) {
    auto process = Process::start(argv, extra, capture, cwd);
    if (process.wait(timeout) == -1) {
        process.stop(2);
        return {124, process.finish()};
    }
    return {process.status, process.finish()};
}

// ---------------------------------------------------------------------------------------------------- The server

// dstns_server on a port of its own, writing to `logs`. Started ready: /health answers and the operator's token is read.
struct Server {
    fs::path logs;
    int port = 0;
    Process process;
    std::string operator_token;
    Headers host; // the operator's header

    explicit Server(fs::path logs_dir, std::vector<std::string> args = {}, Env extra = {}) : logs(std::move(logs_dir)) {
        port = free_port();
        std::vector<std::string> argv{server_binary(), "--host", "127.0.0.1", "--port", std::to_string(port), "--logs", logs.string()};
        argv.insert(argv.end(), args.begin(), args.end());
        process = Process::start(argv, extra);
        const double end = now() + 15;
        while (true) {
            try {
                if (call("GET", "/health", none, "", {}, 2).status == 200) break;
            } catch (const Unreachable&) {
            }
            if (!process.running()) fail("the server exited with status " + std::to_string(process.status), __FILE__, __LINE__);
            if (now() > end) fail("the server did not answer /health", __FILE__, __LINE__);
            delay(0.02);
        }
        operator_token = trim(read(logs / "operator.token"));
        host = {{"X-DSTNS-Operator", operator_token}};
    }
    ~Server() { stop(); }
    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    Reply call(const std::string& method, const std::string& route, const std::optional<json>& data = none, const std::string& token = "",
               Headers headers = {}, double timeout = 20) const {
        if (!token.empty()) headers["Authorization"] = "Bearer " + token;
        return request(port, method, route, data, headers, timeout);
    }
    // As the operator.
    Reply op(const std::string& method, const std::string& route, const std::optional<json>& data = none, double timeout = 20) const {
        return request(port, method, route, data, host, timeout);
    }
    // A body sent as it is, for what a JSON value could not say.
    Reply raw(const std::string& method, const std::string& route, const std::string& body, Headers headers = {}, double timeout = 30) const {
        return request(port, method, route, none, headers, timeout, body);
    }
    int stop() { return process.stop(); }
};

// ---------------------------------------------------------------------------------------------------- Upstreams

// An HTTP service on a port of its own, answering as the test says: a stand-in for Overpass, or for anything else.
struct Upstream {
    httplib::Server http;
    int port = 0;
    std::thread thread;
    void start() {
        port = http.bind_to_any_port("127.0.0.1");
        thread = std::thread([this] { http.listen_after_bind(); });
        http.wait_until_ready();
    }
    std::string url() const { return "http://127.0.0.1:" + std::to_string(port); }
    ~Upstream() {
        http.stop();
        if (thread.joinable()) thread.join();
    }
};

inline std::string sha256_hex(std::string_view text) { return dstns::sha256(text); }

} // namespace check
