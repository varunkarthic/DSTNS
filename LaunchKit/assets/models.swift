// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Which of Apple's models this Mac can use, asked of the Foundation Models framework itself rather than read from the
// `fm` tool's output. Prints one JSON object: {"system": STATE, "pcc": STATE}, where STATE is "available" or
// "unavailable:REASON" with REASON the framework's own case name (or "unsupportedOS" before the API exists).
import Foundation
import FoundationModels

var system = "unavailable:unsupportedOS"
if #available(macOS 26.0, *) {
    switch SystemLanguageModel.default.availability {
    case .available: system = "available"
    case .unavailable(let reason): system = "unavailable:\(reason)"
    }
}

var pcc = "unavailable:unsupportedOS"
if #available(macOS 27.0, *) {
    switch PrivateCloudComputeLanguageModel().availability {
    case .available: pcc = "available"
    case .unavailable(let reason): pcc = "unavailable:\(reason)"
    }
}

let object = ["system": system, "pcc": pcc]
let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
