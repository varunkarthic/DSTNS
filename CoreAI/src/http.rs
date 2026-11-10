// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The two wire formats cloud and local servers speak: OpenAI's Chat Completions (OpenAI, Gemini, Groq, Mistral,
//! OpenRouter, Hugging Face, Ollama, LM Studio and most others) and Anthropic's Messages. Both whole or streamed.

use crate::{AiError, ErrorKind, Request, Role, Target};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::time::Duration;

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(timeout)).timeout_connect(Some(Duration::from_secs(10).min(timeout))).build().new_agent()
}

fn transport(provider: &str, error: ureq::Error) -> AiError {
    match error {
        ureq::Error::Timeout(_) => AiError::new(ErrorKind::Timeout, provider, "it did not answer in time (model.timeout_seconds)"),
        ureq::Error::ConnectionFailed | ureq::Error::HostNotFound | ureq::Error::Io(_) => AiError::new(ErrorKind::Unreachable, provider, format!("it could not be reached ({error})")),
        other => AiError::new(ErrorKind::BadReply, provider, other.to_string()),
    }
}

/// The provider's own words for what went wrong, short.
fn reason(body: &str) -> String {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let text = [&parsed["error"]["message"], &parsed["error"], &parsed["message"], &parsed["detail"]].into_iter().find_map(|v| v.as_str().map(String::from)).unwrap_or_else(|| body.trim().to_string());
    let text: String = text.chars().take(300).collect();
    if text.is_empty() {
        "no reason given".into()
    } else {
        text
    }
}

pub fn status_error(provider: &str, status: u16, body: &str) -> AiError {
    let kind = match status {
        401 | 403 => ErrorKind::Unauthorized,
        429 => ErrorKind::RateLimited,
        400 | 404 | 409 | 413 | 422 => ErrorKind::Rejected,
        408 | 500..=599 => ErrorKind::Upstream,
        _ => ErrorKind::BadReply,
    };
    AiError::new(kind, provider, format!("HTTP {status}: {}", reason(body)))
}

/// Lines of a server-sent event stream, each `data:` payload in turn, until `[DONE]` or the end.
fn events(reader: impl std::io::Read, provider: &str, mut each: impl FnMut(&Value) -> Result<(), AiError>) -> Result<(), AiError> {
    for line in BufReader::new(reader).lines() {
        let line = line.map_err(|e| AiError::new(ErrorKind::BadReply, provider, format!("the stream broke off: {e}")))?;
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        if data == "[DONE]" {
            break;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            each(&value)?;
        }
    }
    Ok(())
}

fn authorized(request: ureq::RequestBuilder<ureq::typestate::WithBody>, target: &Target) -> ureq::RequestBuilder<ureq::typestate::WithBody> {
    match &target.key {
        Some(key) => request.header("Authorization", &format!("Bearer {key}")),
        None => request,
    }
}

/// Chat Completions. Returns the text and the model that wrote it, as the server names it.
pub fn chat_completions(target: &Target, request: &Request, timeout: Duration, on_text: Option<&mut dyn FnMut(&str)>) -> Result<(String, String), AiError> {
    let provider = target.provider.id;
    let mut model = target.model.clone();
    if model.is_empty() {
        // A local server with no model named: the first it has loaded.
        model = models(target, Duration::from_secs(5))?.into_iter().next().ok_or_else(|| AiError::new(ErrorKind::NotConfigured, provider, "it has no model loaded: load one, or set model.name"))?;
    }
    let messages: Vec<Value> = request.messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();
    let mut body = json!({"model": model, "messages": messages, "stream": on_text.is_some()});
    // OpenAI's current models take neither a temperature nor max_tokens.
    if provider == "openai" {
        if let Some(n) = request.max_tokens {
            body["max_completion_tokens"] = json!(n);
        }
    } else {
        if let Some(t) = request.temperature {
            body["temperature"] = json!(t);
        }
        if let Some(n) = request.max_tokens {
            body["max_tokens"] = json!(n);
        }
    }
    let url = format!("{}/chat/completions", target.base_url);
    let mut response = authorized(agent(timeout).post(&url), target).header("Content-Type", "application/json").send_json(&body).map_err(|e| transport(provider, e))?;
    let status = response.status().as_u16();
    if status != 200 {
        let text = response.body_mut().read_to_string().unwrap_or_default();
        return Err(status_error(provider, status, &text));
    }
    let Some(on_text) = on_text else {
        let reply: Value = response.body_mut().read_json().map_err(|e| AiError::new(ErrorKind::BadReply, provider, e.to_string()))?;
        let text = reply["choices"][0]["message"]["content"].as_str().ok_or_else(|| AiError::new(ErrorKind::BadReply, provider, format!("no text in the reply: {}", reason(&reply.to_string()))))?;
        return Ok((text.to_string(), reply["model"].as_str().unwrap_or(&model).to_string()));
    };
    let mut text = String::new();
    let mut named = model.clone();
    events(response.into_body().into_reader(), provider, |chunk| {
        if chunk.get("error").is_some() {
            return Err(AiError::new(ErrorKind::Upstream, provider, reason(&chunk.to_string())));
        }
        if let Some(m) = chunk["model"].as_str().filter(|m| !m.is_empty()) {
            named = m.to_string();
        }
        if let Some(piece) = chunk["choices"][0]["delta"]["content"].as_str().filter(|p| !p.is_empty()) {
            on_text(piece);
            text.push_str(piece);
        }
        Ok(())
    })?;
    Ok((text, named))
}

