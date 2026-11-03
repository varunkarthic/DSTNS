// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// The release tool's boundaries. None of this writes to a registry: `docker` here is a stand-in that records what it
// was asked and answers as a registry would, with the platforms and digests each case sets.
#include "harness.hpp"

using namespace check;

namespace {

const std::string RELEASE = env("DSTNS_RELEASE", (fs::path(server_binary()).parent_path() / "dstns_release").string());
const std::string C64(64, 'c'), D64(64, 'd');

std::string version() {
    const auto text = read(root() / "CMakeLists.txt");
    const auto at = text.find("project(dstns VERSION ") + 22;
    return text.substr(at, text.find(' ', at) - at);
}

Ran metadata(const std::string& ref) { return run({RELEASE, "metadata"}, {{"GITHUB_REF", ref}}, 30); }

struct Publication {
    int code;
    std::vector<std::string> calls;
};

Publication publish(const std::string& architectures, const std::string& readback) {
    TempDir tmp;
    const auto bin = tmp / "bin";
    fs::create_directories(bin);
    write(bin / "docker", R"(#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *--raw*) printf '{"manifests":['; sep=''; for a in $FAKE_ARCHS; do printf '%s{"platform":{"os":"linux","architecture":"%s"}}' "$sep" "$a"; sep=','; done; printf ']}\n' ;;
  *candidate-*--format*) printf '{"digest":"sha256:%s"}\n' "$FAKE_CANDIDATE" ;;
  *--format*) printf '{"digest":"sha256:%s"}\n' "$FAKE_READBACK" ;;
esac
)");
    fs::permissions(bin / "docker", fs::perms::owner_all);
    const auto digests = tmp / "digests";
    fs::create_directories(digests);
    write(digests / std::string(64, 'a'), "");
    write(digests / std::string(64, 'b'), "");
    const auto ran = run({RELEASE, "publish", "--digests", digests.string()},
                         {{"PATH", bin.string() + ":/usr/bin:/bin"}, {"IMAGE", "ghcr.io/example/test"}, {"META", R"({"tags":["ghcr.io/example/test:stable"]})"},
                          {"GITHUB_RUN_ID", "1"}, {"GITHUB_RUN_ATTEMPT", "1"}, {"GITHUB_STEP_SUMMARY", (tmp / "summary").string()}, {"FAKE_LOG", (tmp / "log").string()},
                          {"FAKE_ARCHS", architectures}, {"FAKE_CANDIDATE", C64}, {"FAKE_READBACK", readback}},
                         30);
    std::vector<std::string> creates;
    std::istringstream log(read(tmp / "log"));
    for (std::string line; std::getline(log, line);) {
        if (line.starts_with("buildx imagetools create")) creates.push_back(line);
    }
    return {ran.code, creates};
}

} // namespace

int main() {
    // main and the exact release tag are stable; other branches are not; a tag for another version is refused.
    for (const auto& ref : {std::string("refs/heads/main"), "refs/tags/v" + version()}) {
        const auto ran = metadata(ref);
        EXPECT(ran.code == 0 && contains(ran.output, "channel=stable") && contains(ran.output, "version=" + version()), ref, ran.output);
    }
    EXPECT(contains(metadata("refs/heads/experiment").output, "channel=edge"));
    EXPECT(metadata("refs/tags/v9.9.9").code != 0);

    // Without arm64, nothing is promoted: only the candidate was made.
    auto published = publish("amd64", C64);
    EXPECT(published.code != 0 && published.calls.size() == 1 && !contains(published.calls[0], ":stable"), json(published.calls));
    // With both, the immutable digest is promoted.
    published = publish("amd64 arm64", C64);
    EXPECT(published.code == 0 && published.calls.size() == 2 && published.calls[1].ends_with("ghcr.io/example/test@sha256:" + C64), json(published.calls));
    // A tag that reads back as something else fails the release.
    EXPECT(publish("amd64 arm64", D64).code != 0);

    // Every source file carries the licence header.
    const auto headers = run({RELEASE, "headers", "--check"});
    EXPECT(headers.code == 0, headers.output);
    std::cout << "release ok: metadata channels, two-platform promotion, read-back, licence headers\n";
}
