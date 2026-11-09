// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launcher's own model, and what it does: a request in plain words, turned into the console's commands.
//!
//! Which model: `model.provider` says. `auto` uses Apple's Foundation Models where the framework says this Mac has one
//! (on the Mac first, then Private Cloud Compute if `model.apple_cloud` allows it); else Ollama, if it answers; else Groq, if a key is kept (`model key`). `apple`,
//! `ollama` and `groq` insist on one; `off` turns it off. `model.name` chooses the model, for Ollama and Groq.
//!
//! A suggestion is never run by itself. It is checked first, as a console line: only commands that exist, joined by
//! `&&` or `|`; nothing that leaves, resets, runs a shell, edits files or changes Advanced Security; and a warning for
//! anything that stops or deletes. Then it is put on the prompt, for a person to run with Enter, or not.

use crate::config;
use crate::paths::Paths;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const GROQ_KEY: &str = "DSTNS_GROQ_API_KEY";
const GROQ_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT: &str = "llama-3.3-70b-versatile";
const OLLAMA_DEFAULT: &str = "llama3.2";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Provider {
    Apple,
    Ollama,
    Groq,
}

#[derive(Clone, Debug)]
pub struct Model {
    pub provider: Provider,
    pub name: String,
    pub url: String,
}

impl Model {
    pub fn label(&self) -> String {
        match self.provider {
            Provider::Apple if self.name == "pcc" => "Apple Foundation Models, through Private Cloud Compute".into(),
            Provider::Apple => "Apple Foundation Models, on this Mac".into(),
            Provider::Ollama => format!("{} through Ollama ({})", self.name, self.url),
            Provider::Groq => format!("{} through Groq", self.name),
        }
    }
}

const MODELS_SWIFT: &str = include_str!("../assets/models.swift");

/// Apple's two models and whether each can answer here, as the Foundation Models framework reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppleModels {
    /// The model on this Mac: Ok, or why not, in plain words.
    pub system: Result<(), String>,
    /// Apple's larger model through Private Cloud Compute.
    pub cloud: Result<(), String>,
}

/// Asks the framework through a small Swift helper, built on first use. The `fm` tool is not asked: its `available`
/// command was renamed `models`, and either one fails as a whole when only Private Cloud Compute is missing.
pub fn apple_models(paths: &Paths) -> AppleModels {
    let none = |why: &str| AppleModels { system: Err(why.into()), cloud: Err(why.into()) };
    if !cfg!(target_os = "macos") || !cfg!(target_arch = "aarch64") {
        return none("Apple's models need a Mac with Apple silicon.");
    }
    // Built for macOS 26, where the framework first appears; the Private Cloud Compute check runs only on 27 and later.
    let Some(helper) = crate::security::swift_program(paths, "dstns-models", MODELS_SWIFT, &["-target", "arm64-apple-macos26.0"]) else {
        return none("Apple's models could not be checked: the Swift compiler is missing (xcode-select --install).");
    };
    let output = match Command::new(helper).stdin(Stdio::null()).stderr(Stdio::null()).output() {
        Ok(output) if output.status.success() => output.stdout,
        _ => return none("Apple's models could not be checked: this macOS has no Foundation Models (macOS 26 or later)."),
    };
    let report: Value = serde_json::from_slice(&output).unwrap_or(Value::Null);
    AppleModels { system: apple_state(&report["system"]), cloud: apple_state(&report["pcc"]) }
}

