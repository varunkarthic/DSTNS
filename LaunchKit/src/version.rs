// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Version and licence metadata, read from the project rather than repeated. The engine version is defined once, in
//! `project(dstns VERSION ...)` in CMakeLists.txt; the observer's in WebKit/package.json.

use crate::paths;
use regex::Regex;
use std::sync::OnceLock;

pub const PRODUCT: &str = "DSTNS";
pub const FULL_NAME: &str = "Deterministic Spatiotemporal Transport Network Simulator";
pub const COPYRIGHT_ASCII: &str = "(C) 2026 Varun Karthic";
pub const LICENSE_SPDX: &str = "AGPL-3.0-or-later";
pub const LICENSE_NAME: &str = "GNU Affero General Public License v3.0 or later";
pub const OSM_ATTRIBUTION: &str = "© OpenStreetMap contributors";
pub const OSM_LICENSE: &str = "Open Data Commons Open Database License (ODbL)";
pub const REPOSITORY: &str = "https://github.com/varunkarthic/DSTNS";
pub const DOCUMENTATION: &str = "https://dstns.readthedocs.io/";

/// The DSTNS version, or "unknown" if CMakeLists.txt cannot be read.
pub fn engine_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        let text = std::fs::read_to_string(paths::root().join("CMakeLists.txt")).unwrap_or_default();
        let pattern = Regex::new(r"(?i)project\(\s*dstns\s+VERSION\s+([0-9]+(?:\.[0-9]+){1,3})").unwrap();
        pattern.captures(&text).map(|c| c[1].to_string()).unwrap_or_else(|| "unknown".into())
    })
}

pub fn observer_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        std::fs::read_to_string(paths::root().join("WebKit").join("package.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|value| value.get("version").and_then(|v| v.as_str()).map(String::from))
            .unwrap_or_else(|| "unknown".into())
    })
}

/// Every part's version, for `./launcher version`: the launcher, the server as built (with its API contract and its
/// engines, from `dstns_server --version`), the observer, and the engine policy.
pub fn parts(paths: &paths::Paths) -> Vec<(String, String)> {
    let mut out = vec![("Launcher".to_string(), env!("CARGO_PKG_VERSION").to_string())];
    let (code, text, _) = crate::process::capture(&[&paths.server().to_string_lossy(), "--version"], None, 10.0, &[]);
    let field = |name: &str| text.lines().find_map(|l| l.strip_prefix(name)).map(|v| v.trim().to_string());
    let mut engines = vec![];
    if code == 0 {
        let server = text.lines().next().and_then(|l| l.strip_prefix("DSTNS ")).unwrap_or("unknown").trim().to_string();
        let built = field("Built:").unwrap_or_default();
        out.push(("Server".into(), format!("{server} ({} channel, built {built})", field("Channel:").unwrap_or_else(|| "local".into()))));
        out.push(("API contract".into(), field("API:").unwrap_or_else(|| "unknown".into())));
        for line in text.lines().filter_map(|l| l.strip_prefix("Engine:")) {
            let words: Vec<&str> = line.split_whitespace().collect();
            if let [id, version, channel, kind] = words[..] {
                engines.push((id.to_string(), format!("{version} ({channel}, {kind})")));
            }
        }
    } else {
        out.push(("Server".into(), format!("{} (not built yet: ./launcher start builds it)", engine_version())));
    }
    out.push(("Observer".into(), observer_version().to_string()));
    let policy = std::fs::read_to_string(paths.engines_config()).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_default();
    for (n, (id, about)) in engines.iter().enumerate() {
        let mut state = vec![];
        if policy.get("default").and_then(|v| v.as_str()) == Some(id) {
            state.push("default");
        }
        if policy.get("selected").and_then(|v| v.as_str()) == Some(id) {
            state.push("selected");
        }
        if policy.pointer(&format!("/engines/{id}/enabled")).and_then(|v| v.as_bool()) == Some(false) {
            state.push("disabled");
        }
        let label = if n == 0 { "Engines" } else { "" };
        out.push((label.into(), format!("{id} {about}{}", if state.is_empty() { String::new() } else { format!(": {}", state.join(", ")) })));
    }
    out
}

pub fn licence_lines(unicode: bool) -> Vec<String> {
    let copyright = if unicode { "Copyright © 2026 Varun Karthic".to_string() } else { format!("Copyright {COPYRIGHT_ASCII}") };
    let osm = if unicode { OSM_ATTRIBUTION } else { "(C) OpenStreetMap contributors" };
    vec![
        copyright,
        format!("Licence {LICENSE_SPDX}: this is free software, and you are welcome to"),
        "redistribute it under certain conditions; see LICENSE.".into(),
        "It comes with ABSOLUTELY NO WARRANTY.".into(),
        format!("Map data {osm}, available under the ODbL."),
    ]
}
