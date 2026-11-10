// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Every provider CoreAI can reach, as data. Adding one that speaks Chat Completions is one more row here.

/// How a provider is spoken to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    /// OpenAI's Chat Completions, which most providers and local servers also speak.
    ChatCompletions,
    /// Anthropic's Messages API.
    Anthropic,
    /// Apple's Foundation Models, through the `fm` command.
    Apple,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Provider {
    /// The name used in settings: `model.provider`.
    pub id: &'static str,
    pub label: &'static str,
    pub protocol: Protocol,
    /// Where it answers, ending before `/chat/completions` or `/messages`. Empty: it must be configured.
    pub base_url: &'static str,
    /// The model used when `model.name` is default. Empty: the first the server lists.
    pub default_model: &'static str,
    /// Where its key may be, in order. The first is DSTNS's own name, which `model key` writes.
    pub key_names: &'static [&'static str],
    pub key_required: bool,
    /// It runs on this machine: nothing leaves it.
    pub local: bool,
}

/// In the order Automatic tries them: on this machine first, then cloud providers that have a key.
pub const PROVIDERS: &[Provider] = &[
    Provider { id: "apple", label: "Apple Foundation Models", protocol: Protocol::Apple, base_url: "", default_model: "system", key_names: &[], key_required: false, local: true },
    Provider { id: "ollama", label: "Ollama", protocol: Protocol::ChatCompletions, base_url: "http://127.0.0.1:11434/v1", default_model: "llama3.2", key_names: &[], key_required: false, local: true },
    Provider { id: "lmstudio", label: "LM Studio", protocol: Protocol::ChatCompletions, base_url: "http://127.0.0.1:1234/v1", default_model: "", key_names: &[], key_required: false, local: true },
    Provider {
        id: "anthropic",
        label: "Anthropic",
        protocol: Protocol::Anthropic,
        base_url: "https://api.anthropic.com/v1",
        default_model: "claude-haiku-5-5",
        key_names: &["DSTNS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
        key_required: true,
        local: false,
    },
    Provider {
        id: "openai",
        label: "OpenAI",
        protocol: Protocol::ChatCompletions,
        base_url: "https://api.openai.com/v1",
        default_model: "gpt-5-mini",
        key_names: &["DSTNS_OPENAI_API_KEY", "OPENAI_API_KEY"],
        key_required: true,
        local: false,
    },
    Provider {
        id: "gemini",
        label: "Google Gemini",
        protocol: Protocol::ChatCompletions,
        // Google's own Chat Completions endpoint for the Gemini API.
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        default_model: "gemini-flash-latest",
        key_names: &["DSTNS_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
        key_required: true,
        local: false,
    },
    Provider {
        id: "groq",
        label: "Groq",
        protocol: Protocol::ChatCompletions,
        base_url: "https://api.groq.com/openai/v1",
        default_model: "llama-3.3-70b-versatile",
        key_names: &["DSTNS_GROQ_API_KEY", "GROQ_API_KEY"],
        key_required: true,
        local: false,
    },
    Provider {
        id: "mistral",
        label: "Mistral",
        protocol: Protocol::ChatCompletions,
        base_url: "https://api.mistral.ai/v1",
        default_model: "mistral-small-latest",
        key_names: &["DSTNS_MISTRAL_API_KEY", "MISTRAL_API_KEY"],
        key_required: true,
        local: false,
    },
    Provider {
        id: "openrouter",
        label: "OpenRouter",
        protocol: Protocol::ChatCompletions,
        base_url: "https://openrouter.ai/api/v1",
        default_model: "openrouter/auto",
        key_names: &["DSTNS_OPENROUTER_API_KEY", "OPENROUTER_API_KEY"],
        key_required: true,
        local: false,
    },
    Provider {
        id: "huggingface",
        label: "Hugging Face",
        protocol: Protocol::ChatCompletions,
        base_url: "https://router.huggingface.co/v1",
        default_model: "openai/gpt-oss-20b",
        key_names: &["DSTNS_HF_TOKEN", "HF_TOKEN", "HUGGINGFACE_API_KEY"],
        key_required: true,
        local: false,
    },
    // Anything else that speaks Chat Completions (vLLM, llama.cpp, a company gateway): model.base_url says where.
    Provider { id: "custom", label: "Chat Completions server", protocol: Protocol::ChatCompletions, base_url: "", default_model: "", key_names: &["DSTNS_AI_API_KEY"], key_required: false, local: false },
];

pub fn find(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// The values `model.provider` accepts.
pub fn choices() -> Vec<&'static str> {
    std::iter::once("auto").chain(PROVIDERS.iter().map(|p| p.id)).chain(std::iter::once("off")).collect()
}
