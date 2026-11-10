// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Advanced Security: the person at this machine proves they are its user, through the system's own prompt, before the
//! launcher can be changed, and nothing reaches the launcher through its interfaces for programs.
//!
//! With `security.advanced` on:
//!
//! - The interface and the interactive console ask as they open. A single command that changes something asks for
//!   itself; one that only reads never asks.
//! - Turning it on, or off again, always asks, wherever it is changed.
//! - The MCP Handler offers no launcher tool that changes anything, and changes only Fabric's applications.
//!
//! The prompt is the system's: Touch ID or the account password on macOS (LocalAuthentication, through a small Swift
//! program built once), polkit or sudo on Linux, and Windows Hello under WSL, falling back to sudo. It guards the
//! launcher's own ways in. It is not a sandbox: a program running as this user can still edit the files themselves.

use crate::paths::Paths;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const KEY: &str = "security.advanced";
/// Set for the processes a verified launcher starts: the pid of the launcher that verified.
const VERIFIED_BY: &str = "DSTNS_VERIFIED_BY";

static VERIFIED_AT: Mutex<Option<Instant>> = Mutex::new(None);

pub fn enabled(paths: &Paths) -> bool {
    crate::config::load(paths).map(|c| crate::config::flag(&c, KEY)).unwrap_or(false)
}

/// Whether this process has been verified: by a prompt here, or by the launcher that started it.
pub fn verified() -> bool {
    VERIFIED_AT.lock().map(|v| v.is_some()).unwrap_or(false) || started_by_verified()
}

/// A prompt answered in this process just now, so that one change is not asked about twice.
fn just_verified() -> bool {
    VERIFIED_AT.lock().ok().and_then(|v| *v).map(|at| at.elapsed() < Duration::from_secs(5)).unwrap_or(false)
}

/// The launcher that started this one verified, and passed it on. Only the launcher itself sets the variable, after
/// verifying, so its parent must be this very program: a shell that sets it is not.
fn started_by_verified() -> bool {
    let Some(claimed) = std::env::var(VERIFIED_BY).ok().and_then(|v| v.parse::<u32>().ok()) else { return false };
    let parent = unsafe { libc::getppid() } as u32;
    claimed == parent && same_program(parent)
}

fn same_program(pid: u32) -> bool {
    let (Some(theirs), Ok(ours)) = (executable_of(pid), std::env::current_exe()) else { return false };
    theirs.canonicalize().ok() == ours.canonicalize().ok()
}

#[cfg(target_os = "linux")]
fn executable_of(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "macos")]
fn executable_of(pid: u32) -> Option<PathBuf> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe { libc::proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(String::from_utf8(buffer).ok()?))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn executable_of(_pid: u32) -> Option<PathBuf> {
    None
}

fn mark_verified() {
    if let Ok(mut at) = VERIFIED_AT.lock() {
        *at = Some(Instant::now());
    }
    // What this launcher starts is verified with it.
    std::env::set_var(VERIFIED_BY, std::process::id().to_string());
}

// ---- The seal ---------------------------------------------------------------------------------------------------
//
// With Advanced Security on, the launcher keeps a digest of the files that decide what a run does. It writes them when
// it changes those files itself (saving settings, building the server). Before it starts a server it checks them, and
// a file changed by anything else stops the start until the person here accepts it with `security accept`, which asks
// as every change does and is written to an audit log with what changed. Off, none of this happens.

/// What decides a run: its settings, the observer's settings, and the server program itself.
const SEALED: &[&str] = &["config/defaults.json", "config/ui-config.json", "build/dstns_server"];

fn seal_file(paths: &Paths) -> PathBuf {
    paths.root.join("config").join(".launcher-seal")
}

fn audit_file(paths: &Paths) -> PathBuf {
    paths.logs().join("security-audit.log")
}

/// Each sealed file and its SHA-256, or "absent".
pub fn fingerprint(paths: &Paths) -> Vec<(String, String)> {
    use sha2::{Digest, Sha256};
    SEALED
        .iter()
        .map(|name| {
            let digest = std::fs::read(paths.root.join(name)).map(|bytes| format!("{:x}", Sha256::digest(&bytes))).unwrap_or_else(|_| "absent".into());
            (name.to_string(), digest)
        })
        .collect()
}

fn recorded(paths: &Paths) -> Option<Vec<(String, String)>> {
    let text = std::fs::read_to_string(seal_file(paths)).ok()?;
    Some(text.lines().filter_map(|line| line.split_once(' ').map(|(d, n)| (n.to_string(), d.to_string()))).collect())
}

fn audit(paths: &Paths, what: &str) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(paths.logs());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(audit_file(paths)) {
        let _ = writeln!(file, "{} {what}", chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z"));
    }
}

/// Record the files as they are now. The launcher calls this after it changes them itself.
pub fn seal(paths: &Paths) {
    if !enabled(paths) {
        return;
    }
    let text: String = fingerprint(paths).iter().map(|(name, digest)| format!("{digest} {name}\n")).collect();
    let _ = std::fs::write(seal_file(paths), text);
}

