// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launch code: the launcher's state as one code, uppercase hexadecimal, that another launcher takes to become the
//! same, and with `./launcher launch CODE` to carry straight on from where this one was.
//!
//! `launch-code` (or `state get`) prints it, `state set CODE` applies it, `./launcher --state CODE` applies it before
//! anything else, and `./launcher launch CODE` applies it and starts.
//! It carries every setting that differs from its default, so a launcher given it ends with exactly these settings,
//! except those that hold a credential or an address (API keys, tokens, model addresses), which stay as they are on
//! each machine and are never put in a code. API keys are not settings at all and never leave.
//!
//! `state get --world` adds the world: its seed, day type and map rules, and the moment of the day it is at. DSTNS is
//! deterministic, so these make the same world again; the next start runs it and jumps to that moment, once. What an
//! operator did to the world by hand (a road closed, a storm started) is not carried.
//!
//! `--world` also carries whether it was playing and how fast, and the operator's own changes (signals switched,
//! roads closed or slowed, rain added, modules turned off or on), each with the moment it was made. A launch replays
//! them at those moments on the way to the copied one, so the world arrives in the same state; the checkpoints are
//! rebuilt along the way, as DSTNS is deterministic. A demand surge is not yet recorded as a change, so it is not
//! carried.
//!
//! `--keys` adds the API keys from config/launcher.env, encrypted with a passphrase: a code is meant to be pasted
//! around, and keys in it must not be readable by whoever sees it. The passphrase is asked for when the code is made
//! and when it is used (or read from DSTNS_LAUNCH_PASSPHRASE). PBKDF2-HMAC-SHA256 (210,000 rounds) derives the keys;
//! the keys are enciphered with HMAC-SHA256 in counter mode and authenticated with HMAC-SHA256, encrypt-then-MAC.
//!
//! The code is a version byte, the state as deflated JSON, and the first four bytes of its SHA-256, so a code cut
//! short or mistyped is refused rather than half applied.

use crate::config::{self, fields};
use crate::paths::Paths;
use serde_json::{json, Map, Value};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

const VERSION: u8 = 2;
/// Older codes, read as before: settings and a world's seed and moment.
const READS: [u8; 2] = [1, 2];
/// A copied world's way back, for the next start: its moment, play state and the operator's changes in order.
const PENDING_FILE: &str = ".launch-pending.json";
/// Changes an operator made that a copy of the world can make again, and the route each takes.
const REPLAYABLE: [&str; 4] = ["signal_toggle", "edge_override", "manual_weather", "module"];
const ROUNDS: u32 = 210_000;
/// Where a world's moment waits for the next start, in config/launcher.env: SEED@SECONDS.
pub const PENDING_JUMP: &str = "DSTNS_STATE_JUMP";

/// The map rules a world is made by here: the selection policy its settings name.
fn maps(config: &Value) -> Value {
    json!(config::map_selection(config).map(|(version, _)| version).unwrap_or_else(|_| config::GEO_SELECTION_VERSION.into()))
}

/// A setting that travels in a code: anything but a credential or an address that may carry one.
fn portable(key: &str) -> bool {
    !config::sensitive_setting(key)
}

pub fn encode(state: &Value) -> String {
    let mut deflated = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    deflated.write_all(state.to_string().as_bytes()).expect("in memory");
    let mut body = vec![VERSION];
    body.extend(deflated.finish().expect("in memory"));
    let check = Sha256::digest(&body);
    body.extend_from_slice(&check[..4]);
    body.iter().map(|b| format!("{b:02X}")).collect()
}

