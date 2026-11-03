// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! What the launcher asks of the Fabric API, as the operator.

use crate::api::{self, Response};
use crate::paths::Paths;
use serde_json::{json, Value};

const BASE: &str = "/api/v1/fabric";

fn items(response: Response) -> Vec<Value> {
    response.data().and_then(|d| d.get("items")).and_then(|i| i.as_array()).cloned().unwrap_or_default()
}

pub fn apps(port: u16, paths: &Paths) -> Vec<Value> {
    items(api::get(port, &format!("{BASE}/apps"), 5.0, paths))
}

pub fn health(port: u16, id: &str, paths: &Paths) -> Option<Value> {
    api::get(port, &format!("{BASE}/apps/{id}/health"), 5.0, paths).data().cloned()
}

pub fn describe(port: u16, id: &str, paths: &Paths) -> Option<Value> {
    api::get(port, &format!("{BASE}/apps/{id}"), 5.0, paths).data().cloned()
}

pub fn grant(port: u16, id: &str, capabilities: &[String], paths: &Paths) -> Response {
    api::call(port, &format!("{BASE}/apps/{id}/grants"), "PUT", Some(&json!({"capabilities": capabilities})), 5.0, paths)
}

pub fn settings(port: u16, id: &str, paths: &Paths) -> Option<Value> {
    api::get(port, &format!("{BASE}/apps/{id}/settings"), 5.0, paths).data().cloned()
}

pub fn update_settings(port: u16, id: &str, values: &Value, paths: &Paths) -> Response {
    api::call(port, &format!("{BASE}/apps/{id}/settings"), "PUT", Some(values), 5.0, paths)
}

pub fn proposals(port: u16, paths: &Paths) -> Vec<Value> {
    items(api::get(port, &format!("{BASE}/launch"), 5.0, paths))
}

pub fn withdraw(port: u16, id: &str, paths: &Paths) -> Response {
    api::call(port, &format!("{BASE}/launch/{id}"), "DELETE", None, 5.0, paths)
}

pub fn set_plan(port: u16, plan: Option<&Value>, paths: &Paths) {
    match plan {
        None => {
            api::call(port, &format!("{BASE}/launch/plan"), "DELETE", None, 3.0, paths);
        }
        Some(plan) => {
            api::call(port, &format!("{BASE}/launch/plan"), "PUT", Some(plan), 3.0, paths);
        }
    }
}

pub fn security(port: u16, paths: &Paths) -> Option<Value> {
    api::get(port, &format!("{BASE}/security"), 5.0, paths).data().cloned()
}

pub fn audit(port: u16, limit: usize, paths: &Paths) -> Vec<Value> {
    items(api::get(port, &format!("{BASE}/audit?limit={limit}"), 5.0, paths))
}

pub fn capabilities(port: u16, paths: &Paths) -> Option<Value> {
    api::get(port, &format!("{BASE}/capabilities"), 5.0, paths).data().cloned()
}

pub fn set_launch_key(port: u16, id: &str, key_sha256: &str, paths: &Paths) -> Response {
    api::call(port, &format!("{BASE}/launch/{id}/key"), "PUT", Some(&json!({"key_sha256": key_sha256})), 3.0, paths)
}

/// Applications a person has asked to reload, most recent last. Asked as of a revision far ahead, so that the answer
/// carries none of the applications themselves.
pub fn reloads(port: u16, paths: &Paths) -> Vec<Value> {
    api::get(port, &format!("{BASE}/state?since=18446744073709551615&notifications_since=18446744073709551615"), 3.0, paths)
        .data()
        .and_then(|d| d.get("reloads"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default()
}
