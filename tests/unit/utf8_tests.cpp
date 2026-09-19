// Text boundaries.
//
// nlohmann::json refuses to serialise invalid UTF-8 (type_error.316), so a
// mis-encoded OpenStreetMap tag, a child process writing binary, or a path the
// filesystem hands back in another encoding would otherwise break a response
// or terminate a request. Text is repaired where it enters the core, and
// serialisation carries a final guard.
#include "dstns/scenario.hpp"
#include "dstns/utf8.hpp"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

using namespace dstns;

namespace {
int failures = 0;
void check(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    } else {
        std::cout << "  ok  " << message << '\n';
    }
}

const std::string kReplacement = "\xEF\xBF\xBD";

/// A minimal but complete map whose tags carry the bytes under test.
std::string map_with(const std::string& raw_name) {
    return R"(<?xml version="1.0" encoding="UTF-8"?><osm version="0.6">)"
           R"(<node id="1" lat="52.5000" lon="13.4000"/>)"
           R"(<node id="2" lat="52.5010" lon="13.4000"/>)"
           R"(<node id="3" lat="52.5010" lon="13.4014"/>)"
           R"(<node id="4" lat="52.5000" lon="13.4014"/>)"
           R"(<node id="5" lat="52.5005" lon="13.4007"><tag k="amenity" v="school"/><tag k="name" v=")" + raw_name + R"("/></node>)"
           R"(<way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v=")" + raw_name + R"("/></way>)"
           R"(<way id="11"><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/></way>)"
           R"(<way id="12"><nd ref="3"/><nd ref="4"/><tag k="highway" v="residential"/></way>)"
           R"(<way id="13"><nd ref="4"/><nd ref="1"/><tag k="highway" v="residential"/></way>)"
           "</osm>";
}
}  // namespace

