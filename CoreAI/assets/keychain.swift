// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// API keys in the login Keychain, for CoreAI. `keychain get ACCOUNT` prints the key; `keychain set ACCOUNT` reads it from
// standard input, so it never appears in a process listing; `keychain delete ACCOUNT` forgets it.
// Exit 0: done. 1: not found. 2: refused or failed.
import Foundation
import Security

let service = "DSTNS AI provider key"
let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 2, ["get", "set", "delete"].contains(arguments[0]) else {
    FileHandle.standardError.write("usage: keychain get|set|delete ACCOUNT\n".data(using: .utf8)!)
    exit(2)
}
let account = arguments[1]
let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]

switch arguments[0] {
case "get":
    var query = base
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    guard status == errSecSuccess, let data = found as? Data else { exit(status == errSecItemNotFound ? 1 : 2) }
    FileHandle.standardOutput.write(data)
case "set":
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    let trimmed = String(decoding: secret, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { exit(2) }
    let data = Data(trimmed.utf8)
    let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "DSTNS: \(account) API key"
        exit(SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? 0 : 2)
    }
    exit(status == errSecSuccess ? 0 : 2)
default:
    let status = SecItemDelete(base as CFDictionary)
    exit(status == errSecSuccess ? 0 : status == errSecItemNotFound ? 1 : 2)
}
