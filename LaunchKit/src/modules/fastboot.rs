// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! `./launcher fastboot`: every city's map, downloaded in advance and kept compressed.
//!
//! With Fast Boot on, the server unpacks the city a seed chooses from here, which takes a moment and needs no network,
//! instead of downloading it, which can take a minute. Downloading all of them takes a long while, since each comes from
//! a volunteer-run Overpass server, one at a time and with a pause between, as their usage policy asks. It can be
//! stopped at any point and carries on from where it got to. A city already in the map cache is compressed from there.

use super::{Command, Module, Options};
use crate::cli::{Context, EXIT_FAILURE, EXIT_OK};
use crate::config;
use crate::errors::{LauncherError, Result};
use crate::paths::Paths;
use crate::process::{Cancel, Run};
use crate::reporting::Level;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

const PAUSE_S: f64 = 2.0;

const USAGE: &str = "usage: ./launcher fastboot [download|status|clear]

  download [--cities LIST] [--limit N]
                            Download every city not yet here. Stop with Ctrl+C, and carry on later.
                            --cities names some, by name or key (london, london_x5000)
  status                    How many cities are here, and how much room they take
  clear [--yes]             Delete them all
";

pub fn module() -> Module {
    Module {
        commands: vec![Command { name: "fastboot", usage: "fastboot [download|status|clear]", summary: "Every city's map in advance, so that Fast Boot starts in seconds", run }],
        pages: vec![],
    }
}

/// Every city a seed can choose, as the server knows them, for the extent the configuration uses.
pub fn cities(paths: &Paths) -> Result<Vec<Value>> {
    let extent = config::load(paths).ok().and_then(|c| c.pointer("/map/city_extent_m").and_then(|v| v.as_i64())).unwrap_or(5000);
    let (code, out, _) = crate::process::capture(&[&paths.server().to_string_lossy(), "--list-cities", &extent.to_string()], None, 30.0, &[]);
    if code != 0 {
        return Err(LauncherError::generic("The server could not list its cities.").remedy("Build it first: ./launcher start builds it."));
    }
    serde_json::from_str(out.trim()).map_err(|e| LauncherError::generic(format!("The server's list of cities could not be read: {e}")))
}

/// Every country a world can be in: (ISO code, name, cities), by name. Read from the server once a process; empty if
/// the server is not built yet.
pub fn countries(paths: &Paths) -> &'static [(String, String, usize)] {
    static COUNTRIES: std::sync::OnceLock<Vec<(String, String, usize)>> = std::sync::OnceLock::new();
    COUNTRIES.get_or_init(|| {
        let mut by_code: std::collections::BTreeMap<String, (String, usize)> = std::collections::BTreeMap::new();
        for c in cities(paths).unwrap_or_default() {
            let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            by_code.entry(text("country_code")).or_insert_with(|| (text("country"), 0)).1 += 1;
        }
        let mut out: Vec<(String, String, usize)> = by_code.into_iter().filter(|(code, _)| !code.is_empty()).map(|(code, (name, n))| (code, name, n)).collect();
        out.sort_by(|a, b| a.1.cmp(&b.1));
        out
    })
}

/// The policies a city may be chosen under, by the first whose catalogue has it.
pub fn policies(since: &str) -> &'static str {
    if since == "urban-geo-v2" { "urban-geo-v2" } else { "urban-crfg-v3 urban-geo-v1 urban-geo-v2" }
}

/// Cities as CSV, one row each: what Tools, Supported cities and `./launcher cities export` save.
pub fn csv(cities: &[&Value]) -> String {
    let quote = |s: &str| if s.contains([',', '"']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() };
    let mut out = String::from("city,id,country,country_code,lat,lon,policies\n");
    for c in cities {
        let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let number = |k: &str| c.get(k).and_then(Value::as_f64).map(|v| format!("{v:.4}")).unwrap_or_default();
        out += &format!("{},{},{},{},{},{},{}\n", quote(&text("city")), text("id"), quote(&text("country")), text("country_code"), number("lat"), number("lon"), policies(&text("since")));
    }
    out
}

