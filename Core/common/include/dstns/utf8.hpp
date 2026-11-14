// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

#pragma once

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>

namespace dstns {

// Text boundaries.
//
// Everything the core serialises must be valid UTF-8: nlohmann::json throws
// type_error.316 on the first invalid byte, which would otherwise turn a
// mis-encoded OpenStreetMap tag, a filesystem path or a subprocess message
// into a failed response or a terminated request.
//
// Text arriving from outside the core (downloaded maps, child processes, the
// filesystem, operator input) is therefore validated and repaired where it
// enters, and serialisation carries a second, unconditional guard.

/// Whether `text` is well-formed UTF-8: no overlong forms, surrogates or
/// truncated sequences.
[[nodiscard]] bool is_valid_utf8(std::string_view text) noexcept;

/// Longest valid UTF-8 prefix of `text`, in bytes.
[[nodiscard]] std::size_t valid_utf8_prefix(std::string_view text) noexcept;

/// `text` with every malformed byte replaced by U+FFFD and with C0 control
/// characters other than tab, newline and carriage return removed. Valid text
/// is returned unchanged. `limit` caps the result, cutting on a character
/// boundary, so an unbounded external string cannot become an unbounded field.
[[nodiscard]] std::string sanitize_utf8(std::string_view text, std::size_t limit = 8192);

/// Same, for text that becomes a single message line: tabs and newlines
/// collapse to spaces.
[[nodiscard]] std::string sanitize_message(std::string_view text, std::size_t limit = 2048);

/// Serialise `value` for the wire. Any invalid UTF-8 that still reached the
/// document is replaced rather than throwing, so a response is always sent.
[[nodiscard]] std::string dump_json(const nlohmann::json& value, int indent = -1);

} // namespace dstns
