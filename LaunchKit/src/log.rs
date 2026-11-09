// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launcher's own diagnostic log, `logs/launcher.log`.
//!
//! The log is best effort. If it cannot be written - a full disk, a directory that vanished, a sync client that has
//! evicted the file - logging stops quietly for the rest of the session instead of interrupting anything.

use crate::paths::{dataless, Paths};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

const MAX_BYTES: u64 = 1_000_000;
const BACKUPS: u32 = 2;

struct Sink {
    path: PathBuf,
    file: Option<File>,
    failed: bool,
    debug: bool,
    echo: bool,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

pub fn configure(paths: &Paths, debug: bool, echo: bool) {
    let path = paths.launcher_log();
    let failed = dataless(&path);
    *SINK.lock().unwrap() = Some(Sink { path, file: None, failed, debug, echo });
    info(&format!("launcher {} · Rust launcher · {} {}", crate::version::engine_version(), std::env::consts::OS, std::env::consts::ARCH));
}

/// Stop echoing to the terminal, which a full-screen interface now owns.
pub fn silence_console() {
    if let Some(sink) = SINK.lock().unwrap().as_mut() {
        sink.echo = false;
    }
}

/// Whether a variable or setting by this name holds a secret: a key, token, password or credential.
pub fn secret_name(name: &str) -> bool {
    static SECRET: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)(api[_-]?key|_key$|token|secret|passw|credential|auth)").unwrap());
    SECRET.is_match(name)
}

/// `text` with every credential it may carry replaced by `[redacted]`. Every line the log writes passes through here,
/// so a key typed into the command bar, passed as an argument or handed to a tool never reaches the terminal or the file.
pub fn redact(text: &str) -> String {
    static PATTERNS: LazyLock<Vec<(regex::Regex, &str)>> = LazyLock::new(|| {
        [
            // NAME=VALUE where the name is a secret's, as `env set` and launcher.env write them.
            (r"(?i)\b([A-Z0-9_]*(?:API_?KEY|_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*)=\S+", "$1=[redacted]"),
            // JSON members such as "api_key": "...", in tool arguments.
            (r#"(?i)"([a-z0-9_]*(?:api_?key|_key|token|secret|password|credentials?))"\s*:\s*"[^"]*""#, r#""$1": "[redacted]""#),
            // The console command that keeps a key.
            (r"(?i)\b(model\s+key)\s+\S+", "$1 [redacted]"),
            // HTTP credentials.
            (r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", "$1 [redacted]"),
            (r"(?i)\b(x-api-key|api-key|authorization)(\s*[:=]\s*)\S+", "$1$2[redacted]"),
            // A user and password in an address.
            (r"://[^/\s:@]+:[^/\s@]+@", "://[redacted]@"),
            // Key shapes the providers DSTNS talks to issue.
            (r"\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{16,})", "[redacted]"),
        ]
        .into_iter()
        .map(|(pattern, with)| (regex::Regex::new(pattern).unwrap(), with))
        .collect()
    });
    let mut out = text.to_string();
    // Whatever shape a key has, the exact value of a secret variable in this process is never written.
    for (name, value) in std::env::vars() {
        if value.len() >= 8 && secret_name(&name) && out.contains(&value) {
            out = out.replace(&value, "[redacted]");
        }
    }
    for (pattern, with) in PATTERNS.iter() {
        out = pattern.replace_all(&out, *with).into_owned();
    }
    out
}

fn write(level: &str, message: &str) {
    let message = &redact(message);
    let mut guard = SINK.lock().unwrap();
    let Some(sink) = guard.as_mut() else { return };
    if level == "DEBUG" && !sink.debug {
        return;
    }
    if sink.echo {
        eprintln!("[{}] {message}", level.to_lowercase());
    }
    if sink.failed {
        return;
    }
    let line = format!("{} {level} {message}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S,%3f"));
    let result = (|| -> std::io::Result<()> {
        if sink.file.is_none() {
            if let Some(parent) = sink.path.parent() {
                fs::create_dir_all(parent)?;
            }
            sink.file = Some(OpenOptions::new().create(true).append(true).open(&sink.path)?);
        }
        if fs::metadata(&sink.path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > MAX_BYTES {
            sink.file = None;
            for n in (1..BACKUPS).rev() {
                let _ = fs::rename(format!("{}.{n}", sink.path.display()), format!("{}.{}", sink.path.display(), n + 1));
            }
            let _ = fs::rename(&sink.path, format!("{}.1", sink.path.display()));
            sink.file = Some(OpenOptions::new().create(true).append(true).open(&sink.path)?);
        }
        sink.file.as_mut().unwrap().write_all(line.as_bytes())
    })();
    if result.is_err() {
        sink.failed = true;
        sink.file = None;
    }
}

pub fn info(message: &str) {
    write("INFO", message);
}
pub fn warn(message: &str) {
    write("WARNING", message);
}
pub fn error(message: &str) {
    write("ERROR", message);
}
pub fn debug(message: &str) {
    write("DEBUG", message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_never_survive_redaction() {
        let cases = [
            ("command bar: model key gsk_abcdefghijklmnopqrstuvwx", "gsk_abcdef"),
            ("command bar: env set DSTNS_OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstu", "sk-proj-abc"),
            ("arguments: console env set MY_TOKEN=hunter2hunter2", "hunter2"),
            (r#"mcp: set {"api_key": "plain-value-123", "key": "model.name"}"#, "plain-value-123"),
            ("request header Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"),
            ("x-api-key: sk-ant-api03-abcdefghij", "abcdefghij"),
            ("ollama at http://me:pa55word@10.0.0.2:11434", "pa55word"),
            ("gemini AIzaSyA-abcdefghijklmnopqrstuvwxyz0123456 failed", "abcdefghijklmnop"),
            ("hf hf_abcdefghijklmnopqrstuvwxyz", "hf_abcdefghijklmnop"),
        ];
        for (line, secret) in cases {
            let out = redact(line);
            assert!(!out.contains(secret), "{line:?} became {out:?}");
            assert!(out.contains("[redacted]"), "{line:?} became {out:?}");
        }
    }

    #[test]
    fn ordinary_diagnostics_are_kept() {
        for line in [
            r#"mcp: set_setting {"key": "playback.speed", "value": 2}"#,
            "settings: model.provider from auto to groq",
            "server on port 8090 stopped: true",
            "step: Build the engine",
        ] {
            assert_eq!(redact(line), line);
        }
        assert!(secret_name("DSTNS_GROQ_API_KEY") && secret_name("GROQ_API_KEY") && secret_name("HF_TOKEN"));
        assert!(!secret_name("DSTNS_SEED") && !secret_name("model.provider") && !secret_name("keyboard"));
    }

    #[test]
    fn a_secret_variable_never_reaches_the_file() {
        let dir = std::env::temp_dir().join(format!("dstns-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paths = Paths::new(&dir);
        // An odd shape on purpose: no pattern knows it, only the variable's value does.
        std::env::set_var("DSTNS_TEST_SERVICE_TOKEN", "zz9-plural-z-alpha");
        configure(&paths, true, false);
        info("asked with zz9-plural-z-alpha in the request");
        debug("command bar: model key gsk_abcdefghijklmnopqrstuvwx");
        let written = fs::read_to_string(paths.launcher_log()).unwrap();
        std::env::remove_var("DSTNS_TEST_SERVICE_TOKEN");
        let _ = fs::remove_dir_all(&dir);
        assert!(written.contains("asked with [redacted] in the request"), "{written}");
        assert!(!written.contains("zz9-plural") && !written.contains("gsk_abc"), "{written}");
    }
}
