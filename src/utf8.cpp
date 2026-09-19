#include "dstns/utf8.hpp"

#include <cstdint>

namespace dstns {
namespace {

// Length of the UTF-8 sequence starting at `text[i]`, or 0 when the byte is
// not a well-formed start of a sequence that fits in what remains. The ranges
// follow the Unicode table: no overlong encodings, no surrogates (D800..DFFF),
// nothing above U+10FFFF.
std::size_t sequence_length(std::string_view text, std::size_t i) noexcept {
    const auto byte = static_cast<unsigned char>(text[i]);
    const auto remaining = text.size() - i;
    const auto cont = [&](std::size_t offset, unsigned char lo, unsigned char hi) {
        const auto b = static_cast<unsigned char>(text[i + offset]);
        return b >= lo && b <= hi;
    };
    if (byte <= 0x7F) return 1;
    if (byte >= 0xC2 && byte <= 0xDF) return remaining >= 2 && cont(1, 0x80, 0xBF) ? 2 : 0;
    if (byte == 0xE0) return remaining >= 3 && cont(1, 0xA0, 0xBF) && cont(2, 0x80, 0xBF) ? 3 : 0;
    if (byte >= 0xE1 && byte <= 0xEC) return remaining >= 3 && cont(1, 0x80, 0xBF) && cont(2, 0x80, 0xBF) ? 3 : 0;
    if (byte == 0xED) return remaining >= 3 && cont(1, 0x80, 0x9F) && cont(2, 0x80, 0xBF) ? 3 : 0;
    if (byte >= 0xEE && byte <= 0xEF) return remaining >= 3 && cont(1, 0x80, 0xBF) && cont(2, 0x80, 0xBF) ? 3 : 0;
    if (byte == 0xF0) return remaining >= 4 && cont(1, 0x90, 0xBF) && cont(2, 0x80, 0xBF) && cont(3, 0x80, 0xBF) ? 4 : 0;
    if (byte >= 0xF1 && byte <= 0xF3) return remaining >= 4 && cont(1, 0x80, 0xBF) && cont(2, 0x80, 0xBF) && cont(3, 0x80, 0xBF) ? 4 : 0;
    if (byte == 0xF4) return remaining >= 4 && cont(1, 0x80, 0x8F) && cont(2, 0x80, 0xBF) && cont(3, 0x80, 0xBF) ? 4 : 0;
    return 0;
}

bool is_stripped_control(unsigned char byte, bool keep_whitespace) noexcept {
    if (byte == '\t' || byte == '\n' || byte == '\r') return !keep_whitespace;
    return byte < 0x20 || byte == 0x7F;
}

std::string clean(std::string_view text, std::size_t limit, bool single_line) {
    std::string out;
    out.reserve(text.size() < limit ? text.size() : limit);
    for (std::size_t i = 0; i < text.size();) {
        const auto length = sequence_length(text, i);
        if (length == 0) {
            // One replacement character per malformed byte, as WHATWG specifies.
            if (out.size() + 3 > limit) break;
            out += "\xEF\xBF\xBD";
            ++i;
            continue;
        }
        const auto byte = static_cast<unsigned char>(text[i]);
        if (length == 1 && is_stripped_control(byte, !single_line)) {
            if (single_line && (byte == '\t' || byte == '\n' || byte == '\r')) {
                if (out.size() + 1 > limit) break;
                // Keep words apart rather than running them together.
                if (!out.empty() && out.back() != ' ') out.push_back(' ');
            }
            ++i;
            continue;
        }
        if (out.size() + length > limit) break;
        out.append(text, i, length);
        i += length;
    }
    while (!out.empty() && out.back() == ' ') out.pop_back();
    return out;
}

} // namespace

std::size_t valid_utf8_prefix(std::string_view text) noexcept {
    std::size_t i = 0;
    while (i < text.size()) {
        const auto length = sequence_length(text, i);
        if (length == 0) break;
        i += length;
    }
    return i;
}

bool is_valid_utf8(std::string_view text) noexcept { return valid_utf8_prefix(text) == text.size(); }

std::string sanitize_utf8(std::string_view text, std::size_t limit) { return clean(text, limit, false); }

std::string sanitize_message(std::string_view text, std::size_t limit) { return clean(text, limit, true); }

std::string dump_json(const nlohmann::json& value, int indent) {
    // The boundaries sanitise what they accept; this is the last guard, so a
    // response is produced even if some path is missed.
    return value.dump(indent, ' ', false, nlohmann::json::error_handler_t::replace);
}

} // namespace dstns
