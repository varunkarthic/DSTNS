// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! CoreAI offered to the rest of DSTNS: a small HTTP service on 127.0.0.1, behind a token made for each start, that
//! speaks Chat Completions. The engine's news writer already speaks it, so it reaches every provider through here.
//!
//! - `GET /v1/models` lists one model, `dstns`: whichever the settings choose.
//! - `POST /v1/chat/completions` takes the usual body; `model` is ignored, since the settings choose. The reply is the
//!   usual one, with `provenance` added (who wrote it, whether it left the machine, and a notice), and the header
//!   `X-DSTNS-Generated-By: provider/model`.
//! - Further routes can be added by the caller (`Routes`), such as the assistant's.
//!
//! Under `/local` (`/local/v1/...`) the same routes use only models on this machine, whatever the settings choose:
//! for work that runs unattended, such as the news, which should neither leave the machine nor cost anything.
//!
//! Every request needs `Authorization: Bearer TOKEN`. Bodies over 2 MB are refused.

use crate::{AiError, ErrorKind, Message, Request, Role, Settings};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

const MAX_BODY: usize = 2 * 1024 * 1024;

pub type SettingsSource = Arc<dyn Fn() -> Settings + Send + Sync>;
/// Extra routes: (method, path, body) to Some((status, body)) when the route is theirs.
pub type Routes = Arc<dyn Fn(&str, &str, &Value) -> Option<(u16, Value)> + Send + Sync>;

#[derive(Clone, Debug)]
pub struct Service {
    pub port: u16,
    pub token: String,
}

impl Service {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system's random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Start the service on a free port of 127.0.0.1. It runs until the process ends.
pub fn start(settings: SettingsSource, routes: Option<Routes>) -> std::io::Result<Service> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let service = Service { port: listener.local_addr()?.port(), token: new_token() };
    let token = service.token.clone();
    std::thread::Builder::new().name("coreai-serve".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let (settings, routes, token) = (settings.clone(), routes.clone(), token.clone());
            let _ = std::thread::Builder::new().name("coreai-request".into()).spawn(move || handle(stream, &settings, routes.as_ref(), &token));
        }
    })?;
    Ok(service)
}

struct Incoming {
    method: String,
    path: String,
    authorization: String,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Result<Incoming, (u16, &'static str)> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|_| (500, "socket"))?);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|_| (400, "no request line"))?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let (mut length, mut authorization, mut header_bytes) = (0usize, String::new(), 0usize);
    loop {
        let mut header = String::new();
        let n = reader.read_line(&mut header).map_err(|_| (400, "bad headers"))?;
        header_bytes += n;
        if n == 0 || header == "\r\n" || header == "\n" {
            break;
        }
        if header_bytes > 32 * 1024 {
            return Err((431, "headers too large"));
        }
        if let Some((name, value)) = header.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse().map_err(|_| (400, "bad length"))?,
                "authorization" => authorization = value.trim().to_string(),
                _ => {}
            }
        }
    }
    if length > MAX_BODY {
        return Err((413, "body too large"));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|_| (400, "short body"))?;
    Ok(Incoming { method, path, authorization, body })
}

fn respond(mut stream: &TcpStream, status: u16, body: &Value, extra: &[(&str, String)]) {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let mut head = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n", text.len());
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(text.as_bytes()));
}

pub fn error_status(error: &AiError) -> u16 {
    match error.kind {
        ErrorKind::NotConfigured | ErrorKind::MissingKey => 503,
        ErrorKind::RateLimited => 429,
        ErrorKind::Timeout => 504,
        ErrorKind::Rejected => 400,
        _ => 502,
    }
}

pub fn error_body(error: &AiError) -> Value {
    json!({"error": {"message": error.to_string(), "type": error.kind, "provider": error.provider}})
}

/// A Chat Completions body as a Request. Content may be text or a list of parts, of which the text ones are kept.
pub fn request_from(body: &Value) -> Result<Request, String> {
    let messages = body["messages"].as_array().ok_or("messages is missing")?;
    let mut out = Vec::new();
    for m in messages {
        let role = match m["role"].as_str() {
            Some("system" | "developer") => Role::System,
            Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            other => return Err(format!("role {other:?} is not one of system, user, assistant")),
        };
        let content = match &m["content"] {
            Value::String(s) => s.clone(),
            Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
            _ => return Err("content must be text".into()),
        };
        out.push(Message { role, content });
    }
    if !out.iter().any(|m| m.role == Role::User) {
        return Err("there is no user message".into());
    }
    Ok(Request {
        messages: out,
        temperature: body["temperature"].as_f64().map(|t| t as f32),
        max_tokens: body["max_completion_tokens"].as_u64().or_else(|| body["max_tokens"].as_u64()).map(|n| n.min(16_384) as u32),
    })
}

