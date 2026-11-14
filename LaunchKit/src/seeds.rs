// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Saved seeds: named, complete run configurations, in a transactional store. IDs are database keys, never paths.
//! The schema is the one the launcher has always used, so a store from before reads the same.

use crate::errors::{LauncherError, Result};
use crate::paths::{hex, Paths};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

pub const VERSION: &str = "urban-crfg-v3";
/// The selection policies a saved seed may name: the seed means the same city under each for as long as it exists.
pub const VERSIONS: [&str; 3] = [VERSION, crate::config::GEO_V1_SELECTION_VERSION, crate::config::GEO_SELECTION_VERSION];
/// Recorded in place of a checksum when the seed, not a pinned file, chooses the map.
pub const AUTO_MAP: &str = "auto";

pub fn valid_id(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && value.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn seed_id(data: &Value) -> Result<String> {
    match data.get("id").and_then(|v| v.as_str()) {
        Some(id) if valid_id(id) => Ok(id.to_string()),
        _ => Err(LauncherError::config("Seed ID must be 1-64 letters, digits, underscores or hyphens")),
    }
}

/// Keys in sorted order, all the way down, as the store has always written them.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                out.insert(key.clone(), sorted(&map[key]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn sql(error: rusqlite::Error) -> LauncherError {
    LauncherError::config(error.to_string())
}

fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let db = Connection::open(path).map_err(sql)?;
    db.busy_timeout(std::time::Duration::from_secs(10)).map_err(sql)?;
    db.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(())).map_err(sql)?;
    db.execute(
        "CREATE TABLE IF NOT EXISTS seeds (id TEXT PRIMARY KEY, seed TEXT NOT NULL, created_at TEXT NOT NULL, description TEXT NOT NULL, map_version TEXT NOT NULL, map_sha256 TEXT NOT NULL, config_json TEXT NOT NULL)",
        [],
    )
    .map_err(sql)?;
    db.execute_batch("PRAGMA user_version=1").map_err(sql)?;
    Ok(db)
}

fn row(db: &Connection, id: &str) -> Result<Option<Value>> {
    db.query_row("SELECT id, seed, created_at, description, map_version, map_sha256, config_json FROM seeds WHERE id=?", [id], |r| {
        let config: String = r.get(6)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?, "seed": r.get::<_, String>(1)?, "created_at": r.get::<_, String>(2)?,
            "description": r.get::<_, String>(3)?, "map_version": r.get::<_, String>(4)?, "map_sha256": r.get::<_, String>(5)?,
            "config": serde_json::from_str::<Value>(&config).unwrap_or(Value::Null),
        }))
    })
    .optional()
    .map_err(sql)
}

