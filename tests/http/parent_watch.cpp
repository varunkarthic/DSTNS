// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// A server the launcher started goes with the launcher, however it ends: here the parent is killed with SIGKILL,
// which it cannot catch, and the server must stop by itself. Without DSTNS_PARENT_PID, a server runs on.
#include "harness.hpp"

#include <csignal>

using namespace check;

int main() {
    TempDir tmp("dstns-parent-watch-");
    const auto pid_file = tmp.path / "server.pid";
    const int port = free_port();
    // The parent: a shell that starts the server as the launcher does, naming itself, then waits.
    auto parent = Process::start({"sh", "-c", "DSTNS_PARENT_PID=$$ \"$0\" --port \"$1\" --logs \"$2\" & echo $! > \"$3\"; sleep 600",
                                  server_binary(), std::to_string(port), (tmp.path / "logs").string(), pid_file.string()});
    pid_t server = -1;
    for (double end = now() + 10; now() < end && server < 0; delay(0.05)) {
        std::ifstream in(pid_file);
        if (in >> server && server > 0) break;
        server = -1;
    }
    EXPECT(server > 0, "the server was started");
    // It answers, so it is running before its parent goes.
    bool up = false;
    for (double end = now() + 15; now() < end && !up; delay(0.1)) up = request(port, "GET", "/health", none, {}, 2).status == 200;
    EXPECT(up, "the server answers");
    ::kill(parent.pid, SIGKILL);
    bool gone = false;
    for (double end = now() + 5; now() < end && !gone; delay(0.1)) gone = ::kill(server, 0) != 0 && errno == ESRCH;
    if (!gone) ::kill(server, SIGKILL);
    EXPECT(gone, "the server stopped within 5 s of its parent being killed");
    std::cout << "Parent watch: the server stopped with its parent\n";
}
