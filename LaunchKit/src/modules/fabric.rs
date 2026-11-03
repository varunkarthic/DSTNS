// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! `./launcher fabric`: looking at and acting on a running server through the Fabric API.

use super::{port, Command, Module, Options};
use crate::cli::{Context, EXIT_FAILURE, EXIT_OK};
use crate::environment::State;
use crate::errors::{LauncherError, Result};
use crate::fabric;
use crate::reporting::Level;
use serde_json::{json, Map, Value};

const USAGE: &str = "usage: ./launcher fabric [status|capabilities|grant|settings|audit]

  status                    What is protecting what, and whether the audit log verifies
  capabilities              What this server offers applications, as JSON
  grant ID [CAPABILITY ...] Give an application these permissions, and only these
  settings ID [KEY=VALUE ...]
                            Read an application's settings, or change them
  audit [-n N]              What applications have done to the simulation
";

pub fn module() -> Module {
    Module {
        commands: vec![Command { name: "fabric", usage: "fabric [status|capabilities|grant|settings|audit]", summary: "Look at and act on a running server through the Fabric API", run }],
        pages: vec![],
    }
}

fn run(context: &Context) -> Result<i32> {
    let options = Options::parse(&context.args.rest, &["-n"], &["--help", "-h"])?;
    if options.has("--help") || options.has("-h") {
        print!("{USAGE}");
        return Ok(EXIT_OK);
    }
    let out = &context.out;
    let paths = &context.paths;
    let action = options.positional.first().cloned().unwrap_or_else(|| "status".into());
    let port = port(context)?;
    let id = || options.positional.get(1).cloned().ok_or_else(|| LauncherError::config(format!("./launcher fabric {action} needs an application ID.")));
    match action.as_str() {
        "status" => {
            let posture = fabric::security(port, paths)
                .ok_or_else(|| LauncherError::generic("The server did not answer as the operator.").remedy("Its credential is in the logs directory, as operator.token."))?;
            let audit = &posture["audit"]["verification"];
            let intact = audit["intact"].as_bool().unwrap_or(false);
            let tls = posture["transport"]["tls"].as_bool().unwrap_or(false);
            let rejected = posture["store"]["rejected"].as_bool().unwrap_or(false);
            out.heading("Fabric");
            out.status(if tls { State::Pass } else { State::Skipped }, "Connection", if tls { "Encrypted with TLS" } else { "Plain HTTP, on this machine" }, 22);
            out.status(if rejected { State::Fail } else { State::Pass }, "Credentials", if rejected { "A changed store was rejected" } else { "Tokens hashed, store sealed" }, 22);
            let audit_text = if intact { format!("Intact, {} entries checked", audit["checked"]) } else { format!("Altered at entry {}", audit["first_bad_sequence"]) };
            out.status(if intact { State::Pass } else { State::Fail }, "Audit log", &audit_text, 22);
            out.status(
                State::Pass,
                "Applications",
                &format!("{} registered, {} require signed requests", posture["applications"]["registered"], posture["applications"]["requiring_signatures"]),
                22,
            );
            Ok(if intact && !rejected { EXIT_OK } else { EXIT_FAILURE })
        }
        "capabilities" => {
            println!("{}", serde_json::to_string_pretty(&fabric::capabilities(port, paths).unwrap_or(Value::Null)).unwrap());
            Ok(EXIT_OK)
        }
        "grant" => {
            let id = id()?;
            let capabilities: Vec<String> = options.positional[2..].to_vec();
            let response = fabric::grant(port, &id, &capabilities, paths);
            if !response.ok() {
                return Err(LauncherError::generic(response.error_message()));
            }
            out.message(Level::Success, &format!("{id} now has"), &if capabilities.is_empty() { "nothing it had to ask for".to_string() } else { capabilities.join(", ") });
            Ok(EXIT_OK)
        }
        "settings" => {
            let id = id()?;
            if options.positional.len() > 2 {
                let mut values = Map::new();
                for item in &options.positional[2..] {
                    let (key, value) = item.split_once('=').unwrap_or((item, ""));
                    values.insert(key.to_string(), serde_json::from_str(value).unwrap_or_else(|_| json!(value)));
                }
                let response = fabric::update_settings(port, &id, &Value::Object(values), paths);
                if !response.ok() {
                    return Err(LauncherError::generic(response.error_message()));
                }
            }
            let current = fabric::settings(port, &id, paths).ok_or_else(|| LauncherError::generic(format!("The server does not know {id}.")))?;
            let rows: Vec<(String, String)> = current.get("values").and_then(|v| v.as_object()).map(|m| m.iter().map(|(k, v)| (k.clone(), v.to_string())).collect()).unwrap_or_default();
            out.pairs(&rows, 20);
            Ok(EXIT_OK)
        }
        "audit" => {
            let limit: usize = options.value("-n").and_then(|n| n.parse().ok()).unwrap_or(20);
            let rows: Vec<Vec<String>> = fabric::audit(port, limit, paths)
                .iter()
                .map(|e| {
                    let s = |k: &str| e.get(k).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default();
                    vec![s("sequence"), s("app_id"), s("action"), s("outcome"), s("hash").chars().take(12).collect()]
                })
                .collect();
            if rows.is_empty() {
                out.message(Level::Info, "Applications have done nothing to the simulation", "");
            } else {
                out.table(&["#", "Application", "Action", "Outcome", "Hash"], &rows, 40);
            }
            Ok(EXIT_OK)
        }
        _ => Ok(EXIT_FAILURE),
    }
}