pub fn decode(code: &str) -> Result<Value, String> {
    // Spaces, dashes and line breaks a person or a mail program added are ignored, and so is case.
    let digits: String = code.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    if digits.is_empty() || digits.len() % 2 != 0 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("That is not a launcher state code: it should be hexadecimal digits, as state get prints them.".into());
    }
    let bytes: Vec<u8> = (0..digits.len()).step_by(2).map(|i| u8::from_str_radix(&digits[i..i + 2], 16).unwrap()).collect();
    if bytes.len() < 6 {
        return Err("That code is too short to be a launcher state.".into());
    }
    let (body, check) = bytes.split_at(bytes.len() - 4);
    if Sha256::digest(body)[..4] != *check {
        return Err("That code does not check out: part of it is missing or mistyped. Copy it again, whole.".into());
    }
    if !READS.contains(&body[0]) {
        return Err(format!("That code is from a launcher of another kind (version {}); this one reads version {VERSION}.", body[0]));
    }
    let mut text = String::new();
    flate2::read::DeflateDecoder::new(&body[1..]).take(1 << 20).read_to_string(&mut text).map_err(|_| "That code could not be unpacked.".to_string())?;
    serde_json::from_str(&text).map_err(|_| "That code could not be read.".into())
}

// ---- Keys, sealed with a passphrase --------------------------------------------------------------------------------

/// HMAC-SHA256, from the RustCrypto `hmac` crate.
fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// PBKDF2-HMAC-SHA256 (RFC 8018), from the RustCrypto `pbkdf2` crate: 64 bytes, one key to encipher with and one to
/// authenticate with. The same bytes as before it used the crate, so codes made earlier still open.
fn derive(passphrase: &str, salt: &[u8]) -> ([u8; 32], [u8; 32]) {
    let mut out = [0u8; 64];
    pbkdf2::pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, ROUNDS, &mut out);
    let (cipher, mac) = out.split_at(32);
    (cipher.try_into().unwrap(), mac.try_into().unwrap())
}

fn keystream(key: &[u8; 32], nonce: &[u8], length: usize) -> Vec<u8> {
    (0..length.div_ceil(32) as u32).flat_map(|i| hmac(key, &[nonce, &i.to_be_bytes()].concat())).take(length).collect()
}

/// The keys, sealed: salt, nonce, the enciphered JSON, and its tag, as hexadecimal.
pub fn seal_keys(keys: &Map<String, Value>, passphrase: &str) -> String {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut salt).expect("the system's random source");
    getrandom::fill(&mut nonce).expect("the system's random source");
    let (cipher, mac) = derive(passphrase, &salt);
    let plain = Value::Object(keys.clone()).to_string().into_bytes();
    let sealed: Vec<u8> = plain.iter().zip(keystream(&cipher, &nonce, plain.len())).map(|(p, k)| p ^ k).collect();
    let tag = hmac(&mac, &[&nonce[..], &sealed].concat());
    [&salt[..], &nonce, &sealed, &tag].concat().iter().map(|b| format!("{b:02x}")).collect()
}

/// The keys back, if the passphrase is the one they were sealed with and nothing was changed.
pub fn open_keys(sealed: &str, passphrase: &str) -> Result<Map<String, Value>, String> {
    let bytes: Vec<u8> = (0..sealed.len() / 2).filter_map(|i| u8::from_str_radix(sealed.get(i * 2..i * 2 + 2)?, 16).ok()).collect();
    if bytes.len() < 64 {
        return Err("The code's keys are damaged.".into());
    }
    let (salt, rest) = bytes.split_at(16);
    let (nonce, rest) = rest.split_at(16);
    let (body, tag) = rest.split_at(rest.len() - 32);
    let (cipher, mac) = derive(passphrase, salt);
    let expected = hmac(&mac, &[nonce, body].concat());
    // Compared in full whatever differs, so the time taken says nothing about where.
    if expected.iter().zip(tag).fold(0u8, |d, (a, b)| d | (a ^ b)) != 0 {
        return Err("That passphrase does not open the code's keys.".into());
    }
    let plain: Vec<u8> = body.iter().zip(keystream(&cipher, nonce, body.len())).map(|(c, k)| c ^ k).collect();
    serde_json::from_slice::<Value>(&plain).ok().and_then(|v| v.as_object().cloned()).ok_or_else(|| "The code's keys could not be read.".into())
}

/// The API keys kept in config/launcher.env.
fn keys_here(paths: &Paths) -> Map<String, Value> {
    crate::setup::entries(paths).into_iter().filter(|(name, value)| crate::log::secret_name(name) && !value.is_empty()).map(|(n, v)| (n, Value::String(v))).collect()
}

