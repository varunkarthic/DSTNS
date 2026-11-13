// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Every file in config/ has the same shape: `$schema` (its JSON Schema in config/schema/, which editors use to check
//! it and to explain each value as it is typed), `schema_version`, `_about` (what the file is, who reads it, when a
//! change applies) and `_help` (each editable value: what it means, what it accepts, its default), then the values.
//!
//! For the launcher's three files (defaults.json, ui-config.json, engines.json) the schema and `_help` are generated
//! from the settings table (config::fields), so they cannot drift from what the launcher accepts. `./launcher config
//! docs` writes them; a test fails when the committed ones differ.

use crate::config::{self, Field, FieldKind};
use crate::paths::Paths;
use serde_json::{json, Map, Value};
use std::fs;

/// The launcher's files: (file, the prefix of its settings' keys, what it is).
pub const FILES: &[(&str, &str, &str, i64)] = &[
    (
        "defaults.json",
        "",
        "The simulation's and the launcher's settings. The launcher edits this file (./launcher config, or Settings in its interface) and checks every value; edit it by hand with the same care. Most values apply from the next start. Values marked informational are fixed by the engine and only described here.",
        2,
    ),
    (
        "ui-config.json",
        "ui.",
        "Defaults for the observer interface. Presentation only: nothing here changes what the simulation computes. A viewer's own choices, kept in their browser, come first. Reset in the Layers panel returns the layers to this file.",
        2,
    ),
    (
        "engines.json",
        "engines.",
        "Engine policy, read by the launcher and by the server as it starts: which engines may run, which one the launcher starts, and how a run on an alpha or beta engine is acknowledged (docs/design/engine-governance.md). Each engine's version, kind and release channel come from the build, not from this file.",
        1,
    ),
];

/// The settings stored in a file: ui.* in ui-config.json, engines.* in engines.json, the rest in defaults.json.
fn belongs(field: &Field, prefix: &str) -> bool {
    if prefix.is_empty() {
        !field.key.starts_with("ui.") && !field.key.starts_with("engines.")
    } else {
        field.key.starts_with(prefix)
    }
}

/// One line for a value: what it is, what it accepts, its default.
pub fn help_line(field: &Field) -> String {
    let accepts = match field.kind {
        FieldKind::Boolean => "true or false".to_string(),
        FieldKind::Choice => field.choices.iter().map(|(label, value)| format!("{} ({label})", value)).collect::<Vec<_>>().join(", "),
        FieldKind::Integer | FieldKind::Number => {
            let whole = if field.kind == FieldKind::Integer { "a whole number" } else { "a number" };
            let unit = if field.unit.is_empty() { String::new() } else { format!(" {}", field.unit) };
            match (field.minimum, field.maximum) {
                (Some(min), Some(max)) if field.exclusive_minimum => format!("{whole} above {} and at most {}{unit}", config::fmt_g(min), config::fmt_g(max)),
                (Some(min), Some(max)) => format!("{whole} from {} to {}{unit}", config::fmt_g(min), config::fmt_g(max)),
                (Some(min), None) => format!("{whole}, at least {}{unit}", config::fmt_g(min)),
                _ => format!("{whole}{unit}"),
            }
        }
        FieldKind::Text => "text".to_string(),
    };
    format!("{} ({}). {} Accepts: {accepts}. Default: {}.", field.label, field.category, field.help, field.default)
}

fn property(field: &Field) -> Value {
    let mut out = json!({"title": field.label, "description": help_line(field), "default": field.default});
    match field.kind {
        FieldKind::Boolean => out["type"] = json!("boolean"),
        FieldKind::Text => out["type"] = json!("string"),
        FieldKind::Choice => out["enum"] = Value::Array(field.choices.iter().map(|(_, v)| v.clone()).collect()),
        FieldKind::Integer | FieldKind::Number => {
            out["type"] = json!(if field.kind == FieldKind::Integer { "integer" } else { "number" });
            if let Some(min) = field.minimum {
                out[if field.exclusive_minimum { "exclusiveMinimum" } else { "minimum" }] = json!(min);
            }
            if let Some(max) = field.maximum {
                out["maximum"] = json!(max);
            }
        }
    }
    out
}

/// Put `value` at a dotted path of nested JSON Schema objects.
fn place(schema: &mut Value, path: &[&str], value: Value) {
    let mut node = schema;
    for part in &path[..path.len() - 1] {
        let properties = node.as_object_mut().unwrap().entry("properties").or_insert_with(|| json!({}));
        node = properties.as_object_mut().unwrap().entry(part.to_string()).or_insert_with(|| json!({"type": "object"}));
    }
    node.as_object_mut().unwrap().entry("properties").or_insert_with(|| json!({}))[path[path.len() - 1]] = value;
}