/// The sealed files changed by something other than the launcher, by name. Empty when nothing has, or when
/// Advanced Security is off. With no seal yet, the files as they are become it.
pub fn tampered(paths: &Paths) -> Vec<String> {
    if !enabled(paths) {
        return Vec::new();
    }
    let Some(was) = recorded(paths) else {
        seal(paths);
        audit(paths, "sealed for the first time");
        return Vec::new();
    };
    let now = fingerprint(paths);
    now.iter().filter(|(name, digest)| was.iter().find(|(n, _)| n == name).map(|(_, d)| d != digest).unwrap_or(true)).map(|(name, _)| name.clone()).collect()
}

/// The person here accepts what changed: asked as any change is, then written down, then sealed again.
pub fn accept(paths: &Paths) -> Result<Vec<String>, String> {
    let changed = tampered(paths);
    if changed.is_empty() {
        return Ok(vec!["Nothing has changed outside the launcher.".into()]);
    }
    authenticate(paths, "accept changes made outside the DSTNS launcher")?;
    audit(paths, &format!("accepted by the person at this machine ({}): {}", method(), changed.join(", ")));
    seal(paths);
    Ok(vec![format!("Accepted: {}. Recorded in {}.", changed.join(", "), audit_file(paths).display())])
}

/// With Advanced Security on, verify once for this process, unless it already is. Off, it does nothing.
pub fn require(paths: &Paths, reason: &str) -> Result<(), String> {
    if !enabled(paths) || verified() {
        return Ok(());
    }
    authenticate(paths, reason)
}

/// Turning Advanced Security on or off: always asks, unless a prompt in this process was answered just now.
pub fn confirm_change(paths: &Paths, on: bool) -> Result<(), String> {
    if just_verified() {
        return Ok(());
    }
    authenticate(paths, if on { "turn on Advanced Security for DSTNS" } else { "turn off Advanced Security for DSTNS" })
}

/// Ask the system. Ok once the person has proved they are this machine's user.
pub fn authenticate(paths: &Paths, reason: &str) -> Result<(), String> {
    crate::log::info(&format!("advanced security: asking to {reason} ({})", method()));
    let outcome = ask(paths, reason);
    crate::log::info(&format!("advanced security: {}", if outcome.is_ok() { "verified" } else { "not verified" }));
    if outcome.is_ok() {
        mark_verified();
    }
    outcome
}

/// How this machine asks, for `security status`.
pub fn method() -> &'static str {
    if cfg!(target_os = "macos") {
        "Touch ID or your password (macOS)"
    } else if wsl() {
        "Windows Hello, or sudo (WSL)"
    } else if found("pkexec") && graphical() {
        "polkit (your password)"
    } else {
        "sudo (your password)"
    }
}

fn wsl() -> bool {
    std::fs::read_to_string("/proc/version").map(|v| v.to_lowercase().contains("microsoft")).unwrap_or(false)
}

fn graphical() -> bool {
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

fn found(program: &str) -> bool {
    Command::new("sh").args(["-c", &format!("command -v {program}")]).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

fn ask(paths: &Paths, reason: &str) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        return match helper(paths).map(|h| Command::new(h).arg(reason).status()) {
            Some(Ok(status)) if status.code() == Some(0) => Ok(()),
            Some(Ok(status)) if status.code() == Some(1) => Err("Not verified.".into()),
            // No Swift, or nothing to ask with: the administrator password, through the system's own dialog.
            _ => run(Command::new("osascript").args(["-e", &format!("do shell script \"/usr/bin/true\" with prompt \"DSTNS wants to {}.\" with administrator privileges", reason.replace('"', "'"))])),
        };
    }
    if wsl() {
        if let Ok(status) = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &windows_hello(reason)]).status() {
            match status.code() {
                Some(0) => return Ok(()),
                Some(1) => return Err("Not verified.".into()),
                _ => {} // Windows Hello is not set up: sudo, as on Linux.
            }
        }
    }
    // These may ask in the terminal, which the interface has to lend them.
    crate::interface::with_terminal(|| {
        if found("pkexec") && graphical() {
            return run(Command::new("pkexec").arg("/bin/true"));
        }
        // sudo -k forgets a recent password, so that this really asks.
        run(Command::new("sh").args(["-c", "sudo -k && sudo -v -p 'DSTNS Advanced Security: the password for %u: '"]))
    })
}

fn run(command: &mut Command) -> Result<(), String> {
    match command.status() {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err("Not verified.".into()),
        Err(error) => Err(format!("The system's prompt could not be shown: {error}")),
    }
}

const SWIFT: &str = include_str!("../assets/verify.swift");

/// The macOS helper, built from its Swift source the first time, and again whenever the source changes.
fn helper(paths: &Paths) -> Option<PathBuf> {
    coreai::apple::swift_program(&paths.build(), "dstns-verify", SWIFT, &[])
}

