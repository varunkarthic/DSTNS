// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launcher's own model, and what it does: a request in plain words, turned into the console's commands.
//!
//! Which model: `model.provider` says, and CoreAI (the root CoreAI/ crate) asks it. `auto` uses Apple's Foundation
//! Models where the framework says this Mac has one; else a model server on this machine (Ollama, LM Studio); else each
//! cloud provider that has a key (`model key PROVIDER KEY`), in turn, until one answers. Naming a provider insists on
//! it; `off` turns it off. `model.name` and `model.base_url` apply to the provider named.
//!
//! A suggestion is never run by itself. It is checked first, as a console line: only commands that exist, joined by
//! `&&` or `|`; nothing that leaves, resets, runs a shell, edits files or changes Advanced Security; and a warning for
//! anything that stops or deletes. Then it is put on the prompt, for a person to run with Enter, or not.

use crate::config;
use crate::paths::Paths;
use std::time::Duration;

pub use coreai::apple::AppleModels;

/// The launcher's model settings, as CoreAI takes them.
pub fn settings(paths: &Paths) -> Result<coreai::Settings, String> {
    let config = config::load(paths).map_err(|e| e.message)?;
    let text = |key: &str| config::setting(&config, key).as_str().unwrap_or("").trim().to_string();
    let unless_default = |value: String| if value == "default" { String::new() } else { value };
    Ok(coreai::Settings {
        provider: text("model.provider"),
        model: unless_default(text("model.name")),
        base_url: unless_default(text("model.base_url")),
        ollama_url: text("model.ollama_url"),
        apple_cloud: config::flag(&config, "model.apple_cloud"),
        key_store: if text("model.key_store") == "system" { coreai::KeyStore::System } else { coreai::KeyStore::Env },
        local_only: false,
        timeout: Duration::from_secs(config::setting(&config, "model.timeout_seconds").as_u64().unwrap_or(60).clamp(5, 600)),
        cache_dir: paths.build(),
    })
}

/// CoreAI's service for the rest of DSTNS (the engine's news, the observer), started on first use and kept for the
/// launcher's life. It reads the settings on every request, so a change applies at once.
pub fn service(paths: &Paths) -> Result<coreai::serve::Service, String> {
    static SERVICE: std::sync::OnceLock<Result<coreai::serve::Service, String>> = std::sync::OnceLock::new();
    SERVICE
        .get_or_init(|| {
            let paths = paths.clone();
            let source: coreai::serve::SettingsSource = std::sync::Arc::new(move || settings(&paths).unwrap_or_default());
            let started = coreai::serve::start(source, None).map_err(|e| format!("CoreAI's service could not start: {e}"));
            if let Ok(service) = &started {
                crate::log::info(&format!("coreai: serving on 127.0.0.1:{}", service.port));
            }
            started
        })
        .clone()
}

pub fn apple_models(paths: &Paths) -> AppleModels {
    coreai::apple::models(&paths.build())
}

/// The model the settings choose: the first CoreAI would ask.
pub fn resolve(paths: &Paths) -> Result<coreai::Target, String> {
    let settings = settings(paths)?;
    coreai::resolve(&settings).map(|mut found| found.remove(0)).map_err(|e| e.to_string())
}

/// One answer, to `prompt`, following `instructions`, from whichever model answers first; and who wrote it.
pub fn ask(paths: &Paths, instructions: &str, prompt: &str) -> Result<(String, coreai::Provenance), String> {
    let settings = settings(paths)?;
    let request = coreai::Request { temperature: Some(0.0), ..coreai::Request::new(instructions, prompt) };
    coreai::complete(&settings, &request, None).map(|reply| (reply.text, reply.provenance)).map_err(|e| e.to_string())
}

/// How a reply's writer is named on screen.
pub fn label(provenance: &coreai::Provenance) -> String {
    match (provenance.provider.as_str(), provenance.model.as_str()) {
        ("apple", "pcc") => "Apple Foundation Models, through Private Cloud Compute".into(),
        ("apple", _) => "Apple Foundation Models, on this Mac".into(),
        (_, model) => format!("{model} through {}", provenance.provider_label),
    }
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
    if resolve(paths).is_err() {
        let mut lines = vec!["No model, so here is what the knowledge graph has:".to_string()];
        lines.extend(found);
        return Ok((lines, "the knowledge graph".into()));
    }
    let instructions = "You answer questions about DSTNS, a deterministic traffic simulator, for someone at its launcher. \
        Use only the facts given. Answer in at most four short sentences of plain words, naming files as path:line. \
        If the facts do not answer the question, say so, and suggest graph show NAME or graph search WORDS to look further. \
        Do not invent names, files or numbers.";
    let prompt = format!("{question}\n\nFacts from DSTNS's knowledge graph:\n{}", graph.facts(question).join("\n"));
    match ask(paths, instructions, &prompt) {
        Ok((text, provenance)) => {
            let mut lines: Vec<String> = text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
            lines.push(String::new());
            lines.push("From the knowledge graph:".into());
            lines.extend(found.into_iter().skip_while(|l| l.starts_with("Read as")).take(6));
            Ok((lines, label(&provenance)))
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
        Ok((suggestion, by)) => Ok((Reply::Command(suggestion), by)),
        Err(why) => match answer(paths, request) {
            Ok((lines, by)) if why.contains("did not find a command") => Ok((Reply::Answer(lines), by)),
            _ => Err(why),
        },
    }
}

/// A request in plain words, as a checked line of commands.
pub fn suggest(paths: &Paths, request: &str) -> Result<(Suggestion, String), String> {
    crate::log::info(&format!("assistant: asking about: {request}"));
    let (answer, provenance) = ask(paths, &instructions(), request)?;
    crate::log::info(&format!("assistant: {} answered: {answer}", label(&provenance)));
    check(&answer).map(|s| (s, label(&provenance)))
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
