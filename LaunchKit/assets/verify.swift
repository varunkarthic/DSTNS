// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

// Advanced Security on macOS: the system's own sheet, Touch ID or the account password, for the person at this Mac.
// `verify REASON` asks; `verify --check` only says whether it can. Exit 0: verified. 1: refused. 2: cannot ask here.
import Foundation
import LocalAuthentication

let arguments = CommandLine.arguments.dropFirst()
let context = LAContext()
var problem: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else {
    FileHandle.standardError.write(Data(((problem?.localizedDescription ?? "Authentication is not available") + "\n").utf8))
    exit(2)
}
if arguments.first == "--check" { exit(0) }
let reason = arguments.first ?? "verify Advanced Security"
let done = DispatchSemaphore(value: 0)
var verified = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, failure in
    verified = success
    if let failure { FileHandle.standardError.write(Data((failure.localizedDescription + "\n").utf8)) }
    done.signal()
}
done.wait()
exit(verified ? 0 : 1)
