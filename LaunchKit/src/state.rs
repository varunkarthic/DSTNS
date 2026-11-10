// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launcher's state as one code: uppercase hexadecimal that another launcher takes to become the same.
//!
//! `state get` prints it, `state set CODE` applies it, and `./launcher --state CODE` applies it before anything else.
//! It carries every setting that differs from its default, so a launcher given it ends with exactly these settings,
//! except those that hold a credential or an address (API keys, tokens, model addresses), which stay as they are on
//! each machine and are never put in a code. API keys are not settings at all and never leave.
//!
//! `state get --world` adds the world: its seed, day type and map rules, and the moment of the day it is at. DSTNS is
//! deterministic, so these make the same world again; the next start runs it and jumps to that moment, once. What an
//! operator did to the world by hand (a road closed, a storm started) is not carried.
//!
//! The code is a version byte, the state as deflated JSON, and the first four bytes of its SHA-256, so a code cut
//! short or mistyped is refused rather than half applied.

use crate::config::{self, fields};
use crate::paths::Paths;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

const VERSION: u8 = 1;
/// Where a world's moment waits for the next start, in config/launcher.env: SEED@SECONDS.
pub const PENDING_JUMP: &str = "DSTNS_STATE_JUMP";

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
    if body[0] != VERSION {
        return Err(format!("That code is from a launcher of another kind (version {}); this one reads version {VERSION}.", body[0]));
    }
    let mut text = String::new();
    flate2::read::DeflateDecoder::new(&body[1..]).take(1 << 20).read_to_string(&mut text).map_err(|_| "That code could not be unpacked.".to_string())?;
    serde_json::from_str(&text).map_err(|_| "That code could not be read.".into())
}

/// The world running now, or the one the settings would make; None when neither is fixed.
fn world(paths: &Paths, config: &Value) -> Option<Value> {
    if let Some(port) = crate::server::active_port(paths) {
        let status = crate::simulation::status(port, paths);
        if status.reachable && !status.seed.is_empty() && status.lifecycle != "IDLE" {
            let day = crate::api::get(port, "/api/v1/playback/status", 3.0, paths).data().and_then(|d| d.get("day").cloned()).unwrap_or(json!(0));
            return Some(json!({"seed": status.seed, "day": day, "at": status.virtual_seconds.floor() as u64, "maps": config.pointer("/map/map_selection_version")}));
        }
    }
    let seed = config.get("seed").and_then(|s| s.as_str()).filter(|s| !s.is_empty() && *s != "auto")?;
    Some(json!({"seed": seed, "day": config.get("day").cloned().unwrap_or(json!(0)), "at": 0, "maps": config.pointer("/map/map_selection_version")}))
}

/// This launcher's state as a code, with the world if asked.
pub fn get(paths: &Paths, with_world: bool) -> Result<String, String> {
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
        if world["maps"] != *config.pointer("/map/map_selection_version").unwrap_or(&Value::Null) {
            out.push(format!("Its world was made by other map rules ({}); this launcher may choose another city for that seed.", world["maps"].as_str().unwrap_or("unknown")));
        }
        let at = world["at"].as_u64().unwrap_or(0);
        let mut kept: Vec<(String, String)> = crate::setup::entries(paths).into_iter().filter(|(k, _)| k != PENDING_JUMP).collect();
        // The next start without a seed of its own runs this world (a plain start otherwise takes a prepared or
        // new one), and then jumps to its moment.
        kept.push((PENDING_JUMP.into(), format!("{seed}@{at}")));
        std::env::set_var(PENDING_JUMP, format!("{seed}@{at}"));
        crate::setup::save_entries(paths, &kept).map_err(|e| e.to_string())?;
        out.push(format!("The world: seed {seed}, a {}{}. The next start runs it.", if world["day"] == 1 { "weekend" } else { "weekday" }, if at > 0 { format!(", jumping to {}", clock(at)) } else { String::new() }));
    }
    config::save(&config, paths).map_err(|e| e.message)?;
    out.push("API keys, tokens and model addresses were left as they are on this machine.".into());
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
    let response = crate::api::post(port, "/api/v1/playback/seek", &json!({"target_time": clock(at), "play": true}), 300.0, paths);
    Some(if response.ok() { format!("Jumped to {}, where the copied world was", clock(at)) } else { format!("Could not jump to {}: {}", clock(at), response.error_message()) })
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
    fn credentials_and_addresses_never_travel() {
        for key in ["model.ollama_url", "model.base_url"] {
            assert!(!portable(key), "{key}");
        }
        assert!(portable("model.provider") && portable("api.port") && portable("narration.mode"));
    }

    #[test]
    fn settings_go_from_one_launcher_to_another() {
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
}
