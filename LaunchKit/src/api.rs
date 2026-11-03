// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! A small client for the DSTNS HTTP API. Network failures come back as code 0 with the reason, never as a panic.

use crate::paths::Paths;
use serde_json::{json, Value};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Response {
    pub code: u16,
    pub body: Value,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.code)
    }
    pub fn data(&self) -> Option<&Value> {
        if self.ok() {
            self.body.get("data")
        } else {
            None
        }
    }
    pub fn error_message(&self) -> String {
        match self.body.get("error") {
            Some(Value::Object(error)) => error
                .get("message")
                .or_else(|| error.get("code"))
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| format!("HTTP {}", self.code)),
            Some(Value::String(text)) => text.clone(),
            _ => self.body.get("message").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| format!("HTTP {}", self.code)),
        }
    }
    pub fn error_code(&self) -> String {
        self.body.get("error").and_then(|e| e.get("code")).and_then(|v| v.as_str()).unwrap_or("").to_string()
    }
}

/// The credential that lets the launcher start runs.
pub fn operator_token(paths: &Paths) -> String {
    if let Ok(token) = std::env::var("DSTNS_OPERATOR_TOKEN") {
        if !token.is_empty() {
            return token;
        }
    }
    std::fs::read_to_string(paths.token()).map(|t| t.trim().to_string()).unwrap_or_default()
}

pub fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(timeout)).build().new_agent()
}

/// Call the API on this machine, as the operator.
pub fn call(port: u16, route: &str, method: &str, payload: Option<&Value>, timeout: f64, paths: &Paths) -> Response {
    let url = format!("http://127.0.0.1:{port}{route}");
    let agent = agent(Duration::from_secs_f64(timeout));
    let token = operator_token(paths);
    let result = match (method, payload) {
        ("GET", _) => {
            let mut request = agent.get(&url).header("Content-Type", "application/json");
            if !token.is_empty() {
                request = request.header("X-DSTNS-Operator", &token);
            }
            request.call()
        }
        ("DELETE", _) => {
            let mut request = agent.delete(&url).header("Content-Type", "application/json");
            if !token.is_empty() {
                request = request.header("X-DSTNS-Operator", &token);
            }
            request.call()
        }
        (method, payload) => {
            let body = payload.cloned().unwrap_or_else(|| json!({})).to_string();
            let mut request = match method {
                "PUT" => agent.put(&url),
                _ => agent.post(&url),
            }
            .header("Content-Type", "application/json");
            if !token.is_empty() {
                request = request.header("X-DSTNS-Operator", &token);
            }
            request.send(body.as_bytes())
        }
    };
    match result {
        Ok(mut response) => {
            let code = response.status().as_u16();
            let text = response.body_mut().with_config().limit(256 * 1024 * 1024).read_to_string().unwrap_or_default();
            Response { code, body: decode(&text) }
        }
        Err(error) => Response { code: 0, body: json!({"error": {"code": "UNREACHABLE", "message": error.to_string()}}) },
    }
}

pub fn get(port: u16, route: &str, timeout: f64, paths: &Paths) -> Response {
    call(port, route, "GET", None, timeout, paths)
}

pub fn post(port: u16, route: &str, payload: &Value, timeout: f64, paths: &Paths) -> Response {
    call(port, route, "POST", Some(payload), timeout, paths)
}

fn decode(text: &str) -> Value {
    if text.is_empty() {
        return json!({});
    }
    serde_json::from_str(text).unwrap_or_else(|_| json!({"message": text}))
}

/// The server's /health if a DSTNS server answers on `port`.
pub fn health(port: u16, paths: &Paths) -> Option<Value> {
    let response = call(port, "/health", "GET", None, 1.0, paths);
    if response.code != 200 || !response.body.is_object() {
        return None;
    }
    let body = response.body;
    let ours = body.get("product").and_then(|v| v.as_str()) == Some("DSTNS") || body.get("service").and_then(|v| v.as_str()) == Some("dstns");
    ours.then_some(body)
}

/// A server this launcher can drive (an older DSTNS is left alone).
pub fn is_current(health: Option<&Value>) -> bool {
    health.and_then(|h| h.get("observer_ui_version")).and_then(|v| v.as_str()) == Some("observer-v2")
}

pub fn port_open(port: u16, host: &str) -> bool {
    let address: Option<SocketAddr> = (host, port).to_socket_addrs().ok().and_then(|mut a| a.next());
    address.map(|a| TcpStream::connect_timeout(&a, Duration::from_millis(350)).is_ok()).unwrap_or(false)
}

pub fn free_port(start: u16, host: &str) -> Option<u16> {
    (start..65535).find(|port| !port_open(*port, host))
}