/// A passphrase: from DSTNS_LAUNCH_PASSPHRASE, or asked for at the terminal without echoing it.
pub fn passphrase(prompt: &str, twice: bool) -> Result<String, String> {
    if let Ok(given) = std::env::var("DSTNS_LAUNCH_PASSPHRASE") {
        if !given.is_empty() {
            return Ok(given);
        }
    }
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        return Err("A passphrase is needed for the keys: run this at a terminal, or set DSTNS_LAUNCH_PASSPHRASE.".into());
    }
    let ask = |prompt: &str| -> Result<String, String> {
        eprint!("{prompt}");
        let _ = std::process::Command::new("stty").arg("-echo").stdin(std::process::Stdio::inherit()).status();
        let mut line = String::new();
        let read = std::io::stdin().read_line(&mut line);
        let _ = std::process::Command::new("stty").arg("echo").stdin(std::process::Stdio::inherit()).status();
        eprintln!();
        read.map_err(|e| e.to_string())?;
        Ok(line.trim_end_matches(['\n', '\r']).to_string())
    };
    let first = ask(prompt)?;
    if first.chars().count() < 8 {
        return Err("A passphrase for keys needs at least 8 characters.".into());
    }
    if twice && ask("Once more: ")? != first {
        return Err("The two passphrases differ.".into());
    }
    Ok(first)
}

/// The world running now, or the one the settings would make; None when neither is fixed.
fn world(paths: &Paths, config: &Value) -> Option<Value> {
    if let Some(port) = crate::server::active_port(paths) {
        let status = crate::simulation::status(port, paths);
        if status.reachable && !status.seed.is_empty() && status.lifecycle != "IDLE" {
            let playback = crate::api::get(port, "/api/v1/playback/status", 3.0, paths);
            let data = playback.data().cloned().unwrap_or(Value::Null);
            let day = data.get("day").cloned().unwrap_or(json!(0));
            let playing = playback.body.pointer("/clock/playback_state").and_then(|v| v.as_str()) == Some("RUNNING");
            let rate = playback.body.pointer("/clock/target_virtual_rate").or(playback.body.pointer("/clock/tick_rate")).cloned().unwrap_or(Value::Null);
            // The operator's own changes still in effect, in the order they were made.
            let history = crate::api::get(port, "/api/v1/control/history", 3.0, paths);
            let changes: Vec<Value> = history
                .data()
                .and_then(|d| d.get("commands"))
                .and_then(|c| c.as_array())
                .map(|list| {
                    list.iter()
                        .filter(|c| c["status"] == "applied" && REPLAYABLE.contains(&c["type"].as_str().unwrap_or("")) && c.get("after").is_some_and(|a| a.is_object()))
                        .map(|c| json!({"type": c["type"], "at": c["virtual_day_s"], "after": c["after"]}))
                        .collect()
                })
                .unwrap_or_default();
            // The rules and the engine the world was made by, as the server reports them, not as the settings are now.
            let made_by = |key: &str| data.get(key).filter(|v| v.as_str().is_some_and(|s| !s.is_empty())).cloned();
            return Some(json!({"seed": status.seed, "day": day, "at": status.virtual_seconds.floor() as u64, "maps": made_by("map_selection_version").unwrap_or_else(|| maps(config)),
                               "engine": made_by("engine").unwrap_or_else(|| config::setting(config, "engine.implementation")), "playing": playing, "rate": rate, "changes": changes}));
        }
    }
    let seed = config.get("seed").and_then(|s| s.as_str()).filter(|s| !s.is_empty() && *s != "auto")?;
    Some(json!({"seed": seed, "day": config.get("day").cloned().unwrap_or(json!(0)), "at": 0, "maps": maps(config), "engine": config::setting(config, "engine.implementation")}))
}

/// This launcher's state as a code, with the world if asked.
/// A code in blocks of four, to read aloud or copy by eye. Any reader ignores the dashes.
pub fn grouped(code: &str) -> String {
    code.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join("-")
}

