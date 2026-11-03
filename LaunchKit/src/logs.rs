// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Reading the server's logs: the text system log and the SQLite journal.

use crate::paths::Paths;
use rusqlite::{Connection, OpenFlags};
use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Seek, SeekFrom};

/// (source, table, label) for each journal table.
pub const TABLES: &[(&str, &str, &str)] = &[("api", "api_log", "API requests"), ("event", "event_log", "Operator events"), ("playback", "lifecycle_log", "Lifecycle changes")];

pub fn sources() -> Vec<(&'static str, &'static str)> {
    let mut out = vec![("system", "System log")];
    out.extend(TABLES.iter().map(|(key, _, label)| (*key, *label)));
    out
}

/// The last `lines` lines of system.log, or None if there is none yet.
pub fn system_tail(lines: usize, paths: &Paths) -> Option<Vec<String>> {
    let text = fs::read(paths.system_log()).ok()?;
    let text = String::from_utf8_lossy(&text);
    let mut kept: VecDeque<String> = VecDeque::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        kept.push_back(line.to_string());
        if kept.len() > lines {
            kept.pop_front();
        }
    }
    Some(kept.into_iter().collect())
}

pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// The newest rows of one journal table, oldest first; None before the first run.
pub fn journal(source: &str, limit: usize, paths: &Paths) -> Option<Table> {
    let table = TABLES.iter().find(|(key, _, _)| *key == source)?.1;
    let path = paths.runtime_db();
    if !path.exists() {
        return None;
    }
    // Read-only, so inspecting logs can never interfere with the server writing them.
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).or_else(|_| Connection::open(&path)).ok()?;
    let _ = db.busy_timeout(std::time::Duration::from_secs(2));
    let mut statement = db.prepare(&format!("SELECT * FROM {table} ORDER BY id DESC LIMIT ?")).ok()?;
    let columns: Vec<String> = statement.column_names().iter().map(|c| c.to_string()).collect();
    let count = columns.len();
    let mut rows: Vec<Vec<String>> = statement
        .query_map([limit as i64], |r| {
            Ok((0..count)
                .map(|i| match r.get_ref(i) {
                    Ok(rusqlite::types::ValueRef::Null) | Err(_) => String::new(),
                    Ok(rusqlite::types::ValueRef::Integer(n)) => n.to_string(),
                    Ok(rusqlite::types::ValueRef::Real(f)) => f.to_string(),
                    Ok(rusqlite::types::ValueRef::Text(t)) => String::from_utf8_lossy(t).into_owned(),
                    Ok(rusqlite::types::ValueRef::Blob(_)) => "<blob>".into(),
                })
                .collect())
        })
        .ok()?
        .filter_map(|r| r.ok())
        .collect();
    rows.reverse();
    Some(Table { columns, rows })
}

/// Reads lines appended to system.log since the last call.
#[derive(Default)]
pub struct Follower {
    offset: Option<u64>,
}

impl Follower {
    pub fn read(&mut self, paths: &Paths, limit: usize) -> Vec<String> {
        let path = paths.system_log();
        let Ok(size) = fs::metadata(&path).map(|m| m.len()) else { return vec![] };
        let mut partial = false;
        if self.offset.map(|o| size < o).unwrap_or(true) {
            // First read, or the file was reset: show only the recent past.
            let offset = if self.offset.is_none() { size.saturating_sub(4000) } else { 0 };
            partial = offset > 0;
            self.offset = Some(offset);
        }
        let offset = self.offset.unwrap();
        if size == offset {
            return vec![];
        }
        let mut chunk = vec![];
        if let Ok(mut file) = fs::File::open(&path) {
            let _ = file.seek(SeekFrom::Start(offset));
            let _ = file.take(size - offset).read_to_end(&mut chunk);
        }
        self.offset = Some(size);
        let text = String::from_utf8_lossy(&chunk);
        let mut lines: Vec<String> = text.lines().map(String::from).collect();
        if partial && !lines.is_empty() {
            lines.remove(0);
        }
        let lines: Vec<String> = lines.into_iter().filter(|l| !l.trim().is_empty()).collect();
        lines[lines.len().saturating_sub(limit)..].to_vec()
    }
}
