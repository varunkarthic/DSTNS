# CoreAI

CoreAI is how DSTNS reaches a language model. The launcher's prompt, the engine's
[Realistic News](../guide/narration.md) and anything else in DSTNS that asks a model all go
through it, so they share one list of providers, one place for keys, one set of errors and
one way of saying who wrote an answer. It is a Rust library at the root of the repository,
`CoreAI/`, which the launcher builds in.

## Providers

| Provider | `model.provider` | Where it runs | Key |
|---|---|---|---|
| Apple Foundation Models | `apple` | This Mac; or Private Cloud Compute when allowed | none |
| Ollama | `ollama` | This machine | none |
| LM Studio | `lmstudio` | This machine | none |
| Anthropic | `anthropic` | Cloud | `DSTNS_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | Cloud | `DSTNS_OPENAI_API_KEY` or `OPENAI_API_KEY` |
| Google Gemini | `gemini` | Cloud | `DSTNS_GEMINI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| Groq | `groq` | Cloud | `DSTNS_GROQ_API_KEY` or `GROQ_API_KEY` |
| Mistral | `mistral` | Cloud | `DSTNS_MISTRAL_API_KEY` or `MISTRAL_API_KEY` |
| OpenRouter | `openrouter` | Cloud | `DSTNS_OPENROUTER_API_KEY` or `OPENROUTER_API_KEY` |
| Hugging Face | `huggingface` | Cloud | `DSTNS_HF_TOKEN`, `HF_TOKEN` or `HUGGINGFACE_API_KEY` |
| Any Chat Completions server | `custom` | Wherever `model.base_url` says | `DSTNS_AI_API_KEY`, if it needs one |

The providers are a table in `CoreAI/src/providers.rs`. Most speak OpenAI's Chat Completions,
so one client serves them all, and a new one that does is one more row. Anthropic is spoken to
in its own Messages API, and Apple's models through the `fm` command.

**Automatic** (`auto`) tries them in the table's order: Apple's model where the Mac has it,
then a model server on this machine, then each cloud provider that has a key. When one cannot
answer (not reachable, too slow, refusing the key, rate limited, failing on its side), the
next is asked. A request the provider refuses as it stands (an unknown model, too long) is not
passed on, since the next would refuse it too. Naming a provider asks that one only.

**Apple's models** are found by asking the Foundation Models framework itself, through a small
Swift helper the launcher builds on first use (`CoreAI/assets/models.swift`): the model on the
Mac (`SystemLanguageModel`, macOS 26 or later) and Apple's larger model through Private Cloud
Compute (`PrivateCloudComputeLanguageModel`, macOS 27 or later), each with the framework's own
reason when it is missing. The one on the Mac is used first; Private Cloud Compute only when
it cannot answer and `model.apple_cloud` is on (the default).

## Keys

Keys come from the environment, which includes `config/launcher.env` (the launcher loads it
as it starts, and writes it readable by your account only). With `model.key_store` set to
`system`, the system's credential store is asked first: the macOS Keychain (through a second
small Swift helper, which takes the key on standard input so it never shows in a process
list), Windows Credential Manager, or the Secret Service keyring on Linux (`secret-tool`).

A key is sent only to its own provider. It is never printed: `./launcher model` says where
each key comes from, not what it is, and the launcher's log writes `[redacted]` in place of
any key it might otherwise have carried.

## Errors

Every failure has a kind: `not_configured`, `missing_key`, `unreachable`, `timeout`,
`unauthorized`, `rate_limited`, `rejected`, `upstream` or `bad_reply`, and the provider's own
words for it, cut short. The launcher shows them as they are; the service below maps them to
HTTP statuses (503, 429, 504, 400 or 502).

## Who wrote it

Every answer carries its provenance: the provider, the model as the provider names it,
whether it stayed on this machine, and the notice *Written by an AI model. It can be wrong:
check anything that matters.* The launcher names the model beside each answer.

## Answers about DSTNS

`CoreAI/src/assist.rs` answers questions about DSTNS itself. It is built in stages; this is
the first.

1. **Retrieval by words.** The launcher cuts the documentation (`docs/`) into its sections,
   each linked to where it is published, and CoreAI ranks them for a question by BM25, with a
   section's title counting three times its text. A follow-up is searched together with the
   question before it. For a question about the code, the launcher adds what the
   [knowledge graph](../development/knowledge-graph.md) knows. Nothing is downloaded or sent
   anywhere to search.
2. **Grounded answer.** The model gets the closest passages, numbered and cut to fit its
   context (about 4,500 characters for Apple's model on the Mac, 14,000 for others), the last
   four questions and answers of the conversation, and the question. It is told to answer from
   them, cite them as `[1]`, say when they do not cover it, and never claim to have run or
   changed anything. Citations are renumbered in the order they appear, and only the cited
   sources are returned.
3. **Retrieval by meaning** (not built yet): when a model for embeddings is configured,
   passages would also be ranked by meaning, which helps when a question uses none of the
   documentation's words. Words alone answered the questions tried so far.

Conversations are kept in memory only: at most 32, each its last eight messages, forgotten
after an hour. With no model, the closest passages are the answer. Answers only inform; the
[MCP Handler](../guide/mcp.md)'s tools that change things are separate, and keep their own
permissions.

## The service

For the parts of DSTNS that are not the launcher, CoreAI is offered as a small HTTP service on
`127.0.0.1`, on a free port, started by the launcher when something needs it and stopped with
it. It answers only requests carrying `Authorization: Bearer TOKEN`, with a token made afresh
for each start and handed to the engine in its environment (which the engine clears once read).

| Route | Does |
|---|---|
| `GET /v1/models` | One model, `dstns`: whichever the settings choose |
| `POST /v1/chat/completions` | A Chat Completions request, answered by the settings' model. The reply is the usual one, with `provenance` added, and the header `X-DSTNS-Generated-By: provider/model` |
| `/local/v1/...` | The same, but only models on this machine are asked, whatever the settings say |
| `POST /v1/assist` | `{"question", "conversation"?}`: an answer about DSTNS, as `{"answer" (Markdown), "sources": [{"title", "link"}], "conversation", "provenance" (null when no model wrote it), "notice", "informational": true}`. Off with `assist.enabled` |
| `POST /v1/assist/forget` | `{"conversation"}`: end a conversation |

The engine's news writer already speaks Chat Completions, so with `narration.mode` set to
`model` it is pointed at `/v1`, and with `auto` (when Apple's model is not there) at `/local`.
Fields the service adds are added only: a client that ignores `provenance` reads an ordinary
Chat Completions reply.

## Tests

`cargo test --manifest-path CoreAI/Cargo.toml` checks the choice of provider and its fallback,
keys, errors, streaming, the service's token and limits, and that `/local` never reaches a cloud
provider. Two more run on a Mac only, with `-- --ignored`: Apple's framework is asked for real,
and a key is kept in and forgotten from the login Keychain.