fn handle(stream: TcpStream, settings: &SettingsSource, routes: Option<&Routes>, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let incoming = match read_request(&stream) {
        Ok(incoming) => incoming,
        Err((status, why)) => return respond(&stream, status, &json!({"error": {"message": why}}), &[]),
    };
    let offered = incoming.authorization.strip_prefix("Bearer ").unwrap_or("");
    if !same(offered, token) {
        return respond(&stream, 401, &json!({"error": {"message": "a valid token is needed"}}), &[("WWW-Authenticate", "Bearer".into())]);
    }
    let body: Value = if incoming.body.is_empty() { Value::Null } else { serde_json::from_slice(&incoming.body).unwrap_or(Value::Null) };
    let path = incoming.path.split('?').next().unwrap_or("");
    let (path, local_only) = match path.strip_prefix("/local") {
        Some(rest) if rest.starts_with('/') => (rest, true),
        _ => (path, false),
    };
    let settings = || {
        let mut chosen = settings();
        chosen.local_only |= local_only;
        chosen
    };
    if let Some((status, reply)) = routes.and_then(|r| r(&incoming.method, path, &body)) {
        return respond(&stream, status, &reply, &[]);
    }
    match (incoming.method.as_str(), path) {
        ("GET", "/v1/models") => respond(&stream, 200, &json!({"object": "list", "data": [{"id": "dstns", "object": "model", "owned_by": "dstns"}]}), &[]),
        ("POST", "/v1/chat/completions") => {
            let request = match request_from(&body) {
                Ok(request) => request,
                Err(why) => return respond(&stream, 400, &json!({"error": {"message": why}}), &[]),
            };
            match crate::complete(&settings(), &request, None) {
                Ok(reply) => {
                    let generated_by = format!("{}/{}", reply.provenance.provider, reply.provenance.model);
                    let answer = json!({
                        "id": format!("dstns-{}", &new_token()[..16]),
                        "object": "chat.completion",
                        "model": reply.provenance.model,
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": reply.text}, "finish_reason": "stop"}],
                        "provenance": reply.provenance,
                    });
                    respond(&stream, 200, &answer, &[("X-DSTNS-Generated-By", generated_by)]);
                }
                Err(error) => respond(&stream, error_status(&error), &error_body(&error), &[]),
            }
        }
        _ => respond(&stream, 404, &json!({"error": {"message": format!("no route {} {path}", incoming.method)}}), &[]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(service: &Service, method: &str, path: &str, token: &str, body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", service.port)).unwrap();
        // The server may answer and close before a body it refuses is all sent.
        let _ = write!(stream, "{method} {path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        let mut text = String::new();
        let _ = stream.read_to_string(&mut text);
        let status = text.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, text.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
    }

    fn off() -> SettingsSource {
        Arc::new(|| Settings { provider: "off".into(), ..Default::default() })
    }

    #[test]
    fn nothing_is_served_without_the_token() {
        let service = start(off(), None).unwrap();
        assert_eq!(call(&service, "GET", "/v1/models", "", "").0, 401);
        assert_eq!(call(&service, "GET", "/v1/models", &"0".repeat(64), "").0, 401);
        assert_eq!(call(&service, "GET", "/v1/models", &service.token[..63], "").0, 401);
        assert_eq!(call(&service, "GET", "/v1/models", &service.token, "").0, 200);
    }

    #[test]
    fn requests_are_checked_and_errors_are_typed() {
        let service = start(off(), None).unwrap();
        let t = &service.token;
        assert_eq!(call(&service, "POST", "/v1/chat/completions", t, "{}").0, 400);
        assert_eq!(call(&service, "POST", "/v1/chat/completions", t, r#"{"messages":[{"role":"tool","content":"x"}]}"#).0, 400);
        let (status, body) = call(&service, "POST", "/v1/chat/completions", t, r#"{"messages":[{"role":"user","content":"hi"}]}"#);
        assert_eq!(status, 503, "{body}");
        assert!(body.contains("\"type\":\"not_configured\""), "{body}");
        assert_eq!(call(&service, "GET", "/nowhere", t, "").0, 404);
        let huge = format!("{{\"x\":\"{}\"}}", "y".repeat(MAX_BODY));
        assert_eq!(call(&service, "POST", "/v1/chat/completions", t, &huge).0, 413);
    }

    #[test]
    fn a_route_of_the_caller_is_served_behind_the_same_token() {
        let routes: Routes = Arc::new(|method, path, body| (method == "POST" && path == "/v1/echo").then(|| (200, body.clone())));
        let service = start(off(), Some(routes)).unwrap();
        assert_eq!(call(&service, "POST", "/v1/echo", "nope", "{}").0, 401);
        assert_eq!(call(&service, "POST", "/v1/echo", &service.token, r#"{"a":1}"#), (200, r#"{"a":1}"#.to_string()));
    }

    #[test]
    fn under_local_nothing_reaches_the_cloud() {
        std::env::set_var("DSTNS_GROQ_API_KEY", "test-key-groq-serve");
        let groq: SettingsSource = Arc::new(|| Settings { provider: "groq".into(), ollama_url: "http://127.0.0.1:9".into(), cache_dir: std::env::temp_dir().join("dstns-serve-local"), ..Default::default() });
        let service = start(groq, None).unwrap();
        let ask = r#"{"messages":[{"role":"user","content":"hi"}]}"#;
        assert_eq!(call(&service, "GET", "/local/v1/models", &service.token, "").0, 200);
        // Groq would be asked at /v1; under /local only this machine's models may answer, or it is refused.
        let (status, body) = call(&service, "POST", "/local/v1/chat/completions", &service.token, ask);
        assert!(!body.contains("groq") && !body.contains("Groq"), "{status} {body}");
        std::env::remove_var("DSTNS_GROQ_API_KEY");
    }

    #[test]
    fn message_parts_and_limits_are_read() {
        let r = request_from(&json!({"messages": [{"role": "developer", "content": "Be brief."}, {"role": "user", "content": [{"type": "text", "text": "a"}, {"type": "image_url"}, {"type": "text", "text": "b"}]}], "max_tokens": 1_000_000, "temperature": 0.2})).unwrap();
        assert_eq!(r.messages[0].role, Role::System);
        assert_eq!(r.messages[1].content, "a\nb");
        assert_eq!(r.max_tokens, Some(16_384));
        assert!(request_from(&json!({"messages": [{"role": "system", "content": "only this"}]})).is_err());
    }
}