pub fn packed(paths: &Paths, key: &str) -> PathBuf {
    paths.fastboot().join(format!("{key}.osm.xml.gz"))
}

/// Compressed beside the target and renamed, so that what is there is always whole.
pub fn pack(source: &Path, target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = target.with_extension("gz.tmp");
    {
        let mut reading = fs::File::open(source)?;
        let mut writing = GzEncoder::new(fs::File::create(&temporary)?, Compression::best());
        io::copy(&mut reading, &mut writing)?;
        writing.finish()?;
    }
    fs::rename(temporary, target)
}

pub fn here(paths: &Paths) -> (usize, u64) {
    let entries: Vec<u64> = fs::read_dir(paths.fastboot())
        .map(|e| e.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".osm.xml.gz")).filter_map(|e| e.metadata().ok()).map(|m| m.len()).collect())
        .unwrap_or_default();
    (entries.len(), entries.iter().sum())
}

fn download(context: &Context, options: &Options) -> Result<i32> {
    let out = &context.out;
    let paths = &context.paths;
    let everything = cities(paths)?;
    let key = |c: &Value| c["key"].as_str().unwrap_or("").to_string();
    let wanted: Option<Vec<String>> = options.value("--cities").map(|v| v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect());
    let chosen: Vec<&Value> = everything
        .iter()
        .filter(|c| wanted.as_ref().map(|w| w.contains(&c["city"].as_str().unwrap_or("").to_lowercase()) || w.contains(&key(c))).unwrap_or(true))
        .collect();
    if wanted.is_some() && chosen.is_empty() {
        return Err(LauncherError::config(format!("None of {} is a city a seed can choose.", options.value("--cities").unwrap_or_default())).remedy("./launcher fastboot status lists them."));
    }
    let mut missing: Vec<&Value> = chosen.iter().copied().filter(|c| !packed(paths, &key(c)).exists()).collect();
    out.message(Level::Info, &format!("{} of {} cities are here", chosen.len() - missing.len(), chosen.len()), &format!("{} to get", missing.len()));
    if let Some(limit) = options.value("--limit").and_then(|l| l.parse::<usize>().ok()) {
        missing.truncate(limit);
    }
    let cache = crate::server::maps(paths);
    let mut failed: Vec<String> = vec![];
    crate::signals::graceful(true);
    let cancel = Cancel::new();
    let watcher = cancel.clone();
    std::thread::spawn(move || {
        while !watcher.is_set() {
            if crate::signals::interrupted() {
                watcher.set();
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    let total = missing.len();
    for (number, city) in missing.into_iter().enumerate() {
        if cancel.is_set() {
            break;
        }
        let city_key = key(city);
        let target = packed(paths, &city_key);
        let cached = cache.join(format!("{city_key}.osm.xml"));
        let label = format!("{} of {total}: {}, {}", number + 1, city["city"].as_str().unwrap_or(""), city["country"].as_str().unwrap_or(""));
        if cached.metadata().map(|m| m.len() > 4096).unwrap_or(false) {
            pack(&cached, &target)?;
            out.message(Level::Success, &label, "from the map cache");
            continue;
        }
        let temporary = paths.fastboot().join(format!("{city_key}.osm.xml.download"));
        fs::create_dir_all(paths.fastboot())?;
        let _ = fs::remove_file(&temporary);
        out.message(Level::Info, &label, "downloading");
        let command = vec![
            paths.server().to_string_lossy().into_owned(),
            "--fetch-osm".into(),
            format!("--bbox={}", city["bbox"].as_str().unwrap_or("")),
            "--output".into(),
            temporary.to_string_lossy().into_owned(),
        ];
        let result = Run::new(command).cwd(&paths.root).unchecked().timeout(900.0).cancel(&cancel).run(|_| {});
        match result {
            Err(error) if error.is_cancelled() => {
                let _ = fs::remove_file(&temporary);
                break;
            }
            Ok(done) if done.code == 0 && temporary.exists() => {
                pack(&temporary, &target)?;
                out.message(Level::Success, &label, &format!("{:.1} MB compressed", fs::metadata(&target).map(|m| m.len()).unwrap_or(0) as f64 / 1e6));
            }
            other => {
                failed.push(city["city"].as_str().unwrap_or("").to_string());
                let reason = match other {
                    Ok(done) if done.timed_out => "it took over 15 minutes".to_string(),
                    Ok(done) => done.output.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("no reason given").to_string(),
                    Err(error) => error.message,
                };
                out.message(Level::Warning, &format!("{} did not download", city["city"].as_str().unwrap_or("")), &reason);
            }
        }
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(format!("{}.progress", temporary.display()));
        if number + 1 < total && cancel.wait(PAUSE_S) {
            break;
        }
    }
    let stopped = cancel.is_set();
    cancel.set();
    crate::signals::graceful(false);
    if stopped {
        out.blank();
        out.message(Level::Info, "Stopped", "Run it again to carry on from here.");
        return Ok(EXIT_OK);
    }
    if !failed.is_empty() {
        out.message(Level::Warning, &format!("{} did not download", failed.len()), &format!("{}. Run this again to try them again.", failed.join(", ")));
        return Ok(EXIT_FAILURE);
    }
    out.message(Level::Success, "Fast Boot has its cities", "Turn it on with ./launcher config, under Startup.");
    Ok(EXIT_OK)
}

fn run(context: &Context) -> Result<i32> {
    let options = Options::parse(&context.args.rest, &["--cities", "--limit"], &["--yes", "-y", "--help", "-h"])?;
    if options.has("--help") || options.has("-h") {
        print!("{USAGE}");
        return Ok(EXIT_OK);
    }
    let out = &context.out;
    let paths = &context.paths;
    match options.positional.first().map(String::as_str).unwrap_or("status") {
        "download" => download(context, &options),
        "clear" => {
            let yes = options.has("--yes") || options.has("-y");
            if !yes && !(context.caps.interactive && out.confirm(&format!("Delete every city in {}?", paths.fastboot().display()), false)) {
                out.message(Level::Info, "Nothing deleted", "");
                return Ok(EXIT_OK);
            }
            let _ = fs::remove_dir_all(paths.fastboot());
            out.message(Level::Success, "Deleted", "");
            Ok(EXIT_OK)
        }
        "status" => {
            let everything = cities(paths)?;
            let (count, size) = here(paths);
            let on = config::load(paths).map(|c| config::flag(&c, "startup.fast_boot")).unwrap_or(false);
            out.pairs(
                &[
                    ("Cities here".into(), format!("{count} of {}", everything.len())),
                    ("Room taken".into(), format!("{:.0} MB", size as f64 / 1e6)),
                    ("Kept in".into(), paths.fastboot().to_string_lossy().into_owned()),
                    ("Fast Boot".into(), if on { "on".into() } else { "off (./launcher config, under Startup)".to_string() }),
                ],
                14,
            );
            let missing: Vec<&str> = everything.iter().filter(|c| !packed(paths, c["key"].as_str().unwrap_or("")).exists()).filter_map(|c| c["city"].as_str()).collect();
            if !missing.is_empty() && missing.len() <= 20 {
                out.muted(&format!("Still to get: {}", missing.join(", ")));
            }
            Ok(EXIT_OK)
        }
        other => Err(LauncherError::config(format!("Unknown action {other}.")).remedy("./launcher fastboot --help lists them.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn a_packed_city_unpacks_to_the_same_bytes() {
        let dir = std::env::temp_dir().join(format!("dstns-pack-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("city.osm.xml"), "<osm>roads</osm>").unwrap();
        pack(&dir.join("city.osm.xml"), &dir.join("out/city.osm.xml.gz")).unwrap();
        let mut text = String::new();
        flate2::read::GzDecoder::new(fs::File::open(dir.join("out/city.osm.xml.gz")).unwrap()).read_to_string(&mut text).unwrap();
        assert_eq!(text, "<osm>roads</osm>");
        assert!(!dir.join("out/city.osm.xml.gz.tmp").exists());
        fs::remove_dir_all(dir).ok();
    }
}
