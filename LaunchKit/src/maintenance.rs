// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Resets, by scope. `reset` alone clears everything but the connected applications and their own settings;
//! `reset all` clears those too; a scope's name clears that scope alone, and scopes combine (`reset cache seeds`).

use crate::paths::Paths;
use crate::reporting::{Level, Reporter};
use std::fs;
use std::path::PathBuf;

const RUNTIME_FILES: &[&str] = &["system.log", "runtime.db", "runtime.db-wal", "runtime.db-shm"];
const RUNTIME_DIRECTORIES: &[&str] = &["checkpoints", "scenarios", "sumo_live_run"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Runtime,
    Cache,
    Settings,
    Setup,
    Seeds,
    Keys,
    Apps,
    /// One application's own settings, or every application's.
    AppSettings(Option<String>),
}

/// Every scope by name, with what it clears, in the order a reset goes through them.
pub const SCOPES: &[(&str, &str)] = &[
    ("runtime", "runtime logs, the journal, checkpoints, temporary scenarios and SUMO runs"),
    ("cache", "downloaded cities, Fast Boot's cities and Dynamic Fastboot's next world"),
    ("settings", "every setting back to its default (config/defaults.json and config/ui-config.json)"),
    ("setup", "the launcher's setup, which runs again at the next start"),
    ("seeds", "saved seeds and the maps saved with them"),
    ("keys", "model providers' API keys, in config/launcher.env and in the system's credential store"),
    ("apps", "connected applications (config/apps.json)"),
    ("app-settings", "WebFabric applications' own settings; app-settings ID for one application"),
];

/// What plain `reset` clears: everything but the applications and their settings.
pub fn default_scopes() -> Vec<Scope> {
    vec![Scope::Runtime, Scope::Cache, Scope::Settings, Scope::Setup, Scope::Seeds, Scope::Keys]
}

pub fn all_scopes() -> Vec<Scope> {
    let mut out = default_scopes();
    out.extend([Scope::Apps, Scope::AppSettings(None)]);
    out
}

/// The scopes the words after `reset` name. None names the default; `all` names every scope.
pub fn parse(words: &[String]) -> Result<Vec<Scope>, String> {
    let mut out: Vec<Scope> = vec![];
    let mut words = words.iter().map(|w| w.trim().to_ascii_lowercase()).filter(|w| !w.is_empty()).peekable();
    if words.peek().is_none() {
        return Ok(default_scopes());
    }
    while let Some(word) = words.next() {
        let scope = match word.as_str() {
            "all" => {
                for scope in all_scopes() {
                    if !out.contains(&scope) {
                        out.push(scope);
                    }
                }
                continue;
            }
            "runtime" => Scope::Runtime,
            "cache" => Scope::Cache,
            "settings" | "config" => Scope::Settings,
            "setup" => Scope::Setup,
            "seeds" => Scope::Seeds,
            "keys" => Scope::Keys,
            "apps" => Scope::Apps,
            "app-settings" => {
                // An application's ID may follow; a scope's name may not be one.
                let id = words.next_if(|w| !SCOPES.iter().any(|(name, _)| name == w) && w != "all");
                if let Some(id) = &id {
                    if !crate::seeds::valid_id(id) {
                        return Err(format!("{id} is not an application ID."));
                    }
                }
                Scope::AppSettings(id)
            }
            other => return Err(format!("reset: no scope named {other}. Scopes: all, {}.", SCOPES.iter().map(|(n, _)| *n).collect::<Vec<_>>().join(", "))),
        };
        if !out.contains(&scope) {
            out.push(scope);
        }
    }
    // Every application's settings take in any one application's.
    if out.contains(&Scope::AppSettings(None)) {
        out.retain(|s| !matches!(s, Scope::AppSettings(Some(_))));
    }
    Ok(out)
}

fn name(scope: &Scope) -> &'static str {
    match scope {
        Scope::Runtime => "runtime",
        Scope::Cache => "cache",
        Scope::Settings => "settings",
        Scope::Setup => "setup",
        Scope::Seeds => "seeds",
        Scope::Keys => "keys",
        Scope::Apps => "apps",
        Scope::AppSettings(_) => "app-settings",
    }
}

fn map_cache(paths: &Paths) -> Vec<PathBuf> {
    let configured = crate::config::load(paths).ok().and_then(|c| c.pointer("/map/cache_dir").and_then(|v| v.as_str()).map(String::from));
    let mut out = vec![paths.map_cache(configured.as_deref()), paths.fastboot()];
    out.dedup();
    out
}

/// The file the server reads, as it starts, for the applications whose own settings go back to their defaults.
/// The store is sealed by the server, so the launcher asks rather than editing it.
pub fn app_settings_request(paths: &Paths) -> PathBuf {
    paths.logs().join("fabric-apps.json.reset")
}