/// Windows Hello through PowerShell's WinRT bridge. Exit 0: verified; 1: refused; 2: not set up.
fn windows_hello(reason: &str) -> String {
    let reason = reason.replace('\'', "");
    format!(
        "Add-Type -AssemblyName System.Runtime.WindowsRuntime; \
         $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]; \
         $wait = {{ param($op, $type) $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }})[0].MakeGenericMethod($type); $t = $m.Invoke($null, @($op)); $t.Wait(); $t.Result }}; \
         $available = & $wait ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]); \
         if ($available -ne 'Available') {{ exit 2 }}; \
         $result = & $wait ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('DSTNS: {reason}')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult]); \
         if ($result -eq 'Verified') {{ exit 0 }} else {{ exit 1 }}"
    )
}

/// Whether a command, as typed, only reads. Commands that read never ask; anything else asks once.
pub fn reads_only(words: &[String]) -> bool {
    let word = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
    match word(0) {
        "" | "help" | "version" | "license" | "about" | "docs" | "ls" | "cat" | "tail" | "head" | "ps" | "get" | "uptime" | "grep" | "wc" | "sort" | "uniq" | "cut" | "echo" | "true" | "false" | "json" | "view" | "history" | "logs" | "status" | "man" | "which" => true,
        "env" => word(1).is_empty(),
        "security" => matches!(word(1), "" | "status"),
        "config" => matches!(word(1), "" | "get" | "list" | "show" | "path"),
        "seeds" => matches!(word(1), "" | "list" | "inspect" | "show"),
        "apps" => matches!(word(1), "" | "list" | "show" | "status" | "logs" | "doctor" | "proposals"),
        "fabric" => matches!(word(1), "" | "status" | "capabilities" | "audit"),
        "fastboot" => matches!(word(1), "" | "status"),
        // The handler only reads, or refuses, under Advanced Security.
        "mcp" => true,
        // A suggestion is only printed; trying the model, or reading the daemons, changes nothing.
        "ask" => true,
        "state" => matches!(word(1), "" | "get"),
        "model" => matches!(word(1), "" | "status" | "test"),
        "daemon" | "daemons" => matches!(word(1), "" | "status" | "list" | "show" | "queue"),
        // Only building it again writes anything.
        "graph" => word(1) != "update",
        "api" => word(1).eq_ignore_ascii_case("get"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &str) -> Vec<String> {
        shlex::split(line).unwrap()
    }

    #[test]
    fn only_what_changes_something_asks() {
        for line in ["ps", "ps -a", "config get api.port", "apps list", "logs api", "json settings .api", "env", "security status", "api GET /api/v1/system/info", "mcp tools", "help"] {
            assert!(reads_only(&words(line)), "{line} only reads");
        }
        for line in ["start --seed 4", "stop", "config set api.port 9000", "set api.port 9000", "env set DSTNS_X=1", "edit settings", "apps remove x", "api POST /api/v1/system/terminate", "reset", "security off", "tee out.txt", "fastboot clear"] {
            assert!(!reads_only(&words(line)), "{line} changes something");
        }
    }

    #[test]
    fn a_shell_cannot_claim_a_verification() {
        // The variable names this process's parent, which is a shell or a test runner, not this launcher.
        std::env::set_var(VERIFIED_BY, unsafe { libc::getppid() }.to_string());
        assert!(!started_by_verified(), "only the launcher itself can pass it on");
        std::env::remove_var(VERIFIED_BY);
        assert!(!started_by_verified());
    }

    #[test]
    fn windows_hello_keeps_the_reason_out_of_the_script() {
        assert!(!windows_hello("x'; Remove-Item C:\\ -Recurse; '").contains("x';"));
    }
}

#[cfg(test)]
mod seal_tests {
    use super::*;

    #[test]
    fn a_change_outside_the_launcher_is_found_and_one_inside_is_not() {
        let dir = std::env::temp_dir().join(format!("dstns-seal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        // The repository's own settings, with Advanced Security on.
        let mut config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../config/defaults.json")).unwrap()).unwrap();
        config["security"]["advanced"] = serde_json::Value::Bool(true);
        std::fs::write(dir.join("config/defaults.json"), config.to_string()).unwrap();
        std::fs::write(dir.join("build/dstns_server"), b"one").unwrap();
        let paths = Paths::new(&dir);
        assert!(tampered(&paths).is_empty(), "the first look seals what is there");
        std::fs::write(dir.join("build/dstns_server"), b"two").unwrap();
        assert_eq!(tampered(&paths), vec!["build/dstns_server".to_string()]);
        seal(&paths);
        assert!(tampered(&paths).is_empty(), "the launcher's own change is sealed");
        config["security"]["advanced"] = serde_json::Value::Bool(false);
        std::fs::write(dir.join("config/defaults.json"), config.to_string()).unwrap();
        assert!(tampered(&paths).is_empty(), "with Advanced Security off nothing is checked");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