/// "available", or "unavailable:REASON" with the framework's own reason, in plain words.
fn apple_state(state: &Value) -> Result<(), String> {
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

/// The Apple model to use, by the settings, or why there is none.
fn apple_model(paths: &Paths, cloud_allowed: bool) -> Result<Model, String> {
    let models = apple_models(paths);
    let apple = |name: &str| Model { provider: Provider::Apple, name: name.into(), url: String::new() };
    match (&models.system, &models.cloud) {
        (Ok(()), _) => Ok(apple("system")),
        (Err(_), Ok(())) if cloud_allowed => Ok(apple("pcc")),
        (Err(why), Ok(())) => Err(format!("Apple's model on this Mac is not available: {why}. Private Cloud Compute is, but model.apple_cloud is off.")),
        (Err(why), Err(cloud)) => Err(format!("Apple's model on this Mac is not available: {why}. Private Cloud Compute: {cloud}.")),
    }
}

fn ollama_answers(url: &str) -> bool {
    crate::api::agent(Duration::from_millis(800)).get(&format!("{}/api/tags", url.trim_end_matches('/'))).call().map(|r| r.status().is_success()).unwrap_or(false)
}

fn groq_key() -> Option<String> {
    std::env::var(GROQ_KEY).ok().or_else(|| std::env::var("GROQ_API_KEY").ok()).filter(|k| !k.trim().is_empty())
}

/// The model to use, by the settings, or why there is none.
pub fn resolve(paths: &Paths) -> Result<Model, String> {
    let settings = config::load(paths).map_err(|e| e.message)?;
    let provider = config::setting(&settings, "model.provider").as_str().unwrap_or("auto").to_string();
    let name = config::setting(&settings, "model.name").as_str().unwrap_or("").trim().to_string();
    let name = if name == "default" { String::new() } else { name };
    let url = config::setting(&settings, "model.ollama_url").as_str().unwrap_or("http://127.0.0.1:11434").trim_end_matches('/').to_string();
    let ollama = |name: &str| Model { provider: Provider::Ollama, name: if name.is_empty() { OLLAMA_DEFAULT.into() } else { name.into() }, url: url.clone() };
    let groq = |name: &str| Model { provider: Provider::Groq, name: if name.is_empty() { GROQ_DEFAULT.into() } else { name.into() }, url: GROQ_URL.into() };
    let apple = || apple_model(paths, config::flag(&settings, "model.apple_cloud"));
    match provider.as_str() {
        "off" => Err("The model is off: set model.provider to auto, apple, ollama or groq.".into()),
        "apple" => apple(),
        "ollama" if ollama_answers(&url) => Ok(ollama(&name)),
        "ollama" => Err(format!("Ollama does not answer at {url}. Start it, or set model.ollama_url.")),
        "groq" if groq_key().is_some() => Ok(groq(&name)),
        "groq" => Err(format!("Groq needs a key: model key KEY keeps one in config/launcher.env as {GROQ_KEY}.")),
        _ => apple().or_else(|_| match () {
            _ if ollama_answers(&url) => Ok(ollama(&name)),
            _ if groq_key().is_some() => Ok(groq(&name)),
            _ => Err("No model: Apple's Foundation Models are not here, Ollama does not answer, and no Groq key is kept (model key KEY).".into()),
        }),
    }
}

/// One answer, to `prompt`, following `instructions`.
pub fn ask(model: &Model, instructions: &str, prompt: &str) -> Result<String, String> {
    match model.provider {
        Provider::Apple => {
            let output = Command::new("fm")
                .args(["respond", "--no-stream", "--greedy", "-m", &model.name, "-i", instructions, prompt])
                .env("NO_COLOR", "1")
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("fm: {e}"))?;
            if !output.status.success() {
                return Err(format!("Apple's model did not answer: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
            Ok(strip_ansi(&String::from_utf8_lossy(&output.stdout)).trim().to_string())
        }
        Provider::Ollama => {
            let body = json!({"model": model.name, "stream": false, "options": {"temperature": 0}, "messages": [{"role": "system", "content": instructions}, {"role": "user", "content": prompt}]});
            let reply: Value = crate::api::agent(Duration::from_secs(90))
                .post(&format!("{}/api/chat", model.url))
                .send_json(&body)
                .map_err(|e| format!("Ollama: {e}"))?
                .body_mut()
                .read_json()
                .map_err(|e| format!("Ollama: {e}"))?;
            reply["message"]["content"].as_str().map(|s| s.trim().to_string()).ok_or_else(|| format!("Ollama did not answer: {}", reply["error"].as_str().unwrap_or("no message")))
        }
        Provider::Groq => {
            let key = groq_key().ok_or("No Groq key is kept.")?;
            let body = json!({"model": model.name, "temperature": 0, "messages": [{"role": "system", "content": instructions}, {"role": "user", "content": prompt}]});
            let reply: Value = crate::api::agent(Duration::from_secs(60))
                .post(GROQ_URL)
                .header("Authorization", &format!("Bearer {key}"))
                .send_json(&body)
                .map_err(|e| format!("Groq: {e}"))?
                .body_mut()
                .read_json()
                .map_err(|e| format!("Groq: {e}"))?;
            reply["choices"][0]["message"]["content"].as_str().map(|s| s.trim().to_string()).ok_or_else(|| format!("Groq did not answer: {}", reply["error"]["message"].as_str().unwrap_or("no message")))
        }
    }
}

fn strip_ansi(text: &str) -> String {
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

/// Commands as they are typed, and what each does: what the model chooses from. Written out, not generated from the
/// usage lines, whose [ ] and | for alternatives a model copies literally.
const CATALOGUE: &[(&str, &str)] = &[
    ("ps", "what is running: the server, the simulation and applications"),
    ("ps -a", "every DSTNS server, download and launcher on this machine"),
    ("uptime", "how long the server has been up, its state and memory"),
    ("logs api", "the API log as a table; also logs system, logs event, logs playback"),
    ("tail -n 50 logs/system", "the last lines of the system log"),
    ("json settings .startup", "settings as JSON, or one part of them"),
    ("json status", "the simulation's state, clock and seed, from the server"),
    ("json world", "world generation"),
    ("json next-world .city", "the city Dynamic Fastboot has ready next"),
    ("json daemons", "the daemons and their queues"),
    ("get api.port", "one setting"),
    ("set startup.fast_boot on", "change one setting"),
    ("unset startup.fast_boot", "a setting back to its default"),
    ("start --seed 42", "start a simulation; also --day-type weekend, --speed 2, --osm-file FILE, --apps IDS"),
    ("stop", "stop the server and the applications"),
    ("pause", "pause the simulation"),
    ("resume", "resume it"),
    ("restart", "back to the start of the day, same world"),
    ("open", "open the observer in the browser"),
    ("fastboot status", "how many cities Fast Boot has downloaded"),
    ("fastboot download", "download every city for Fast Boot"),
    ("apps list", "the applications this launcher can start"),
    ("seeds list", "saved seeds"),
    ("daemon", "the daemons inside the server"),
    ("daemon show rcs", "the Resource Control Subsystem's readings: each module's memory and processor"),
    ("daemon queue emergency", "the alerts and emergencies the daemons have raised"),
    ("model", "which model answers these requests"),
    ("mcp tools", "what an AI client could call"),
    ("test unit", "run the unit tests"),
    ("api GET /api/v1/system/info", "any route on the server"),
    ("about", "version, licence and attribution"),
    ("docs mcp", "open the documentation on a topic"),
];

/// What the model is told: the commands there are, and how to answer.
fn instructions() -> String {
    let mut out = String::from(
        "You turn a request into a line of commands for the DSTNS launcher's console. Reply with that one line and nothing else:          no explanation, no quotes, no backticks, no prompt sign, no descriptions. Join commands with && when one should run after          another, and with | to filter what one prints, using grep -i WORD, wc -l, head -n N, tail -n N, sort, uniq -c.          Use only these commands, changing their values to fit:\n",
    );
    for (line, what) in CATALOGUE {
        out.push_str(&format!("{line}    ({what})\n"));
    }
    out.push_str(
        "\nExamples of a request, then the line to reply with:\n\
         show the errors in the api log => logs api | grep -i error\n\
         how many cities does fast boot have => fastboot status\n\
         stop and start again with seed 42 => stop && start --seed 42\n\
         is the engine using too much memory => daemon show rcs\n\
         turn fast boot on => set startup.fast_boot on\n\
         count the warnings in the system log => tail -n 1000 logs/system | grep -i warn | wc -l\n\
         \nIf no command does what is asked, reply NONE.",
    );
    out
}

/// A line the model suggested, checked: what it is, and what a person should know before running it.
#[derive(Clone, Debug, PartialEq)]
pub struct Suggestion {
    pub line: String,
    pub warnings: Vec<String>,
}

/// Every name a line may start a command with.
fn known(name: &str) -> bool {
    crate::tui::shell::COMMANDS.iter().any(|(n, _, _)| *n == name) || crate::console::is_builtin(name) || crate::cli::COMMANDS.contains(&name) || crate::modules::find(name).is_some()
}

/// Check a suggested line before anyone can run it. Err says why it was refused.
pub fn check(answer: &str) -> Result<Suggestion, String> {
    // The line, whatever the model wrapped it in.
    let line = answer
        .lines()
        .map(|l| l.trim().trim_matches('`').trim())
        .find(|l| !l.is_empty() && !l.starts_with("```"))
        .unwrap_or("")
        .trim_start_matches("$ ")
        .trim_start_matches("> ")
        .trim_start_matches("./launcher ")
        .trim()
        .to_string();
    // A description it copied, after the line, and the catalogue's parentheses.
    let line = line.split("    (").next().unwrap_or("").split(" — ").next().unwrap_or("").split(" => ").last().unwrap_or("").replace(['[', ']'], "").trim().to_string();
    if line.is_empty() || line.eq_ignore_ascii_case("none") {
        return Err("The model did not find a command for that.".into());
    }
    if line.contains('`') || line.contains("$(") || line.contains('>') || line.contains('<') || line.contains('\n') {
        return Err(format!("Refused: {line} (substitution or redirection)"));
    }
    let parts = crate::console::split(&line).ok_or_else(|| format!("Refused: {line} (a quotation mark is not closed)"))?;
    let mut warnings = vec![];
    for (join, words) in &parts {
        if matches!(join, crate::console::Join::Then | crate::console::Join::Or) {
            return Err(format!("Refused: {line} (only && and | may join commands)"));
        }
        let Some(name) = words.first().map(String::as_str) else { return Err(format!("Refused: {line} (a command is missing)")) };
        if !known(name) {
            return Err(format!("Refused: {line} ({name} is not a command here)"));
        }
        let sub = words.get(1).map(String::as_str).unwrap_or("");
        // Nothing that leaves, resets, opens a shell, edits files, writes them, or changes Advanced Security.
        let forbidden = matches!(name, "exit" | "quit" | "logout" | "reset" | "shell" | "sh" | "console" | "edit" | "tee" | "security" | "setup")
            || words.iter().any(|w| w == "-c" || w.contains(crate::security::KEY))
            || (name == "env" && !sub.is_empty());
        if forbidden {
            return Err(format!("Refused: {line} ({name} is not something a suggestion may do)"));
        }
        let what = words.join(" ");
        if matches!(name, "stop" | "kill") || (name == "fastboot" && sub == "clear") || (name == "apps" && sub == "remove") || (name == "seeds" && sub == "delete") {
            warnings.push(format!("{what} stops or deletes something."));
        } else if matches!(name, "set" | "unset") || (name == "config" && sub == "set") {
            warnings.push(format!("{what} changes a setting."));
        } else if name == "start" {
            warnings.push(format!("{what} starts a simulation."));
        }
    }
    Ok(Suggestion { line, warnings })
}

/// What the launcher says back to something typed in plain words: a line of commands to run, or an answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    Command(Suggestion),
    /// Lines of an answer: the model's words, then what in the graph they come from.
    Answer(Vec<String>),
}

/// A question rather than something to do: who, what, where, how, why, or anything that ends in a question mark.
pub fn is_question(text: &str) -> bool {
    let first = text.split_whitespace().next().unwrap_or("").to_lowercase();
    text.trim_end().ends_with('?') || matches!(first.as_str(), "who" | "what" | "where" | "which" | "how" | "why" | "when" | "explain" | "describe" | "does" | "is" | "are" | "can")
}

/// A question answered from the knowledge graph: in the model's words where there is a model, kept to what the graph
/// says; otherwise the graph's own matches. Either way, each answer says where in the source it comes from.
pub fn answer(paths: &Paths, question: &str) -> Result<(Vec<String>, String), String> {
    let graph = crate::graph::load(paths)?;
    let found = crate::graph::answer(graph, question, 8);
    let Ok(model) = resolve(paths) else {
        let mut lines = vec!["No model, so here is what the knowledge graph has:".to_string()];
        lines.extend(found);
        return Ok((lines, "the knowledge graph".into()));
    };
    let instructions = "You answer questions about DSTNS, a deterministic traffic simulator, for someone at its launcher. \
        Use only the facts given. Answer in at most four short sentences of plain words, naming files as path:line. \
        If the facts do not answer the question, say so, and suggest graph show NAME or graph search WORDS to look further. \
        Do not invent names, files or numbers.";
    let prompt = format!("{question}\n\nFacts from DSTNS's knowledge graph:\n{}", graph.facts(question).join("\n"));
    match ask(&model, instructions, &prompt) {
        Ok(text) => {
            let mut lines: Vec<String> = text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
            lines.push(String::new());
            lines.push("From the knowledge graph:".into());
            lines.extend(found.into_iter().skip_while(|l| l.starts_with("Read as")).take(6));
            Ok((lines, model.label()))
        }
        Err(problem) => {
            let mut lines = vec![format!("The model did not answer ({problem}), so here is what the knowledge graph has:")];
            lines.extend(found);
            Ok((lines, "the knowledge graph".into()))
        }
    }
}

/// Something typed in plain words: a question is answered, anything else becomes a checked line of commands; a request
/// no command does is answered from the graph instead, if it can be.
pub fn respond(paths: &Paths, request: &str) -> Result<(Reply, String), String> {
    if is_question(request) {
        if let Ok((lines, by)) = answer(paths, request) {
            return Ok((Reply::Answer(lines), by));
        }
    }
    match suggest(paths, request) {
        Ok((suggestion, model)) => Ok((Reply::Command(suggestion), model.label())),
        Err(why) => match answer(paths, request) {
            Ok((lines, by)) if why.contains("did not find a command") => Ok((Reply::Answer(lines), by)),
            _ => Err(why),
        },
    }
}

/// A request in plain words, as a checked line of commands.
pub fn suggest(paths: &Paths, request: &str) -> Result<(Suggestion, Model), String> {
    let model = resolve(paths)?;
    crate::log::info(&format!("assistant: asking {} about: {request}", model.label()));
    let answer = ask(&model, &instructions(), request)?;
    crate::log::info(&format!("assistant: it answered: {answer}"));
    check(&answer).map(|s| (s, model))
}

/// Whether a line typed at the prompt is a request in words rather than a command: its first word is not one. `ask …`
/// and `? …` always are.
pub fn is_request(line: &str) -> bool {
    let first = line.split_whitespace().next().unwrap_or("");
    line.split_whitespace().count() >= 2 && !known(first) && !first.starts_with('-') && !first.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apple_states_read_as_the_framework_reports_them() {
        assert_eq!(apple_state(&json!("available")), Ok(()));
        assert!(apple_state(&json!("unavailable:appleIntelligenceNotEnabled")).unwrap_err().contains("System Settings"));
        assert!(apple_state(&json!("unavailable:modelNotReady")).unwrap_err().contains("downloaded"));
        assert!(apple_state(&json!("unavailable:somethingNew")).unwrap_err().contains("somethingNew"));
        // Anything else, or nothing at all, is never read as available.
        for odd in [json!(null), json!(true), json!("Available"), json!("available "), json!("")] {
            assert!(apple_state(&odd).is_err(), "{odd}");
        }
    }

    #[test]
    #[ignore = "needs a Mac with Apple silicon and the Swift compiler"]
    fn the_framework_is_asked_on_this_mac() {
        let dir = std::env::temp_dir().join(format!("dstns-models-test-{}", std::process::id()));
        let models = apple_models(&Paths::new(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!format!("{models:?}").contains("could not be checked"), "{models:?}");
    }

    #[test]
    fn a_suggestion_is_checked_before_it_is_offered() {
        let ok = check("logs api | grep 500").unwrap();
        assert_eq!(ok.line, "logs api | grep 500");
        assert!(ok.warnings.is_empty());
        let wrapped = check("```\n$ ./launcher stop && start --seed 42\n```").unwrap();
        assert_eq!(wrapped.line, "stop && start --seed 42", "whatever the model wrapped it in");
        assert_eq!(wrapped.warnings.len(), 2, "stopping and starting are said out loud");
        for refused in ["NONE", "", "stop; reset", "ps || exit", "rm -rf data", "ps > out.txt", "echo $(whoami)", "edit settings", "security off", "set security.advanced off", "ps | tee x", "shell", "-c 'stop'", "env set X=1", "ps && quit"] {
            assert!(check(refused).is_err(), "{refused} is refused");
        }
        assert!(check("fastboot clear").unwrap().warnings[0].contains("deletes"));
    }

    #[test]
    fn words_are_a_request_and_commands_are_not() {
        assert!(is_request("show me the slowest roads"));
        assert!(!is_request("restart the simulation"), "a line that starts with a command is that command: ask, or ?, says it is a request");
        assert!(!is_request("ps"));
        assert!(!is_request("logs api | grep 500"));
        assert!(!is_request("json settings .api"));
    }
}