/// What a code carries, in words, before anything is applied.
pub fn preview(state: &Value) -> Vec<String> {
    let mut out = vec![];
    let settings = state.get("settings").and_then(|s| s.as_object()).cloned().unwrap_or_default();
    if settings.is_empty() {
        out.push("Settings: every one at its default.".into());
    } else {
        out.push(format!("Settings that differ from the defaults ({}):", settings.len()));
        for (key, value) in &settings {
            match config::field(key) {
                Some(field) => out.push(format!("  {} ({}): {}", field.label, field.category, field.display(value))),
                None => out.push(format!("  {key}: {value} (not a setting here)")),
            }
        }
    }
    if let Some(world) = state.get("world") {
        let at = world["at"].as_u64().unwrap_or(0);
        out.push(format!(
            "World: seed {}, a {}, at {}, {} on {}{}.",
            world["seed"].as_str().unwrap_or("?"),
            if world["day"] == 1 { "weekend" } else { "weekday" },
            clock(at),
            world["maps"].as_str().unwrap_or(config::MAP_SELECTION_VERSION),
            world["engine"].as_str().unwrap_or("core-legacy"),
            world["changes"].as_array().filter(|c| !c.is_empty()).map(|c| format!(", with {} change{} made by hand", c.len(), if c.len() == 1 { "" } else { "s" })).unwrap_or_default()
        ));
    }
    if let Some(keys) = state.get("keys") {
        let names: Vec<&str> = keys["names"].as_array().map(|n| n.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
        out.push(format!("API keys, sealed with a passphrase: {}.", names.join(", ")));
    }
    out
}

/// Decode a code and say what it carries, applying nothing.
pub fn show(code: &str) -> Result<Vec<String>, String> {
    decode(code).map(|state| preview(&state))
}

/// Put text on the system clipboard with the first tool this system has. Returns the tool's name.
pub fn copy(text: &str) -> Result<&'static str, String> {
    let tools: &[(&str, &[&str])] = &[("pbcopy", &[]), ("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["--clipboard", "--input"]), ("clip.exe", &[])];
    for (tool, arguments) in tools {
        let Some(program) = crate::process::which(tool) else { continue };
        let child = std::process::Command::new(program).args(*arguments).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
        if let Ok(mut child) = child {
            if let Some(mut input) = child.stdin.take() {
                let _ = input.write_all(text.as_bytes());
            }
            if child.wait().map(|s| s.success()).unwrap_or(false) {
                return Ok(tool);
            }
        }
    }
    Err("No clipboard tool was found (pbcopy, wl-copy, xclip, xsel or clip.exe); copy the code from above.".into())
}

/// launch-code: the code in blocks, then what it carries, and on the clipboard if asked.
pub fn launch_code_lines(paths: &Paths, with_world: bool, keys_passphrase: Option<&str>, to_clipboard: bool) -> Result<Vec<String>, String> {
    let code = launch_code(paths, with_world, keys_passphrase)?;
    let mut out = vec![grouped(&code), String::new()];
    out.extend(preview(&decode(&code)?));
    if to_clipboard {
        out.push(match copy(&code) {
            Ok(tool) => format!("Copied to the clipboard ({tool})."),
            Err(why) => why,
        });
    }
    out.push("Use it elsewhere with: ./launcher launch CODE (or state show CODE to look first).".into());
    Ok(out)
}

pub fn get(paths: &Paths, with_world: bool) -> Result<String, String> {
    launch_code(paths, with_world, None)
}

/// The launch code: settings, and the world and the API keys (sealed with `passphrase`) if asked.
pub fn launch_code(paths: &Paths, with_world: bool, keys_passphrase: Option<&str>) -> Result<String, String> {
    let config = config::load(paths).map_err(|e| e.message)?;
    let mut settings = Map::new();
    for field in fields().iter().filter(|f| portable(f.key)) {
        let value = field.get(&config);
        if value != field.default {
            settings.insert(field.key.to_string(), value);
        }
    }
    let mut state = json!({"settings": settings});
    if with_world {
        state["world"] = world(paths, &config).ok_or("There is no world to copy yet: start a run, or set a seed, first.")?;
    }
    if let Some(passphrase) = keys_passphrase {
        let keys = keys_here(paths);
        if keys.is_empty() {
            return Err("There are no API keys in config/launcher.env to include.".into());
        }
        state["keys"] = json!({"names": keys.keys().collect::<Vec<_>>(), "sealed": seal_keys(&keys, passphrase)});
    }
    Ok(encode(&state))
}

/// Make this launcher's settings those of the code, and, if it carries one, its world the next start's.
pub fn set(paths: &Paths, code: &str) -> Result<Vec<String>, String> {
    let state = decode(code)?;
    let wanted = state.get("settings").and_then(|s| s.as_object()).cloned().unwrap_or_default();
    let mut config = config::load(paths).map_err(|e| e.message)?;
    let mut refused = vec![];
    let mut applied = 0;
    // Every setting that travels goes back to its default, then takes the code's value: the result is the same.
    for field in fields().iter().filter(|f| portable(f.key)) {
        let value = wanted.get(field.key).cloned().unwrap_or_else(|| field.default.clone());
        let problem = field.check(&value);
        if problem.is_empty() {
            field.set(&mut config, value);
            applied += wanted.contains_key(field.key) as usize;
        } else {
            refused.push(format!("{}: {problem}", field.key));
        }
    }
    let unknown: Vec<&String> = wanted.keys().filter(|k| config::field(k).map(|f| !portable(f.key)).unwrap_or(true)).collect();
    let mut out = vec![format!("{applied} settings differ from the defaults; every other setting is now its default.")];
    if let Some(world) = state.get("world") {
        let seed = world["seed"].as_str().ok_or("The code's world has no seed.")?;
        crate::config::normalise_seed(seed).map_err(|e| e.message)?;
        config["day"] = world["day"].clone();
        // The world runs on the engine that made it (a run may have chosen one with --engine).
        if let Some(engine) = world["engine"].as_str().filter(|e| config::ENGINES.contains(e)) {
            if config::setting(&config, "engine.implementation") != json!(engine) {
                if let Some(field) = config::field("engine.implementation") {
                    field.set(&mut config, json!(engine));
                    out.push(format!("Its world runs on {engine}, so the engine is now {engine}."));
                }
            }
        }
        if world["maps"] != maps(&config) {
            out.push(format!("Its world was made by other map rules ({}); this launcher may choose another city for that seed.", world["maps"].as_str().unwrap_or("unknown")));
        }
        let at = world["at"].as_u64().unwrap_or(0);
        // The rest of the way back (play state, rate, the operator's changes) waits in a file for the next start.
        let _ = std::fs::write(paths.root.join("config").join(PENDING_FILE), json!({"seed": seed, "at": at, "playing": world["playing"], "rate": world["rate"], "changes": world["changes"]}).to_string());
        let changes = world["changes"].as_array().map(|c| c.len()).unwrap_or(0);
        if changes > 0 {
            out.push(format!("{changes} change{} the operator made will be made again at the moments they were made.", if changes == 1 { "" } else { "s" }));
        }
        let mut kept: Vec<(String, String)> = crate::setup::entries(paths).into_iter().filter(|(k, _)| k != PENDING_JUMP).collect();
        // The next start without a seed of its own runs this world (a plain start otherwise takes a prepared or
        // new one), and then jumps to its moment.
        kept.push((PENDING_JUMP.into(), format!("{seed}@{at}")));
        std::env::set_var(PENDING_JUMP, format!("{seed}@{at}"));
        crate::setup::save_entries(paths, &kept).map_err(|e| e.to_string())?;
        out.push(format!("The world: seed {seed}, a {}{}. The next start runs it.", if world["day"] == 1 { "weekend" } else { "weekday" }, if at > 0 { format!(", jumping to {}", clock(at)) } else { String::new() }));
    }
    config::save(&config, paths).map_err(|e| e.message)?;
    if let Some(keys) = state.get("keys") {
        let names: Vec<String> = keys["names"].as_array().map(|n| n.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        let opened = open_keys(keys["sealed"].as_str().unwrap_or(""), &passphrase(&format!("Passphrase for the code's keys ({}): ", names.join(", ")), false)?)?;
        let mut kept: Vec<(String, String)> = crate::setup::entries(paths).into_iter().filter(|(k, _)| !opened.contains_key(k)).collect();
        for (name, value) in &opened {
            if crate::log::secret_name(name) {
                kept.push((name.clone(), value.as_str().unwrap_or("").to_string()));
                std::env::set_var(name, value.as_str().unwrap_or(""));
            }
        }
        crate::setup::save_entries(paths, &kept).map_err(|e| e.to_string())?;
        out.push(format!("API keys from the code: {}. Tokens and model addresses were left as they are.", names.join(", ")));
    } else {
        out.push("API keys, tokens and model addresses were left as they are on this machine.".into());
    }
    for problem in &refused {
        out.push(format!("Kept the default for {problem}"));
    }
    if !unknown.is_empty() {
        out.push(format!("Not settings here, so left out: {}", unknown.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", ")));
    }
    Ok(out)
}

fn clock(seconds: u64) -> String {
    format!("{:02}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60)
}

/// The seed of a world a state code brought, waiting for the next start.
pub fn pending_seed() -> Option<String> {
    std::env::var(PENDING_JUMP).ok().and_then(|p| p.split_once('@').map(|(seed, _)| seed.to_string())).filter(|s| !s.is_empty())
}

/// After a start: the moment a state code's world was at, if this is that world (by the seed as asked for, or as the
/// world reports it). Used once.
pub fn jump_after_start(port: u16, seeds: &[&str], paths: &Paths) -> Option<String> {
    let pending = std::env::var(PENDING_JUMP).ok()?;
    let entries: Vec<(String, String)> = crate::setup::entries(paths).into_iter().filter(|(k, _)| k != PENDING_JUMP).collect();
    let _ = crate::setup::save_entries(paths, &entries);
    std::env::remove_var(PENDING_JUMP);
    let (wanted, at) = pending.split_once('@')?;
    let at: u64 = at.parse().ok()?;
    if !seeds.contains(&wanted) || at == 0 {
        return None;
    }
    let pending_file = paths.root.join("config").join(PENDING_FILE);
    let plan: Value = std::fs::read_to_string(&pending_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let _ = std::fs::remove_file(&pending_file);
    let playing = plan["playing"].as_bool().unwrap_or(true);
    // The operator's changes, each at the moment it was made, on the way to the copied moment.
    let mut replayed = 0;
    let mut failed = vec![];
    if plan["seed"].as_str() == Some(wanted) {
        for change in plan["changes"].as_array().cloned().unwrap_or_default() {
            let when = change["at"].as_u64().unwrap_or(0).min(at);
            let _ = crate::api::post(port, "/api/v1/playback/seek", &json!({"target_time": clock(when), "play": false}), 300.0, paths);
            let after = &change["after"];
            let response = match change["type"].as_str().unwrap_or("") {
                "signal_toggle" => crate::api::post(port, &format!("/api/v1/control/signals/{}/toggle", after["node"]), &json!({}), 30.0, paths),
                "edge_override" => crate::api::put(port, &format!("/api/v1/control/edges/{}", after["edge"]), &json!({"speed_multiplier": after["speed_multiplier"], "capacity_multiplier": after["capacity_multiplier"], "closed": after["closed"]}), 30.0, paths),
                "manual_weather" => crate::api::post(port, "/api/v1/control/events/weather", &json!({"epicenter_node": after["epicenter_node"], "intensity": after["intensity"], "radius_m": after["radius_m"], "duration_virtual_minutes": after["duration_virtual_minutes"], "flood_gain": after["flood_gain"]}), 30.0, paths),
                "module" => crate::api::put(port, &format!("/api/v1/control/modules/{}", after["module"].as_str().unwrap_or("")), &json!({"enabled": after["enabled"]}), 30.0, paths),
                _ => continue,
            };
            if response.ok() {
                replayed += 1;
            } else {
                failed.push(change["type"].as_str().unwrap_or("change").to_string());
            }
        }
        if let Some(rate) = plan["rate"].as_f64() {
            let _ = crate::api::put(port, "/api/v1/control/tick-rate", &json!({"tick_rate": rate}), 30.0, paths);
        }
    }
    let response = crate::api::post(port, "/api/v1/playback/seek", &json!({"target_time": clock(at), "play": playing}), 300.0, paths);
    let mut said = if response.ok() { format!("Back at {}, where the copied world was{}", clock(at), if playing { "" } else { ", paused" }) } else { format!("Could not jump to {}: {}", clock(at), response.error_message()) };
    if replayed > 0 {
        said.push_str(&format!(", with {replayed} of the operator's change{} made again", if replayed == 1 { "" } else { "s" }));
    }
    if !failed.is_empty() {
        said.push_str(&format!("; could not make again: {}", failed.join(", ")));
    }
    Some(said)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_uppercase_hex_and_reads_back() {
        let state = json!({"settings": {"api.port": 9000, "model.provider": "groq"}, "world": {"seed": "42", "day": 1, "at": 30600}});
        let code = encode(&state);
        assert!(code.chars().all(|c| c.is_ascii_digit() || c.is_ascii_uppercase()), "{code}");
        assert_eq!(decode(&code).unwrap(), state);
        // Spacing, dashes and case added by a person are forgiven.
        let spaced: String = code.to_lowercase().chars().collect::<Vec<_>>().chunks(8).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-\n");
        assert_eq!(decode(&spaced).unwrap(), state);
    }

    #[test]
    fn a_damaged_code_is_refused_whole() {
        let code = encode(&json!({"settings": {"api.port": 9000}}));
        let mut changed: Vec<char> = code.chars().collect();
        let last = changed.len() - 10;
        changed[last] = if changed[last] == 'A' { 'B' } else { 'A' };
        assert!(decode(&changed.into_iter().collect::<String>()).unwrap_err().contains("does not check out"));
        assert!(decode(&code[..code.len() - 2]).is_err());
        assert!(decode("not hex at all").is_err());
        assert!(decode("").is_err());
        let mut other = vec![9u8, 1, 2];
        let check = Sha256::digest(&other);
        other.extend_from_slice(&check[..4]);
        assert!(decode(&other.iter().map(|b| format!("{b:02X}")).collect::<String>()).unwrap_err().contains("version 9"));
    }

    #[test]
    fn keys_sealed_before_the_crates_still_open() {
        // Sealed by the hand-written PBKDF2 and HMAC this replaced; the crates must give the same bytes.
        let sealed = "e95c72c335454197ab412eb1c5a20bd246aaed213949a392b06e8ffb5a8bb61e554768890840f2ecc3e6be85472abb646b2f7099f1d29f19348cf3973b849aa2b31255fc21cd77b33718d54edfbe730300eb05600ace83fbff1426bd13022bbdf833e8011cc619cdeceb77f751";
        let keys = super::open_keys(sealed, "correct horse battery").expect("an older code opens");
        assert_eq!(keys["GROQ_API_KEY"], "gsk_example_not_a_real_key");
        assert!(super::open_keys(sealed, "wrong horse battery").is_err());
    }

    #[test]
    fn keys_open_only_with_their_passphrase_and_unchanged() {
        let mut keys = Map::new();
        keys.insert("GROQ_API_KEY".into(), json!("gsk_example_not_real"));
        let sealed = seal_keys(&keys, "correct horse");
        assert!(!sealed.contains("gsk"), "the key is not readable in the code");
        assert_eq!(open_keys(&sealed, "correct horse").unwrap(), keys);
        assert!(open_keys(&sealed, "wrong horse").unwrap_err().contains("passphrase"));
        let mut tampered: Vec<char> = sealed.chars().collect();
        let at = 70;
        tampered[at] = if tampered[at] == '0' { '1' } else { '0' };
        assert!(open_keys(&tampered.into_iter().collect::<String>(), "correct horse").is_err(), "a changed byte is refused");
        // A version 1 code still reads.
        let mut old = vec![1u8];
        let mut deflated = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
        deflated.write_all(br#"{"settings":{}}"#).unwrap();
        old.extend(deflated.finish().unwrap());
        let check = Sha256::digest(&old);
        old.extend_from_slice(&check[..4]);
        assert_eq!(decode(&old.iter().map(|b| format!("{b:02X}")).collect::<String>()).unwrap(), json!({"settings": {}}));
    }

    #[test]
    fn hmac_matches_the_standard() {
        // RFC 4231, test case 2.
        let tag = hmac(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(tag.iter().map(|b| format!("{b:02x}")).collect::<String>(), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn credentials_and_addresses_never_travel() {
        for key in ["model.ollama_url", "model.base_url"] {
            assert!(!portable(key), "{key}");
        }
        assert!(portable("model.provider") && portable("api.port") && portable("narration.mode"));
    }

    #[test]
    fn settings_go_from_one_launcher_to_another() {
        let _environment = crate::paths::test_environment();
        let root = |n: &str| std::env::temp_dir().join(format!("dstns-state-{n}-{}", std::process::id()));
        let (a, b) = (Paths::new(root("a")), Paths::new(root("b")));
        for p in [&a, &b] {
            std::fs::create_dir_all(p.config().parent().unwrap()).unwrap();
            std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../config/defaults.json"), p.config()).unwrap();
        }
        let mut config = config::load(&a).unwrap();
        config::field("api.port").unwrap().set(&mut config, json!(9123));
        config::field("model.ollama_url").unwrap().set(&mut config, json!("http://user:secret@10.0.0.9:11434"));
        config["seed"] = json!("424242");
        config::save(&config, &a).unwrap();
        let mut theirs = config::load(&b).unwrap();
        config::field("playback.tick_rate").unwrap().set(&mut theirs, json!(4.0));
        config::save(&theirs, &b).unwrap();

        let code = get(&a, true).unwrap();
        assert!(!String::from_utf8_lossy(&format!("{:?}", decode(&code).unwrap()).into_bytes()).contains("secret"));
        set(&b, &code).unwrap();
        let now = config::load(&b).unwrap();
        assert_eq!(config::field("api.port").unwrap().get(&now), json!(9123));
        assert_eq!(config::field("playback.tick_rate").unwrap().get(&now), config::field("playback.tick_rate").unwrap().default, "a setting the code leaves at its default goes back to it");
        assert_eq!(config::field("model.ollama_url").unwrap().get(&now), config::field("model.ollama_url").unwrap().default, "an address is not copied");
        assert_eq!(pending_seed().as_deref(), Some("424242"), "the world waits for the next start");
        std::env::remove_var(PENDING_JUMP);
        for p in [&a, &b] {
            let _ = std::fs::remove_dir_all(&p.root);
        }
    }

    #[test]
    fn a_code_reads_in_blocks_says_what_it_carries_and_keeps_its_engine() {
        let _environment = crate::paths::test_environment();
        let state = json!({"settings": {"api.port": 9123}, "world": {"seed": "42", "day": 1, "at": 30600, "maps": "urban-crfg-v3", "engine": "core-ng", "changes": [{"type": "module"}]}});
        let code = encode(&state);
        let blocks = grouped(&code);
        assert!(blocks.split('-').all(|b| b.len() <= 4) && blocks.replace('-', "") == code);
        assert_eq!(decode(&blocks).unwrap(), state, "a code in blocks reads as the code");
        assert_eq!(decode(&format!("{}\n{}", &blocks[..10], &blocks[10..])).unwrap(), state, "however it was wrapped");
        let said = show(&blocks).unwrap().join("\n");
        assert!(said.contains("Port (Server): 9123"), "{said}");
        assert!(said.contains("seed 42, a weekend, at 08:30") && said.contains("on core-ng") && said.contains("1 change made by hand"), "{said}");

        let root = std::env::temp_dir().join(format!("dstns-state-engine-{}", std::process::id()));
        let paths = Paths::new(&root);
        std::fs::create_dir_all(paths.config().parent().unwrap()).unwrap();
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../config/defaults.json"), paths.config()).unwrap();
        let out = set(&paths, &blocks).unwrap();
        assert_eq!(config::setting(&config::load(&paths).unwrap(), "engine.implementation"), json!("core-ng"), "{out:?}");
        assert!(out.iter().any(|l| l.contains("runs on core-ng")));
        std::env::remove_var(PENDING_JUMP);
        let _ = std::fs::remove_dir_all(&root);
    }
}