/// What these scopes clear, one line each, for the confirmation.
pub fn describe(paths: &Paths, scopes: &[Scope]) -> Vec<String> {
    scopes
        .iter()
        .map(|scope| {
            let what = SCOPES.iter().find(|(n, _)| *n == name(scope)).map(|(_, w)| *w).unwrap_or("");
            match scope {
                Scope::AppSettings(Some(id)) => format!("app-settings {id}: {id}'s own settings"),
                Scope::Cache => format!("cache: {what} ({})", map_cache(paths).iter().map(|p| paths.relative(p)).collect::<Vec<_>>().join(", ")),
                _ => format!("{}: {what}", name(scope)),
            }
        })
        .collect()
}

fn clear_directory(directory: &PathBuf) {
    let _ = fs::remove_dir_all(directory);
    let _ = fs::create_dir_all(directory);
}

fn reset_one(scope: &Scope, paths: &Paths) -> Result<String, String> {
    match scope {
        Scope::Runtime => {
            for name in RUNTIME_FILES {
                let _ = fs::remove_file(paths.logs().join(name));
            }
            for name in RUNTIME_DIRECTORIES {
                clear_directory(&paths.root.join("data").join(name));
            }
            Ok("logs, journal, checkpoints and temporary files deleted".into())
        }
        Scope::Cache => {
            for directory in map_cache(paths) {
                clear_directory(&directory);
            }
            Ok("cities deleted; each is downloaded again when a world needs it".into())
        }
        Scope::Settings => {
            let mut config = crate::config::load(paths).map_err(|e| e.message)?;
            for field in crate::config::fields() {
                field.set(&mut config, field.default.clone());
            }
            crate::config::save(&config, paths).map_err(|e| e.message)?;
            Ok("every setting is its default".into())
        }
        Scope::Setup => {
            crate::setup::forget(paths);
            Ok("it runs again at the next start".into())
        }
        Scope::Seeds => {
            let store = paths.seed_store();
            for suffix in ["", "-wal", "-shm", "-journal"] {
                let _ = fs::remove_file(format!("{}{suffix}", store.display()));
            }
            if let Some(parent) = store.parent() {
                let _ = fs::remove_dir_all(parent.join("maps"));
            }
            Ok("saved seeds deleted".into())
        }
        Scope::Keys => {
            let names: Vec<&str> = coreai::providers::PROVIDERS.iter().flat_map(|p| p.key_names.iter().copied()).collect();
            let kept: Vec<(String, String)> = crate::setup::entries(paths).into_iter().filter(|(k, _)| !names.contains(&k.as_str())).collect();
            crate::setup::save_entries(paths, &kept).map_err(|e| e.to_string())?;
            for name in &names {
                std::env::remove_var(name);
            }
            // Keys kept in the system's store are there only when the launcher was set to keep them there.
            if let Ok(settings) = crate::assistant::settings(paths) {
                if settings.key_store == coreai::KeyStore::System {
                    for provider in coreai::providers::PROVIDERS.iter().filter(|p| !p.key_names.is_empty()) {
                        let _ = coreai::keys::system_delete(provider.id, &settings);
                    }
                }
            }
            Ok("API keys forgotten; keys set in the shell's environment are not the launcher's to delete".into())
        }
        Scope::Apps => {
            let _ = fs::remove_file(crate::apps::catalogue_path(paths));
            Ok("no application is connected".into())
        }
        Scope::AppSettings(id) => {
            let request = app_settings_request(paths);
            let mut ids: Vec<String> = fs::read_to_string(&request).unwrap_or_default().lines().map(String::from).filter(|l| !l.is_empty()).collect();
            ids.push(id.clone().unwrap_or_else(|| "*".into()));
            ids.dedup();
            fs::create_dir_all(paths.logs()).map_err(|e| e.to_string())?;
            fs::write(&request, ids.join("\n") + "\n").map_err(|e| e.to_string())?;
            Ok(format!("{} back to their defaults when the server next starts", id.as_ref().map(|i| format!("{i}'s settings go")).unwrap_or_else(|| "every application's settings go".into())))
        }
    }
}