/// `save`, `list`, `inspect`, `use` or `delete`.
pub fn operate(action: &str, data: &Value, paths: &Paths) -> Result<Value> {
    let path = paths.seed_store();
    let db = open(&path)?;
    if action == "list" {
        let mut statement = db.prepare("SELECT id, seed, created_at, description, map_version FROM seeds ORDER BY id").map_err(sql)?;
        let rows = statement
            .query_map([], |r| {
                Ok(json!({"id": r.get::<_, String>(0)?, "seed": r.get::<_, String>(1)?, "created_at": r.get::<_, String>(2)?,
                          "description": r.get::<_, String>(3)?, "map_version": r.get::<_, String>(4)?}))
            })
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        return Ok(Value::Array(rows));
    }
    let name = seed_id(data)?;
    if action == "save" {
        let mut config = data.get("config").cloned().ok_or_else(|| LauncherError::config("config"))?;
        let version = config.get("map_selection_version").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if !VERSIONS.contains(&version.as_str()) {
            return Err(LauncherError::config("Unsupported map selection version"));
        }
        let osm = config.pointer("/map/osm_file").and_then(|v| v.as_str()).unwrap_or("auto").to_string();
        let digest = if osm == "auto" {
            // The seed chooses the city, so there is no file to keep: the selection version is what makes it repeatable.
            AUTO_MAP.to_string()
        } else {
            let source = fs::canonicalize(&osm).map_err(|e| LauncherError::config(format!("{osm}: {e}")))?;
            let content = fs::read(&source)?;
            let digest = hex(&Sha256::digest(&content));
            let maps = path.parent().unwrap().join("maps");
            fs::create_dir_all(&maps)?;
            let cached = maps.join(format!("{digest}.osm.xml"));
            if !cached.exists() {
                fs::write(&cached, &content)?;
            }
            config["map"]["osm_file"] = json!(fs::canonicalize(&cached)?.to_string_lossy());
            digest
        };
        config["saved_seed_id"] = json!(name);
        let description: String = data.get("description").and_then(|v| v.as_str()).unwrap_or("").chars().take(1000).collect();
        let seed = config.get("seed").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let inserted = db.execute(
            "INSERT INTO seeds VALUES (?,?,?,?,?,?,?)",
            params![name, seed, chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false), description, version, digest, sorted(&config).to_string()],
        );
        if let Err(rusqlite::Error::SqliteFailure(error, _)) = &inserted {
            if error.code == rusqlite::ErrorCode::ConstraintViolation {
                return Err(LauncherError::config(format!("Saved seed already exists: {name}")));
            }
        }
        inserted.map_err(sql)?;
    }
    let result = row(&db, &name)?.ok_or_else(|| LauncherError::config(format!("Unknown saved seed: {name}")))?;
    match action {
        "use" => {
            if !VERSIONS.iter().any(|v| result["map_version"] == json!(v)) {
                return Err(LauncherError::config("Saved seed requires an unsupported map version"));
            }
            if result["map_sha256"] != json!(AUTO_MAP) {
                let source = result.pointer("/config/map/osm_file").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let bytes = fs::read(&source).map_err(|e| LauncherError::config(format!("{source}: {e}")))?;
                if json!(hex(&Sha256::digest(&bytes))) != result["map_sha256"] {
                    return Err(LauncherError::config("Saved map content changed; refusing a non-reproducible run"));
                }
            }
            Ok(result)
        }
        "delete" => {
            db.execute("DELETE FROM seeds WHERE id=?", [&name]).map_err(sql)?;
            Ok(json!({"deleted": name}))
        }
        "save" | "inspect" => Ok(result),
        _ => Err(LauncherError::config("Unknown saved-seed action")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Paths {
        let dir = std::env::temp_dir().join(format!("dstns-seeds-{}-{}", std::process::id(), crate::config::fresh_seed()));
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("DSTNS_SEED_DB", dir.join("seeds.sqlite3"));
        Paths::new(dir)
    }

    #[test]
    fn a_seed_saves_lists_and_deletes() {
        let _environment = crate::paths::test_environment();
        let paths = store();
        let config = json!({"seed": "42", "map": {"osm_file": "auto"}, "map_selection_version": VERSION, "day": 0});
        let saved = operate("save", &json!({"id": "demo", "description": "a note", "config": config}), &paths).unwrap();
        assert_eq!(saved["config"]["saved_seed_id"], json!("demo"));
        assert_eq!(saved["map_sha256"], json!(AUTO_MAP));
        assert!(operate("save", &json!({"id": "demo", "config": config}), &paths).unwrap_err().message.contains("already exists"));
        assert_eq!(operate("list", &json!({}), &paths).unwrap().as_array().unwrap().len(), 1);
        assert_eq!(operate("use", &json!({"id": "demo"}), &paths).unwrap()["seed"], json!("42"));
        operate("delete", &json!({"id": "demo"}), &paths).unwrap();
        assert!(operate("inspect", &json!({"id": "demo"}), &paths).unwrap_err().message.contains("Unknown saved seed"));
        std::env::remove_var("DSTNS_SEED_DB");
    }

    #[test]
    fn ids_are_names_not_paths() {
        assert!(valid_id("demo_1-2"));
        assert!(!valid_id("../escape"));
        assert!(!valid_id("-leading"));
        assert!(!valid_id(""));
    }
}