fn header_schema(version: i64) -> Value {
    json!({
        "$schema": {"type": "string", "description": "This file's JSON Schema, for editors."},
        "schema_version": {"const": version, "description": "The layout of this file. A launcher refuses one newer than it reads."},
        "_about": {"type": "string", "description": "What this file is. Not read by any program."},
        "_help": {"type": "object", "description": "Each editable value: what it means, what it accepts, its default. Not read by any program; ./launcher config docs writes it.", "additionalProperties": {"type": "string"}},
    })
}

/// The JSON Schema of one of the launcher's files.
pub fn schema(file: &str) -> Value {
    let (_, prefix, about, version) = FILES.iter().find(|(f, ..)| *f == file).expect("a launcher file");
    let mut out = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": format!("https://dstns.readthedocs.io/config/schema/{}", file.replace(".json", ".schema.json")),
        "title": format!("config/{file}"),
        "description": about,
        "type": "object",
        "properties": header_schema(*version),
    });
    for field in config::fields().iter().filter(|f| belongs(f, prefix)) {
        let key = field.key.strip_prefix(prefix).unwrap_or(field.key);
        place(&mut out, &key.split('.').collect::<Vec<_>>(), property(field));
    }
    if prefix.is_empty() {
        for key in config::INFORMATIONAL.iter().filter(|k| **k != "schema_version") {
            place(&mut out, &key.split('.').collect::<Vec<_>>(), json!({"description": "Informational: the engine fixes this value; it is only described here."}));
        }
    }
    out
}

/// `_help` for one of the launcher's files.
pub fn help(file: &str) -> Value {
    let (_, prefix, ..) = FILES.iter().find(|(f, ..)| *f == file).expect("a launcher file");
    let mut out = Map::new();
    for field in config::fields().iter().filter(|f| belongs(f, prefix)) {
        out.insert(field.key.strip_prefix(prefix).unwrap_or(field.key).to_string(), json!(help_line(field)));
    }
    if prefix.is_empty() {
        for key in config::INFORMATIONAL.iter().filter(|k| **k != "schema_version") {
            out.insert(key.to_string(), json!("Informational: the engine fixes this value; it is only described here."));
        }
    }
    Value::Object(out)
}

/// A file's values under the common header, in that order, keeping every value as it is.
pub fn with_header(file: &str, values: &Value, version: i64, about: &str, help: Value) -> Value {
    let mut out = Map::new();
    out.insert("$schema".into(), json!(format!("./schema/{}", file.replace(".json", ".schema.json"))));
    out.insert("schema_version".into(), json!(version));
    out.insert("_about".into(), json!(about));
    out.insert("_help".into(), help);
    if let Some(object) = values.as_object() {
        for (key, value) in object {
            // What older layouts said about themselves gives way to the header.
            if !["$schema", "schema_version", "_about", "_help", "_comment", "_enums"].contains(&key.as_str()) {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// `./launcher config docs`: write each launcher file's schema, and its header, leaving every value as it is.
pub fn write(paths: &Paths) -> std::io::Result<Vec<String>> {
    let directory = paths.root.join("config");
    fs::create_dir_all(directory.join("schema"))?;
    let mut written = vec![];
    for (file, _, about, version) in FILES {
        let schema_path = directory.join("schema").join(file.replace(".json", ".schema.json"));
        fs::write(&schema_path, serde_json::to_string_pretty(&schema(file)).unwrap() + "\n")?;
        let path = directory.join(file);
        let values: Value = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
        let headed = with_header(file, &values, *version, about, help(file));
        if headed != values {
            let temporary = path.with_extension("json.tmp");
            fs::write(&temporary, serde_json::to_string_pretty(&headed).unwrap() + "\n")?;
            fs::rename(&temporary, &path)?;
        }
        written.push(format!("config/{file} and config/schema/{}", file.replace(".json", ".schema.json")));
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn committed(path: &str) -> Value {
        serde_json::from_str(&fs::read_to_string(format!("{}/../config/{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap()
    }

    #[test]
    fn the_committed_schemas_and_help_are_the_settings_table() {
        for (file, _, _, version) in FILES {
            let name = file.replace(".json", ".schema.json");
            assert_eq!(committed(&format!("schema/{name}")), schema(file), "config/schema/{name} is stale: run ./launcher config docs");
            let values = committed(file);
            assert_eq!(values["_help"], help(file), "config/{file}'s _help is stale: run ./launcher config docs");
            assert_eq!(values["schema_version"], json!(version));
            assert_eq!(values["$schema"], json!(format!("./schema/{name}")));
        }
    }

    #[test]
    fn every_file_in_config_has_the_header() {
        for entry in fs::read_dir(format!("{}/../config", env!("CARGO_MANIFEST_DIR"))).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let value: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            for key in ["$schema", "schema_version", "_about", "_help"] {
                assert!(value.get(key).is_some(), "{} has no {key}", path.display());
            }
            let schema = path.parent().unwrap().join(value["$schema"].as_str().unwrap());
            assert!(schema.exists(), "{} names {}, which is missing", path.display(), schema.display());
        }
    }
}
