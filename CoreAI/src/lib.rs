// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! CoreAI: one way for every part of DSTNS to reach a language model, on this machine or in the cloud.
//!
//! The launcher's prompt, the engine's Realistic News and the observer all ask through here, so they share one list of
//! providers, one place for keys and one set of errors. A caller describes what it wants (`Request`) and the settings
//! it was given (`Settings`); CoreAI picks the provider, sends it, and says who answered (`Provenance`).
//!
//! - `providers`: every provider, as data.
//! - `apple`: which of Apple's models this Mac has, from the framework itself, and asking them through `fm`.
//! - `keys`: API keys from the environment (and config/launcher.env, which the launcher loads into it) or from the
//!   system's credential store.
//! - `http`: Chat Completions and Anthropic Messages, whole or streamed.
//! - `serve`: the same, offered on 127.0.0.1 behind a token, for the engine and the observer.

pub mod apple;
pub mod assist;
pub mod http;
pub mod keys;
pub mod providers;
pub mod serve;

use providers::{Protocol, Provider, PROVIDERS};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

impl Message {
    pub fn system(text: impl Into<String>) -> Self {
        Self { role: Role::System, content: text.into() }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: Role::User, content: text.into() }
    }
    pub fn assistant(text: impl Into<String>) -> Self {
        Self { role: Role::Assistant, content: text.into() }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Request {
    pub messages: Vec<Message>,
    /// None leaves it to the model. Ignored where a model fixes it.
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

impl Request {
    /// Instructions and one request: the common case.
    pub fn new(instructions: &str, prompt: &str) -> Self {
        Self { messages: vec![Message::system(instructions), Message::user(prompt)], ..Default::default() }
    }
}

/// Who wrote a reply, so that whatever shows it can say so.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    /// The provider's id, as in `model.provider`.
    pub provider: String,
    pub provider_label: String,
    pub model: String,
    /// Nothing left this machine.
    pub on_device: bool,
    pub notice: String,
}

pub const NOTICE: &str = "Written by an AI model. It can be wrong: check anything that matters.";

#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    pub text: String,
    pub provenance: Provenance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Off, or set to something that does not exist.
    NotConfigured,
    MissingKey,
    /// Nothing answered at the address.
    Unreachable,
    Timeout,
    /// The key was refused.
    Unauthorized,
    RateLimited,
    /// The request was refused as it stands: an unknown model, too long, not allowed.
    Rejected,
    /// The provider failed on its side.
    Upstream,
    /// An answer came back but not one that could be read.
    BadReply,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AiError {
    pub kind: ErrorKind,
    /// The provider's id, or empty before one was chosen.
    pub provider: String,
    pub message: String,
}

impl AiError {
    pub fn new(kind: ErrorKind, provider: &str, message: impl Into<String>) -> Self {
        Self { kind, provider: provider.into(), message: message.into() }
    }
    /// Worth trying the next provider: this one is missing or unwell, not the request.
    pub fn try_next(&self) -> bool {
        !matches!(self.kind, ErrorKind::Rejected)
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match providers::find(&self.provider) {
            Some(p) => write!(f, "{}: {}", p.label, self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for AiError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyStore {
    /// Environment variables, which include config/launcher.env.
    Env,
    /// The system's credential store (Keychain, Secret Service, Windows Credential Manager), then the environment.
    System,
}

/// What a caller was configured with. The launcher fills it from its settings.
#[derive(Clone, Debug)]
pub struct Settings {
    /// `auto`, `off`, or a provider's id.
    pub provider: String,
    /// Empty: the provider's default.
    pub model: String,
    /// Empty: the provider's own address. For `ollama`, its address without /v1 is also accepted.
    pub base_url: String,
    /// Where Ollama answers, for Automatic and for `ollama` when base_url is empty.
    pub ollama_url: String,
    /// Apple's larger model through Private Cloud Compute, when the one on the Mac cannot answer.
    pub apple_cloud: bool,
    pub key_store: KeyStore,
    /// Only models on this machine, whatever `provider` says: nothing leaves it and nothing is paid for.
    pub local_only: bool,
    pub timeout: Duration,
    /// Where helpers are built and cached (the launcher's build/).
    pub cache_dir: PathBuf,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider: "auto".into(),
            model: String::new(),
            base_url: String::new(),
            ollama_url: "http://127.0.0.1:11434".into(),
            apple_cloud: true,
            key_store: KeyStore::Env,
            local_only: false,
            timeout: Duration::from_secs(60),
            cache_dir: std::env::temp_dir(),
        }
    }
}

/// One provider, ready to ask: where, which model, with which key.
#[derive(Clone, Debug)]
pub struct Target {
    pub provider: &'static Provider,
    pub model: String,
    pub base_url: String,
    pub key: Option<String>,
}

impl Target {
    pub fn label(&self) -> String {
        match (self.provider.protocol, self.model.as_str()) {
            (Protocol::Apple, "pcc") => "Apple Foundation Models, through Private Cloud Compute".into(),
            (Protocol::Apple, _) => "Apple Foundation Models, on this Mac".into(),
            (_, "") => self.provider.label.into(),
            (_, model) if self.provider.local => format!("{model} through {} ({})", self.provider.label, self.base_url),
            (_, model) => format!("{model} through {}", self.provider.label),
        }
    }

    pub fn provenance(&self, model: &str) -> Provenance {
        let model = if model.is_empty() { &self.model } else { model };
        // Private Cloud Compute leaves the Mac; the model on it does not.
        let on_device = self.provider.local && !(self.provider.protocol == Protocol::Apple && model == "pcc");
        Provenance { provider: self.provider.id.into(), provider_label: self.provider.label.into(), model: model.into(), on_device, notice: NOTICE.into() }
    }
}

/// Whether a provider can be asked now, and if not, why. For status screens.
#[derive(Clone, Debug)]
pub struct Status {
    pub provider: &'static Provider,
    pub ready: Result<Target, AiError>,
}

fn base_url(provider: &Provider, settings: &Settings, chosen: bool) -> String {
    let configured = settings.base_url.trim().trim_end_matches('/');
    if chosen && !configured.is_empty() {
        return if provider.id == "ollama" && !configured.ends_with("/v1") { format!("{configured}/v1") } else { configured.into() };
    }
    if provider.id == "ollama" {
        return format!("{}/v1", settings.ollama_url.trim().trim_end_matches('/'));
    }
    provider.base_url.into()
}

/// Whether one provider can be asked now. `chosen` applies model.name and model.base_url, which belong to the
/// provider picked in the settings, not to the ones Automatic falls back on.
pub fn target(provider: &'static Provider, settings: &Settings, chosen: bool) -> Result<Target, AiError> {
    let model = if chosen && !settings.model.trim().is_empty() { settings.model.trim().to_string() } else { provider.default_model.to_string() };
    let url = base_url(provider, settings, chosen);
    match provider.protocol {
        Protocol::Apple => {
            let name = apple::choose(&settings.cache_dir, settings.apple_cloud).map_err(|why| AiError::new(ErrorKind::NotConfigured, provider.id, why))?;
            let model = if chosen && matches!(settings.model.trim(), "system" | "pcc") { settings.model.trim().to_string() } else { name };
            Ok(Target { provider, model, base_url: String::new(), key: None })
        }
        _ if url.is_empty() => Err(AiError::new(ErrorKind::NotConfigured, provider.id, "no address: set model.base_url")),
        _ => {
            let key = keys::find(provider, settings);
            if provider.key_required && key.is_none() {
                return Err(AiError::new(ErrorKind::MissingKey, provider.id, format!("no key: model key {} KEY keeps one", provider.id)));
            }
            if provider.local && !http::answers(&url, key.as_deref()) {
                return Err(AiError::new(ErrorKind::Unreachable, provider.id, format!("nothing answers at {url}")));
            }
            Ok(Target { provider, model, base_url: url, key })
        }
    }
}

/// The providers to try, in order, by the settings: the one chosen, or for Automatic every one that can be asked.
pub fn resolve(settings: &Settings) -> Result<Vec<Target>, AiError> {
    if settings.local_only {
        let chosen = providers::find(settings.provider.trim()).filter(|p| p.local);
        let found: Vec<Target> = PROVIDERS.iter().filter(|p| p.local).filter_map(|p| target(p, settings, chosen.map(|c| c.id == p.id).unwrap_or(false)).ok()).collect();
        return if found.is_empty() { Err(AiError::new(ErrorKind::NotConfigured, "", "No model on this machine: Apple's is not here and no Ollama or LM Studio answers.")) } else { Ok(found) };
    }
    match settings.provider.trim() {
        "off" => Err(AiError::new(ErrorKind::NotConfigured, "", "The model is off: set model.provider.")),
        "" | "auto" => {
            let found: Vec<Target> = PROVIDERS.iter().filter(|p| p.id != "custom" || !settings.base_url.trim().is_empty()).filter_map(|p| target(p, settings, p.id == "custom").ok()).collect();
            if found.is_empty() {
                Err(AiError::new(ErrorKind::NotConfigured, "", "No model: none on this machine answers and no cloud provider has a key (model key PROVIDER KEY)."))
            } else {
                Ok(found)
            }
        }
        id => {
            let provider = providers::find(id).ok_or_else(|| AiError::new(ErrorKind::NotConfigured, "", format!("\"{id}\" is not a provider: {}", providers::choices().join(", "))))?;
            target(provider, settings, true).map(|t| vec![t])
        }
    }
}

/// Every provider and whether it could be asked now.
pub fn status(settings: &Settings) -> Vec<Status> {
    PROVIDERS.iter().map(|p| Status { provider: p, ready: target(p, settings, settings.provider.trim() == p.id) }).collect()
}

/// Ask one provider. `on_text` receives the reply as it is written, where the provider streams.
pub fn ask(target: &Target, request: &Request, timeout: Duration, on_text: Option<&mut dyn FnMut(&str)>) -> Result<Reply, AiError> {
    let (text, model) = match target.provider.protocol {
        Protocol::Apple => (apple::respond(&target.model, request, on_text)?, String::new()),
        Protocol::ChatCompletions => http::chat_completions(target, request, timeout, on_text)?,
        Protocol::Anthropic => http::anthropic(target, request, timeout, on_text)?,
    };
    Ok(Reply { text: text.trim().to_string(), provenance: target.provenance(&model) })
}

/// Ask by the settings: the chosen provider, or under Automatic each in turn until one answers. Text already streamed
/// from a provider that then failed is not taken back; the caller is told by `on_text` receiving it again from the next.
pub fn complete(settings: &Settings, request: &Request, mut on_text: Option<&mut dyn FnMut(&str)>) -> Result<Reply, AiError> {
    let mut last = None;
    for target in resolve(settings)? {
        let streamed = on_text.as_mut().map(|f| &mut **f as &mut dyn FnMut(&str));
        match ask(&target, request, settings.timeout, streamed) {
            Ok(reply) => return Ok(reply),
            Err(error) if error.try_next() => last = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(last.unwrap_or_else(|| AiError::new(ErrorKind::NotConfigured, "", "No model answered.")))
}

/// Model names the provider offers, where it lists them.
pub fn models(target: &Target, timeout: Duration) -> Result<Vec<String>, AiError> {
    match target.provider.protocol {
        Protocol::Apple => Ok(vec!["system".into(), "pcc".into()]),
        _ => http::models(target, timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(provider: &str) -> Settings {
        Settings { provider: provider.into(), ollama_url: "http://127.0.0.1:9".into(), key_store: KeyStore::Env, ..Default::default() }
    }

    #[test]
    fn a_chosen_provider_takes_the_model_and_address_set_for_it() {
        std::env::set_var("DSTNS_MISTRAL_API_KEY", "test-key-mistral");
        let mut s = settings("mistral");
        s.model = "mistral-large-latest".into();
        s.base_url = "https://eu.example.test/v1/".into();
        let t = &resolve(&s).unwrap()[0];
        assert_eq!((t.model.as_str(), t.base_url.as_str(), t.key.as_deref()), ("mistral-large-latest", "https://eu.example.test/v1", Some("test-key-mistral")));
        assert!(!t.provenance("").on_device);
        std::env::remove_var("DSTNS_MISTRAL_API_KEY");
    }

    #[test]
    fn a_cloud_provider_without_a_key_says_how_to_keep_one() {
        for name in ["DSTNS_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"] {
            std::env::remove_var(name);
        }
        let error = resolve(&settings("openrouter")).unwrap_err();
        assert_eq!(error.kind, ErrorKind::MissingKey);
        assert!(error.to_string().contains("model key openrouter KEY"), "{error}");
    }

    #[test]
    fn unknown_and_off_are_refused_plainly() {
        assert_eq!(resolve(&settings("off")).unwrap_err().kind, ErrorKind::NotConfigured);
        let error = resolve(&settings("skynet")).unwrap_err();
        assert!(error.message.contains("anthropic") && error.message.contains("huggingface"), "{error}");
        assert!(resolve(&settings("custom")).unwrap_err().message.contains("model.base_url"));
    }

    #[test]
    fn ollama_accepts_its_address_with_or_without_v1() {
        let mut s = settings("ollama");
        assert_eq!(base_url(providers::find("ollama").unwrap(), &s, true), "http://127.0.0.1:9/v1");
        s.base_url = "http://10.0.0.5:11434".into();
        assert_eq!(base_url(providers::find("ollama").unwrap(), &s, true), "http://10.0.0.5:11434/v1");
        // Automatic ignores model.base_url for providers other than the one chosen.
        assert_eq!(base_url(providers::find("openai").unwrap(), &s, false), "https://api.openai.com/v1");
    }

    #[test]
    fn local_only_never_reaches_the_cloud() {
        std::env::set_var("DSTNS_OPENAI_API_KEY", "test-key-openai");
        let mut s = settings("openai");
        assert_eq!(resolve(&s).unwrap()[0].provider.id, "openai");
        s.local_only = true;
        s.cache_dir = std::env::temp_dir().join("dstns-coreai-local-only");
        // Nothing local answers at 127.0.0.1:9 (and Apple may or may not be here): no cloud provider is ever offered.
        match resolve(&s) {
            Ok(found) => assert!(found.iter().all(|t| t.provider.local), "{found:?}"),
            Err(e) => assert!(e.message.contains("No model on this machine"), "{e}"),
        }
        std::env::remove_var("DSTNS_OPENAI_API_KEY");
    }

    #[test]
    fn only_a_refused_request_stops_the_fallback() {
        for kind in [ErrorKind::Unreachable, ErrorKind::Timeout, ErrorKind::RateLimited, ErrorKind::Upstream, ErrorKind::Unauthorized, ErrorKind::MissingKey, ErrorKind::BadReply] {
            assert!(AiError::new(kind, "x", "").try_next(), "{kind:?}");
        }
        assert!(!AiError::new(ErrorKind::Rejected, "x", "").try_next());
    }

    #[test]
    fn private_cloud_compute_is_not_on_device() {
        let apple = providers::find("apple").unwrap();
        let t = |m: &str| Target { provider: apple, model: m.into(), base_url: String::new(), key: None };
        assert!(t("system").provenance("").on_device);
        assert!(!t("pcc").provenance("").on_device);
        assert_eq!(t("pcc").provenance("").notice, NOTICE);
    }
}
