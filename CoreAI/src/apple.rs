// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Apple's Foundation Models: which of the two this Mac can use, asked of the framework itself, and asking them.

use crate::{AiError, ErrorKind, Request, Role};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MODELS_SWIFT: &str = include_str!("../assets/models.swift");

/// A small macOS program built from embedded Swift source on first use, cached in `dir` by a digest of the source and
/// flags, so a changed source builds again. None when `swiftc` is missing or the build fails.
pub fn swift_program(dir: &Path, name: &str, source_text: &str, flags: &[&str]) -> Option<PathBuf> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(source_text.as_bytes());
    hasher.update(flags.join(" ").as_bytes());
    let digest: String = hasher.finalize()[..6].iter().map(|b| format!("{b:02x}")).collect();
    let program = dir.join(format!("{name}-{digest}"));
    if program.is_file() {
        return Some(program);
    }
    std::fs::create_dir_all(dir).ok()?;
    let source = dir.join(format!("{name}-{digest}.swift"));
    std::fs::write(&source, source_text).ok()?;
    let built = Command::new("swiftc").arg("-O").args(flags).arg("-o").arg(&program).arg(&source).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    let _ = std::fs::remove_file(&source);
    built.then_some(program)
}

/// Apple's two models and whether each can answer here, as the Foundation Models framework reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppleModels {
    /// The model on this Mac: Ok, or why not, in plain words.
    pub system: Result<(), String>,
    /// Apple's larger model through Private Cloud Compute.
    pub cloud: Result<(), String>,
}

/// Asks the framework through a small Swift helper. The `fm` tool is not asked: its `available` command was renamed
/// `models`, and either one fails as a whole when only Private Cloud Compute is missing.
pub fn models(cache_dir: &Path) -> AppleModels {
    let none = |why: &str| AppleModels { system: Err(why.into()), cloud: Err(why.into()) };
    if !cfg!(target_os = "macos") || !cfg!(target_arch = "aarch64") {
        return none("Apple's models need a Mac with Apple silicon.");
    }
    // Built for macOS 26, where the framework first appears; the Private Cloud Compute check runs only on 27 and later.
    let Some(helper) = swift_program(cache_dir, "dstns-models", MODELS_SWIFT, &["-target", "arm64-apple-macos26.0"]) else {
        return none("Apple's models could not be checked: the Swift compiler is missing (xcode-select --install).");
    };
    let output = match Command::new(helper).stdin(Stdio::null()).stderr(Stdio::null()).output() {
        Ok(output) if output.status.success() => output.stdout,
        _ => return none("Apple's models could not be checked: this macOS has no Foundation Models (macOS 26 or later)."),
    };
    let report: Value = serde_json::from_slice(&output).unwrap_or(Value::Null);
    AppleModels { system: state(&report["system"]), cloud: state(&report["pcc"]) }
}

/// "available", or "unavailable:REASON" with the framework's own reason, in plain words.
pub fn state(state: &Value) -> Result<(), String> {
    let state = state.as_str().unwrap_or("unavailable:unknown");
    if state == "available" {
        return Ok(());
    }
    Err(match state.strip_prefix("unavailable:").unwrap_or(state) {
        "deviceNotEligible" => "this Mac cannot run it".into(),
        "appleIntelligenceNotEnabled" => "Apple Intelligence is turned off in System Settings".into(),
        "modelNotReady" => "the model is still being downloaded or prepared".into(),
        "systemNotReady" => "it is not ready in this context (it may work from the Terminal app)".into(),
        "unsupportedOS" => "this macOS is too old for it".into(),
        other => format!("not available ({other})"),
    })
}

/// "system" or "pcc": the model on the Mac first, then Private Cloud Compute if allowed, or why neither.
pub fn choose(cache_dir: &Path, cloud_allowed: bool) -> Result<String, String> {
    let found = models(cache_dir);
    match (&found.system, &found.cloud) {
        (Ok(()), _) => Ok("system".into()),
        (Err(_), Ok(())) if cloud_allowed => Ok("pcc".into()),
        (Err(why), Ok(())) => Err(format!("the model on this Mac is not available: {why}. Private Cloud Compute is, but model.apple_cloud is off")),
        (Err(why), Err(cloud)) => Err(format!("the model on this Mac is not available: {why}. Private Cloud Compute: {cloud}")),
    }
}

/// The `fm` command, where macOS has one.
pub fn fm() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let on_path = std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join("fm")).find(|p| p.is_file()));
    on_path.or_else(|| Some(PathBuf::from("/usr/bin/fm")).filter(|p| p.is_file()))
}

