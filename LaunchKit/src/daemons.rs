// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launcher's side of the server's daemons: it tells the Resource Control Subsystem which processes are its own and
//! its applications', and it listens to both daemon queues, logging what they say and showing warnings and worse.

use crate::paths::Paths;
use crate::session::Session;
use serde_json::{json, Value};
use std::sync::Arc;

/// Where the listener keeps its place in the two queues, and hands on what it heard.
pub struct Inbox {
    heard: Box<dyn Fn() -> Option<(u64, u64)> + Send>,
    keep: Box<dyn Fn((u64, u64), Vec<Value>) + Send>,
}

impl Inbox {
    pub fn new(heard: impl Fn() -> Option<(u64, u64)> + Send + 'static, keep: impl Fn((u64, u64), Vec<Value>) + Send + 'static) -> Self {
        Self { heard: Box::new(heard), keep: Box::new(keep) }
    }
}

/// Once each poll: the processes, then whatever is new on the queues. Quiet when the daemons are off or absent.
pub fn report_and_listen(port: u16, paths: &Paths, session: &Arc<Session>, inbox: &Inbox) {
    let _ = crate::api::call(port, "/api/v1/daemon/rcs/processes", "PUT", Some(&json!({"module": "launcher", "pids": [std::process::id()]})), 2.0, paths);
    let applications: Vec<u32> = session.supervisor().map(|s| s.pids()).unwrap_or_default();
    let _ = crate::api::call(port, "/api/v1/daemon/rcs/processes", "PUT", Some(&json!({"module": "applications", "pids": applications})), 2.0, paths);
    let read = |queue: &str, since: u64| -> Option<Value> {
        let r = crate::api::get(port, &format!("/api/v1/daemon/{queue}-queue?since={since}"), 3.0, paths);
        (r.code == 200).then(|| r.body["data"].clone())
    };
    // From what is there when first heard: what happened before this launcher was listening is not news to it.
    let (mut emergency, mut notification) = match (inbox.heard)() {
        Some(heard) => heard,
        None => {
            let overview = crate::api::get(port, "/api/v1/daemon", 3.0, paths).body;
            let latest = |q: &str| overview["data"]["queues"][q]["latest_sequence"].as_u64();
            match (latest("daemonEmergencyQueue"), latest("daemonNotificationQueue")) {
                (Some(e), Some(n)) => (e, n),
                _ => return,
            }
        }
    };
    let mut said = vec![];
    for (queue, cursor) in [("emergency", &mut emergency), ("notification", &mut notification)] {
        let Some(data) = read(queue, *cursor) else { continue };
        *cursor = data["latest_sequence"].as_u64().unwrap_or(*cursor);
        for message in data["items"].as_array().cloned().unwrap_or_default() {
            let line = format!("daemon {}: {} — {}", message["daemon"].as_str().unwrap_or(""), message["title"].as_str().unwrap_or(""), message["text"].as_str().unwrap_or(""));
            match message["level"].as_str().unwrap_or("info") {
                "info" => crate::log::info(&line),
                "warning" => crate::log::warn(&line),
                _ => crate::log::error(&line),
            }
            said.push(message);
        }
    }
    (inbox.keep)((emergency, notification), said);
}