int main() {
    std::cout << "validation\n";
    {
        check(is_valid_utf8(""), "empty text is valid");
        check(is_valid_utf8("Kreuzberger Stra\xC3\x9F" "e"), "well-formed two-byte sequences are valid");
        check(is_valid_utf8("\xE6\x9D\xB1\xE4\xBA\xAC"), "well-formed three-byte sequences are valid");
        check(is_valid_utf8("\xF0\x9F\x9A\xA6"), "well-formed four-byte sequences are valid");
        // The byte from the reported failure: a lone 0x04 after one valid byte.
        check(!is_valid_utf8(std::string("\xC3\x04", 2)), "a truncated sequence is invalid");
        check(!is_valid_utf8("\xC0\xAF"), "an overlong encoding is invalid");
        check(!is_valid_utf8("\xED\xA0\x80"), "a surrogate is invalid");
        check(!is_valid_utf8("\xF5\x80\x80\x80"), "a code point above U+10FFFF is invalid");
        check(!is_valid_utf8("\xE6\x9D"), "a sequence cut short at the end is invalid");
        check(valid_utf8_prefix("ok\xFF") == 2, "the valid prefix stops at the first bad byte");
    }

    std::cout << "repair\n";
    {
        check(sanitize_utf8("Hauptstra\xC3\x9F" "e") == "Hauptstra\xC3\x9F" "e", "valid text is returned unchanged");
        check(sanitize_utf8(std::string("A\x04""B", 3)) == "AB", "control bytes are dropped");
        check(sanitize_utf8("A\xFF""B") == "A" + kReplacement + "B", "one replacement per malformed byte");
        check(sanitize_utf8("\xE6\x9D") == kReplacement + kReplacement, "a truncated tail is replaced, not kept");
        check(is_valid_utf8(sanitize_utf8("\xC3\x28\xA0\xA1")), "repaired text is always valid");
        check(sanitize_utf8("east\xC3\xA9", 5) == "east", "a limit cuts on a character boundary");
        check(sanitize_utf8("keeps\ttabs\nand lines").find('\n') != std::string::npos, "multi-line text keeps its lines");
        check(sanitize_message("one\ntwo\tthree") == "one two three", "a message collapses to a single line");
        check(sanitize_message(std::string(4000, 'x')).size() <= 2048, "a message cannot grow without bound");
    }

    std::cout << "serialisation guard\n";
    {
        nlohmann::json document{{"name", std::string("bad\x04\xFF", 5)}};
        bool threw = false;
        try {
            (void)document.dump();
        } catch (const nlohmann::json::type_error&) {
            threw = true;
        }
        check(threw, "an unguarded dump still throws on invalid UTF-8");
        std::string text;
        bool guarded = true;
        try {
            text = dump_json(document);
        } catch (...) {
            guarded = false;
        }
        check(guarded && is_valid_utf8(text), "dump_json always produces valid UTF-8");
    }

    std::cout << "maps with mis-encoded tags\n";
    {
        const auto dir = std::filesystem::temp_directory_path() / "dstns-utf8-tests";
        std::filesystem::create_directories(dir);
        // A Latin-1 "ß" and a stray control byte, as a truncated download or a
        // non-UTF-8 editor would leave behind.
        const auto path = dir / "broken.osm.xml";
        {
            std::ofstream out(path, std::ios::binary);
            out << map_with(std::string("Hauptstra\xDF""e\x04", 12));
        }
        ScenarioConfig config;
        config.osm_file = path.string();
        config.playback_duration_s = 3600;
        Scenario scenario;
        bool compiled = true;
        try {
            scenario = ScenarioCompiler{}.compile(Seed128::parse("0x1234"), config);
        } catch (const std::exception& e) {
            compiled = false;
            std::cerr << "        " << e.what() << '\n';
        }
        check(compiled, "a map with mis-encoded tags still compiles");
        if (compiled) {
            bool valid = true;
            for (const auto& edge : scenario.edges) {
                valid = valid && is_valid_utf8(edge.name);
                for (const auto& [key, value] : edge.tags) valid = valid && is_valid_utf8(key) && is_valid_utf8(value);
            }
            for (const auto& feature : scenario.features) {
                valid = valid && is_valid_utf8(feature.name) && is_valid_utf8(feature.category);
                for (const auto& [key, value] : feature.tags) valid = valid && is_valid_utf8(key) && is_valid_utf8(value);
            }
            check(valid, "every name and tag read from the map is valid UTF-8");

            bool named = false;
            for (const auto& edge : scenario.edges) named = named || edge.name.starts_with("Hauptstra");
            check(named, "the readable part of a mis-encoded name is kept");

            // What the observer would receive: the same text, serialised.
            nlohmann::json topology = nlohmann::json::array();
            for (const auto& edge : scenario.edges) topology.push_back({{"name", edge.name}, {"tags", edge.tags}});
            for (const auto& feature : scenario.features) topology.push_back({{"name", feature.name}, {"tags", feature.tags}});
            bool serialised = true;
            try {
                (void)topology.dump();
            } catch (const nlohmann::json::exception&) {
                serialised = false;
            }
            check(serialised, "the topology of that map serialises without a UTF-8 error");
        }
        std::filesystem::remove_all(dir);
    }

    std::cout << "malformed maps are rejected, not crashed on\n";
    {
        const auto dir = std::filesystem::temp_directory_path() / "dstns-utf8-tests-binary";
        std::filesystem::create_directories(dir);
        const auto path = dir / "binary.osm.xml";
        {
            // Gzip magic and random bytes: what a proxy or a truncated
            // download leaves in place of a map.
            std::ofstream out(path, std::ios::binary);
            const unsigned char bytes[] = {0x1F, 0x8B, 0x08, 0x00, 0x04, 0xFF, 0xFE, 0x00, 0x41, 0x04};
            for (int i = 0; i < 400; ++i) out.write(reinterpret_cast<const char*>(bytes), sizeof bytes);
        }
        ScenarioConfig config;
        config.osm_file = path.string();
        config.playback_duration_s = 3600;
        bool controlled = false;
        std::string message;
        try {
            (void)ScenarioCompiler{}.compile(Seed128::parse("0x1234"), config);
        } catch (const std::exception& e) {
            controlled = true;
            message = e.what();
        }
        check(controlled, "a binary file is reported as an error rather than parsed");
        check(is_valid_utf8(message), "and the error message itself is valid UTF-8");
        std::filesystem::remove_all(dir);
    }

    if (failures) {
        std::cerr << failures << " text boundary test(s) failed\n";
        return 1;
    }
    std::cout << "Text boundary tests passed\n";
    return 0;
}