/// Reset these scopes, unless a server is running: it writes to these files, and its run would lose its journal and
/// checkpoints under it. Returns why it refused, or the first scope that failed.
pub fn reset(reporter: &dyn Reporter, paths: &Paths, scopes: &[Scope]) -> Result<(), String> {
    if let Some(port) = crate::server::active_port(paths) {
        let why = format!("A DSTNS server is running on port {port}, and a reset would delete the files it is writing. Stop it first with ./launcher stop.");
        reporter.message(Level::Error, "Nothing was reset", &why);
        return Err(why);
    }
    let mut failed = None;
    for scope in scopes {
        let title = format!("Reset {}", name(scope));
        reporter.step_started(&title);
        let outcome = reset_one(scope, paths);
        crate::log::info(&format!("reset: {} {}", name(scope), if outcome.is_ok() { "done" } else { "failed" }));
        match outcome {
            Ok(detail) => reporter.step_finished(&title, true, &detail),
            Err(why) => {
                reporter.step_finished(&title, false, &why);
                failed.get_or_insert(format!("{}: {why}", name(scope)));
            }
        }
    }
    if let Some(why) = failed {
        return Err(why);
    }
    let kept: Vec<&str> = SCOPES.iter().map(|(n, _)| *n).filter(|n| !scopes.iter().any(|s| name(s) == *n)).collect();
    reporter.message(Level::Success, "Reset done", &if kept.is_empty() { "everything was reset".to_string() } else { format!("kept: {}", kept.join(", ")) });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reporting::Quiet;

    #[test]
    fn scopes_are_named_and_combine() {
        let words = |text: &str| text.split_whitespace().map(String::from).collect::<Vec<_>>();
        assert_eq!(parse(&[]).unwrap(), default_scopes());
        assert!(!default_scopes().contains(&Scope::Apps) && !default_scopes().contains(&Scope::AppSettings(None)), "plain reset keeps the applications");
        assert_eq!(parse(&words("all")).unwrap(), all_scopes());
        assert_eq!(parse(&words("cache seeds cache")).unwrap(), vec![Scope::Cache, Scope::Seeds]);
        assert_eq!(parse(&words("app-settings weather-desk apps")).unwrap(), vec![Scope::AppSettings(Some("weather-desk".into())), Scope::Apps]);
        assert_eq!(parse(&words("app-settings cache")).unwrap(), vec![Scope::AppSettings(None), Scope::Cache], "a scope is not an ID");
        assert!(parse(&words("everything")).unwrap_err().contains("no scope named everything"));
        assert!(parse(&words("app-settings ../x")).is_err());
    }

    #[test]
    fn each_scope_clears_what_it_names_and_nothing_else() {
        let _environment = crate::paths::test_environment();
        let root = std::env::temp_dir().join(format!("dstns-reset-{}-{}", std::process::id(), crate::config::fresh_seed()));
        let paths = Paths::new(&root);
        fs::create_dir_all(root.join("config")).unwrap();
        fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../config/defaults.json"), paths.config()).unwrap();
        std::env::set_var("DSTNS_SEED_DB", root.join("data/seed-store/seeds.sqlite3"));
        std::env::set_var("DSTNS_APPS_FILE", root.join("config/apps.json"));
        // A port nothing listens on: a DSTNS server running on this machine (8090, the default) must not count as
        // this test checkout's own.
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        std::env::set_var("DSTNS_API_PORT", free.to_string());
        let mut config = crate::config::load(&paths).unwrap();
        crate::config::field("api.port").unwrap().set(&mut config, serde_json::json!(9100));
        crate::config::save(&config, &paths).unwrap();
        let write = |relative: &str| {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "x").unwrap();
            path
        };
        let log = write("logs/system.log");
        let checkpoint = write("data/checkpoints/a.bin");
        let city = write("data/maps/berlin.osm.xml");
        let seeds = write("data/seed-store/seeds.sqlite3");
        let apps = write("config/apps.json");
        crate::setup::save_entries(&paths, &[("ANTHROPIC_API_KEY".into(), "k".into()), ("DSTNS_KEEP".into(), "1".into())]).unwrap();

        reset(&Quiet, &paths, &[Scope::Cache]).unwrap();
        assert!(!city.exists() && log.exists() && seeds.exists(), "cache alone");

        reset(&Quiet, &paths, &parse(&[]).unwrap()).unwrap();
        assert!(!log.exists() && !checkpoint.exists() && !seeds.exists());
        assert_eq!(crate::config::setting(&crate::config::load(&paths).unwrap(), "api.port"), serde_json::json!(8090), "settings at their defaults");
        let entries = crate::setup::entries(&paths);
        assert!(!entries.iter().any(|(k, _)| k == "ANTHROPIC_API_KEY") && entries.iter().any(|(k, _)| k == "DSTNS_KEEP"), "keys only");
        assert!(apps.exists() && !app_settings_request(&paths).exists(), "plain reset keeps the applications and their settings");

        reset(&Quiet, &paths, &parse(&["app-settings".into(), "desk".into()]).unwrap()).unwrap();
        reset(&Quiet, &paths, &parse(&["all".into()]).unwrap()).unwrap();
        assert!(!apps.exists());
        assert_eq!(fs::read_to_string(app_settings_request(&paths)).unwrap(), "desk\n*\n");
        std::env::remove_var("DSTNS_SEED_DB");
        std::env::remove_var("DSTNS_APPS_FILE");
        std::env::remove_var("DSTNS_API_PORT");
        let _ = fs::remove_dir_all(&root);
    }
}