/// The conversation as `fm respond` takes it: instructions apart, and the turns before the last written out.
fn flatten(request: &Request) -> (String, String) {
    let instructions: Vec<&str> = request.messages.iter().filter(|m| m.role == Role::System).map(|m| m.content.as_str()).collect();
    let turns: Vec<_> = request.messages.iter().filter(|m| m.role != Role::System).collect();
    let mut prompt = String::new();
    if turns.len() > 1 {
        prompt.push_str("The conversation so far:\n");
        for m in &turns[..turns.len() - 1] {
            prompt.push_str(if m.role == Role::User { "User: " } else { "You: " });
            prompt.push_str(&m.content);
            prompt.push('\n');
        }
        prompt.push_str("\nNow answer this:\n");
    }
    prompt.push_str(turns.last().map(|m| m.content.as_str()).unwrap_or(""));
    (instructions.join("\n\n"), prompt)
}

pub fn strip_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for d in chars.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Ask `model` ("system" or "pcc") through `fm respond`, streaming its words to `on_text` when given.
pub fn respond(model: &str, request: &Request, on_text: Option<&mut dyn FnMut(&str)>) -> Result<String, AiError> {
    let fm = fm().ok_or_else(|| AiError::new(ErrorKind::NotConfigured, "apple", "the fm command was not found (macOS 26 or later)"))?;
    let (instructions, prompt) = flatten(request);
    let mut command = Command::new(fm);
    command.args(["respond", "-m", model]);
    if request.temperature.map(|t| t <= 0.0).unwrap_or(false) {
        command.arg("--greedy");
    }
    if !instructions.is_empty() {
        command.args(["-i", &instructions]);
    }
    command.arg(if on_text.is_some() { "--stream" } else { "--no-stream" });
    command.arg(&prompt).env("NO_COLOR", "1").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| AiError::new(ErrorKind::Unreachable, "apple", format!("fm: {e}")))?;
    let mut text = String::new();
    let mut stdout = child.stdout.take().expect("piped");
    let mut buffer = [0u8; 512];
    let mut pending = Vec::new();
    let mut on_text = on_text;
    loop {
        let n = stdout.read(&mut buffer).map_err(|e| AiError::new(ErrorKind::BadReply, "apple", e.to_string()))?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buffer[..n]);
        // Only whole characters, and never half an escape sequence.
        let cut = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) => e.valid_up_to(),
        };
        let cut = pending[..cut].iter().rposition(|b| *b == 0x1b).filter(|i| !pending[*i..cut].iter().any(u8::is_ascii_alphabetic)).unwrap_or(cut);
        let piece = strip_ansi(&String::from_utf8_lossy(&pending[..cut]));
        pending.drain(..cut);
        if let Some(f) = on_text.as_mut() {
            f(&piece);
        }
        text.push_str(&piece);
    }
    let mut problem = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut problem);
    }
    let status = child.wait().map_err(|e| AiError::new(ErrorKind::BadReply, "apple", e.to_string()))?;
    if !status.success() {
        let problem = strip_ansi(&problem).trim().trim_start_matches("Error:").trim().to_string();
        let kind = if problem.to_lowercase().contains("quota") { ErrorKind::RateLimited } else if problem.to_lowercase().contains("not available") { ErrorKind::NotConfigured } else { ErrorKind::Upstream };
        return Err(AiError::new(kind, "apple", if problem.is_empty() { format!("fm exited with {status}") } else { problem }));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Message;
    use serde_json::json;

    #[test]
    fn states_read_as_the_framework_reports_them() {
        assert_eq!(state(&json!("available")), Ok(()));
        assert!(state(&json!("unavailable:appleIntelligenceNotEnabled")).unwrap_err().contains("System Settings"));
        assert!(state(&json!("unavailable:modelNotReady")).unwrap_err().contains("downloaded"));
        assert!(state(&json!("unavailable:somethingNew")).unwrap_err().contains("somethingNew"));
        // Anything else, or nothing at all, is never read as available.
        for odd in [json!(null), json!(true), json!("Available"), json!("available "), json!("")] {
            assert!(state(&odd).is_err(), "{odd}");
        }
    }

    #[test]
    fn a_conversation_is_written_out_for_fm() {
        let request = Request {
            messages: vec![Message::system("Be brief."), Message::user("What is DSTNS?"), Message::assistant("A traffic simulator."), Message::user("Who runs it?")],
            ..Default::default()
        };
        let (instructions, prompt) = flatten(&request);
        assert_eq!(instructions, "Be brief.");
        assert!(prompt.starts_with("The conversation so far:\nUser: What is DSTNS?\nYou: A traffic simulator.\n"), "{prompt}");
        assert!(prompt.ends_with("Now answer this:\nWho runs it?"), "{prompt}");
        assert_eq!(flatten(&Request::new("I", "Just this")).1, "Just this");
    }

    #[test]
    #[ignore = "needs a Mac with Apple silicon and the Swift compiler"]
    fn the_framework_is_asked_on_this_mac() {
        let dir = std::env::temp_dir().join(format!("dstns-models-test-{}", std::process::id()));
        let found = models(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!format!("{found:?}").contains("could not be checked"), "{found:?}");
    }
}