/// Anthropic's Messages API.
pub fn anthropic(target: &Target, request: &Request, timeout: Duration, on_text: Option<&mut dyn FnMut(&str)>) -> Result<(String, String), AiError> {
    let provider = target.provider.id;
    let system: Vec<&str> = request.messages.iter().filter(|m| m.role == Role::System).map(|m| m.content.as_str()).collect();
    let messages: Vec<Value> = request.messages.iter().filter(|m| m.role != Role::System).map(|m| json!({"role": m.role, "content": m.content})).collect();
    let mut body = json!({"model": target.model, "max_tokens": request.max_tokens.unwrap_or(1024), "messages": messages, "stream": on_text.is_some()});
    if !system.is_empty() {
        body["system"] = json!(system.join("\n\n"));
    }
    if let Some(t) = request.temperature {
        body["temperature"] = json!(t.clamp(0.0, 1.0));
    }
    let key = target.key.as_deref().unwrap_or("");
    let mut response = agent(timeout)
        .post(&format!("{}/messages", target.base_url))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .send_json(&body)
        .map_err(|e| transport(provider, e))?;
    let status = response.status().as_u16();
    if status != 200 {
        let text = response.body_mut().read_to_string().unwrap_or_default();
        return Err(status_error(provider, status, &text));
    }
    let Some(on_text) = on_text else {
        let reply: Value = response.body_mut().read_json().map_err(|e| AiError::new(ErrorKind::BadReply, provider, e.to_string()))?;
        let text: String = reply["content"].as_array().map(|parts| parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect()).unwrap_or_default();
        if text.is_empty() && reply["stop_reason"] != "end_turn" {
            return Err(AiError::new(ErrorKind::BadReply, provider, format!("no text in the reply: {}", reason(&reply.to_string()))));
        }
        return Ok((text, reply["model"].as_str().unwrap_or(&target.model).to_string()));
    };
    let mut text = String::new();
    let mut named = target.model.clone();
    events(response.into_body().into_reader(), provider, |event| {
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                if let Some(m) = event["message"]["model"].as_str() {
                    named = m.to_string();
                }
            }
            "content_block_delta" => {
                if let Some(piece) = event["delta"]["text"].as_str() {
                    on_text(piece);
                    text.push_str(piece);
                }
            }
            "error" => return Err(AiError::new(if event["error"]["type"] == "overloaded_error" { ErrorKind::Upstream } else { ErrorKind::BadReply }, provider, reason(&event.to_string()))),
            _ => {}
        }
        Ok(())
    })?;
    Ok((text, named))
}

/// The models a provider lists (Chat Completions and Anthropic both answer GET /models with {"data": [{"id"}]}).
pub fn models(target: &Target, timeout: Duration) -> Result<Vec<String>, AiError> {
    let provider = target.provider.id;
    let mut request = agent(timeout).get(&format!("{}/models", target.base_url));
    if let Some(key) = &target.key {
        request = if target.provider.protocol == crate::providers::Protocol::Anthropic {
            request.header("x-api-key", key).header("anthropic-version", "2023-06-01")
        } else {
            request.header("Authorization", &format!("Bearer {key}"))
        };
    }
    let mut response = request.call().map_err(|e| transport(provider, e))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    if status != 200 {
        return Err(status_error(provider, status, &text));
    }
    let listed: Value = serde_json::from_str(&text).map_err(|e| AiError::new(ErrorKind::BadReply, provider, e.to_string()))?;
    let ids = listed["data"].as_array().or_else(|| listed["models"].as_array()).cloned().unwrap_or_default();
    Ok(ids.iter().filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()).map(|s| s.trim_start_matches("models/").to_string())).collect())
}

/// Something answers HTTP at `base_url` (any reply short of a server error), within a moment.
pub fn answers(base_url: &str, key: Option<&str>) -> bool {
    let mut request = agent(Duration::from_millis(1500)).get(&format!("{base_url}/models"));
    if let Some(key) = key {
        request = request.header("Authorization", &format!("Bearer {key}"));
    }
    request.call().map(|r| r.status().as_u16() < 500).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_become_errors_that_say_whether_to_try_the_next() {
        assert_eq!(status_error("openai", 401, r#"{"error":{"message":"Incorrect API key"}}"#).kind, ErrorKind::Unauthorized);
        assert_eq!(status_error("groq", 429, "slow down").kind, ErrorKind::RateLimited);
        let e = status_error("openai", 404, r#"{"error":{"message":"The model `gpt-0` does not exist"}}"#);
        assert_eq!(e.kind, ErrorKind::Rejected);
        assert!(e.message.contains("gpt-0") && !e.try_next());
        assert_eq!(status_error("anthropic", 529, r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#).kind, ErrorKind::Upstream);
        assert_eq!(status_error("x", 502, "").message, "HTTP 502: no reason given");
        // Long bodies are cut.
        assert!(status_error("x", 500, &"y".repeat(5000)).message.len() < 320);
    }

    #[test]
    fn a_stream_is_read_event_by_event_until_done() {
        let stream = "data: {\"n\":1}\n\n: keep-alive\nevent: x\ndata:{\"n\":2}\n\ndata: [DONE]\n\ndata: {\"n\":3}\n";
        let mut seen = vec![];
        events(stream.as_bytes(), "x", |v| {
            seen.push(v["n"].as_i64().unwrap());
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, vec![1, 2]);
    }
}
