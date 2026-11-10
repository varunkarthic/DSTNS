// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Answers about DSTNS itself: what it does, what it needs, how to use it and what to do when something goes wrong,
//! grounded in its own documentation and source, with the passages each answer rests on.
//!
//! Retrieval is in stages, and this is the first: words. The documentation is cut into its sections, and a question
//! finds the closest by BM25, the ranking search engines have long used, with section titles counting extra. A
//! follow-up is searched together with the question before it, so "and how do I turn it off?" still finds the
//! feature. The caller may add passages of its own for each question, such as the knowledge graph's facts about the
//! code. The second stage, when a model for embeddings is configured, would rank by meaning as well; until then words
//! do, and they need nothing to be downloaded or sent anywhere.
//!
//! The model sees the passages numbered, the conversation so far, and the question, and is told to answer from them,
//! cite them as [1], say plainly when they do not cover it, and never claim to have done anything: it cannot run a
//! command or change a setting, only say which one to use. Without a model, the closest passages are the answer.

use crate::{AiError, ErrorKind, Message, Provenance, Request, Role, Settings};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A piece of what DSTNS knows about itself.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Passage {
    /// What it is, as a person would name it: "Configuration › Ports".
    pub title: String,
    /// Where to read it in full: a documentation URL, or file:line in the source.
    pub link: String,
    pub text: String,
}

// ---------------------------------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------------------------------

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on", "or", "so",
    "that", "the", "their", "then", "there", "this", "to", "was", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your", "dstns",
];

/// Words as the index compares them: lower case, letters and digits, a plural or tense taken off.
pub fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.')) {
        let word = raw.trim_matches('.').to_lowercase();
        if word.len() < 2 || STOPWORDS.contains(&word.as_str()) {
            continue;
        }
        // A dotted setting or snake_case name counts whole and by its parts.
        let parts: Vec<&str> = word.split(['.', '_']).filter(|p| p.len() > 1).collect();
        if parts.len() > 1 {
            out.extend(parts.iter().map(|p| stem(p)));
        }
        out.push(stem(&word));
    }
    out
}

/// A crude stem, the same for a word and its plural and tenses: "routes", "route" and "routed" are all "rout".
fn stem(word: &str) -> String {
    let mut w = word;
    for suffix in ["ing", "ed"] {
        if w.len() > suffix.len() + 3 && w.ends_with(suffix) {
            w = &w[..w.len() - suffix.len()];
            break;
        }
    }
    if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") {
        w = &w[..w.len() - 1];
    }
    if w.len() > 4 && w.ends_with('e') {
        w = &w[..w.len() - 1];
    }
    w.to_string()
}

// ---------------------------------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct Index {
    passages: Vec<Passage>,
    /// Each passage's words and how often each appears.
    counts: Vec<HashMap<String, f64>>,
    lengths: Vec<f64>,
    /// How many passages each word appears in.
    documents: HashMap<String, usize>,
}

impl Index {
    pub fn new(passages: Vec<Passage>) -> Self {
        let mut index = Index::default();
        for passage in passages {
            let mut count: HashMap<String, f64> = HashMap::new();
            // A title says what the section is about: its words count three times.
            for w in words(&passage.title) {
                *count.entry(w).or_default() += 3.0;
            }
            for w in words(&passage.text) {
                *count.entry(w).or_default() += 1.0;
            }
            for w in count.keys() {
                *index.documents.entry(w.clone()).or_default() += 1;
            }
            index.lengths.push(count.values().sum());
            index.counts.push(count);
            index.passages.push(passage);
        }
        index
    }

    pub fn len(&self) -> usize {
        self.passages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.passages.is_empty()
    }

    /// The `limit` passages closest to `query`, best first, with their scores. Only passages sharing a word with it.
    pub fn search(&self, query: &str, limit: usize) -> Vec<(f64, &Passage)> {
        let (k1, b) = (1.2, 0.75);
        let n = self.passages.len() as f64;
        let average = if self.lengths.is_empty() { 1.0 } else { self.lengths.iter().sum::<f64>() / n };
        let mut query_words = words(query);
        query_words.sort();
        query_words.dedup();
        let mut scored: Vec<(f64, usize)> = (0..self.passages.len())
            .map(|i| {
                let score = query_words
                    .iter()
                    .filter_map(|w| {
                        let tf = *self.counts[i].get(w)?;
                        let df = *self.documents.get(w)? as f64;
                        let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
                        Some(idf * tf * (k1 + 1.0) / (tf + k1 * (1.0 - b + b * self.lengths[i] / average)))
                    })
                    .sum::<f64>();
                (score, i)
            })
            .filter(|(score, _)| *score > 0.0)
            .collect();
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        scored.into_iter().take(limit).map(|(score, i)| (score, &self.passages[i])).collect()
    }
}

/// The heading's anchor, as the documentation's builder makes it.
fn anchor(heading: &str) -> String {
    let mut out = String::new();
    for c in heading.trim().to_lowercase().chars() {
        if c.is_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else if c.is_whitespace() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// Every section of every Markdown page under `dir`, linked to where it is published under `base_url`.
pub fn markdown_passages(dir: &Path, base_url: &str) -> Vec<Passage> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                files.push(path);
            }
        }
    }
    files.sort();
    let mut out = Vec::new();
    for file in files {
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        let relative = file.strip_prefix(dir).unwrap_or(&file).to_string_lossy().replace('\\', "/");
        let page = relative.trim_end_matches(".md");
        let page = page.strip_suffix("index").unwrap_or(page);
        let url = format!("{}/{}{}", base_url.trim_end_matches('/'), page, if page.is_empty() || page.ends_with('/') { "" } else { "/" });
        out.extend(sections(&text, &url));
    }
    out
}

/// A page cut at its headings, each piece at most about 1,500 characters, cut between paragraphs.
pub fn sections(text: &str, url: &str) -> Vec<Passage> {
    let mut out = Vec::new();
    let mut page_title = String::new();
    let (mut heading, mut body, mut fenced) = (String::new(), String::new(), false);
    let flush = |page_title: &str, heading: &str, body: &str, out: &mut Vec<Passage>| {
        let body = body.trim();
        if body.len() < 40 {
            return;
        }
        let title = match (page_title.is_empty(), heading.is_empty()) {
            (false, false) if page_title != heading => format!("{page_title} › {heading}"),
            (true, false) | (false, false) => heading.to_string(),
            _ => page_title.to_string(),
        };
        let link = if heading.is_empty() || heading == page_title { url.to_string() } else { format!("{url}#{}", anchor(heading)) };
        let mut piece = String::new();
        for paragraph in body.split("\n\n") {
            if !piece.is_empty() && piece.len() + paragraph.len() > 1500 {
                out.push(Passage { title: title.clone(), link: link.clone(), text: piece.trim().to_string() });
                piece.clear();
            }
            piece.push_str(paragraph);
            piece.push_str("\n\n");
        }
        if !piece.trim().is_empty() {
            out.push(Passage { title, link, text: piece.trim().to_string() });
        }
    };
    let mut in_front_matter = text.starts_with("---\n");
    for (n, line) in text.lines().enumerate() {
        if in_front_matter {
            if n > 0 && line == "---" {
                in_front_matter = false;
            }
            continue;
        }
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        if !fenced {
            if let Some(h) = line.strip_prefix("# ") {
                page_title = h.trim().to_string();
                continue;
            }
            if let Some(h) = line.strip_prefix("## ").or_else(|| line.strip_prefix("### ")) {
                flush(&page_title, &heading, &body, &mut out);
                heading = h.trim().to_string();
                body.clear();
                continue;
            }
        }
        body.push_str(line);
        body.push('\n');
    }
    flush(&page_title, &heading, &body, &mut out);
    out
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------------------------------------

/// How many messages of a conversation are kept: the last four questions and their answers.
const KEPT_MESSAGES: usize = 8;
const KEPT_CONVERSATIONS: usize = 32;
const FORGOTTEN_AFTER: Duration = Duration::from_secs(60 * 60);

struct Conversation {
    messages: Vec<Message>,
    last: Instant,
}

#[derive(Clone, Debug, Serialize)]
pub struct Answer {
    /// Markdown.
    pub text: String,
    /// The passages it cites, in the order it numbers them.
    pub sources: Vec<Passage>,
    /// To ask a follow-up in the same conversation.
    pub conversation: String,
    /// Who wrote it, or None when no model did and the passages are the answer.
    pub provenance: Option<Provenance>,
}

pub struct Assistant {
    index: Index,
    conversations: Mutex<HashMap<String, Conversation>>,
}

const INSTRUCTIONS: &str = "You are the guide to DSTNS, a deterministic traffic simulator with a launcher, a server and a \
browser observer. Answer the question from the numbered sources below and the conversation so far. Put the number of \
each source you use in square brackets after what it supports, like [2]. If the sources do not answer it, say that \
DSTNS's documentation does not cover it, and suggest ./launcher docs or the Graph page. Do not invent settings, \
commands, files or numbers. You cannot run commands, change settings or see the user's screen: when something should \
be done, give the command or setting for them to use, in `backticks`, and never say you did it. Write Markdown: a \
short direct answer first, then a list or short code block only where it helps. Keep it under 200 words unless asked \
for more.";

impl Assistant {
    pub fn new(index: Index) -> Self {
        Self { index, conversations: Mutex::new(HashMap::new()) }
    }

    pub fn index(&self) -> &Index {
        &self.index
    }

    /// Forget a conversation, or every one.
    pub fn forget(&self, conversation: Option<&str>) {
        let mut all = self.conversations.lock().unwrap();
        match conversation {
            Some(id) => {
                all.remove(id);
            }
            None => all.clear(),
        }
    }

    fn history(&self, id: &str) -> Vec<Message> {
        let mut all = self.conversations.lock().unwrap();
        all.retain(|_, c| c.last.elapsed() < FORGOTTEN_AFTER);
        all.get(id).map(|c| c.messages.clone()).unwrap_or_default()
    }

    fn remember(&self, id: &str, question: &str, answer: &str) {
        let mut all = self.conversations.lock().unwrap();
        if !all.contains_key(id) && all.len() >= KEPT_CONVERSATIONS {
            if let Some(oldest) = all.iter().min_by_key(|(_, c)| c.last).map(|(k, _)| k.clone()) {
                all.remove(&oldest);
            }
        }
        let conversation = all.entry(id.to_string()).or_insert_with(|| Conversation { messages: vec![], last: Instant::now() });
        conversation.messages.push(Message::user(question));
        conversation.messages.push(Message::assistant(answer));
        let excess = conversation.messages.len().saturating_sub(KEPT_MESSAGES);
        conversation.messages.drain(..excess);
        conversation.last = Instant::now();
    }

    /// Answer `question`, in the conversation `conversation` (a new one if None or forgotten), with `extra` passages
    /// besides the documentation's. `on_text` receives the answer as it is written.
    pub fn ask(&self, settings: &Settings, question: &str, conversation: Option<&str>, extra: Vec<Passage>, on_text: Option<&mut dyn FnMut(&str)>) -> Result<Answer, AiError> {
        let question = question.trim();
        if question.is_empty() {
            return Err(AiError::new(ErrorKind::Rejected, "", "There is no question."));
        }
        let id = conversation.filter(|c| !c.is_empty()).map(String::from).unwrap_or_else(|| crate::serve::new_token()[..16].to_string());
        let history = self.history(&id);
        // A follow-up is searched with the question before it.
        let previous = history.iter().rev().find(|m| m.role == Role::User).map(|m| m.content.as_str()).unwrap_or("");
        let mut found: Vec<Passage> = self.index.search(&format!("{question} {question} {previous}"), 6).into_iter().map(|(_, p)| p.clone()).collect();
        found.extend(extra);

        let target = crate::resolve(settings).ok().and_then(|mut t| (!t.is_empty()).then(|| t.remove(0)));
        let Some(target) = target else {
            return Ok(self.without_model(question, id, found));
        };
        // Apple's model on the Mac reads about 4,000 tokens in all; the others far more.
        let budget = if target.provider.id == "apple" && target.model == "system" { 4_500 } else { 14_000 };
        let mut sources = Vec::new();
        let mut used = 0;
        for passage in found {
            let text: String = passage.text.chars().take(1_600).collect();
            if used + text.len() > budget && !sources.is_empty() {
                break;
            }
            used += text.len();
            sources.push(Passage { text, ..passage });
        }
        let mut listing = String::new();
        for (n, p) in sources.iter().enumerate() {
            listing.push_str(&format!("[{}] {}\n{}\n\n", n + 1, p.title, p.text));
        }
        if sources.is_empty() {
            listing.push_str("(No source matched this question.)\n\n");
        }
        let mut messages = vec![Message::system(INSTRUCTIONS)];
        let history_budget = if budget < 5_000 { 1_200 } else { 6_000 };
        let mut kept: Vec<Message> = Vec::new();
        let mut spent = 0;
        for m in history.iter().rev() {
            spent += m.content.len();
            if spent > history_budget {
                break;
            }
            kept.push(m.clone());
        }
        kept.reverse();
        messages.extend(kept);
        messages.push(Message::user(format!("Sources:\n\n{listing}Question: {question}")));
        let request = Request { messages, temperature: Some(0.2), max_tokens: Some(700) };
        let reply = match crate::complete(settings, &request, on_text) {
            Ok(reply) => reply,
            Err(error) if matches!(error.kind, ErrorKind::NotConfigured | ErrorKind::MissingKey) => return Ok(self.without_model(question, id, sources)),
            Err(error) => return Err(error),
        };
        self.remember(&id, question, &reply.text);
        // The sources it cited, renumbered in order; or, if it cited none, the three it was given first.
        let cited = cited(&reply.text);
        let (text, sources) = if cited.is_empty() {
            (reply.text.clone(), sources.into_iter().take(3).collect())
        } else {
            renumber(&reply.text, &cited, &sources)
        };
        Ok(Answer { text, sources, conversation: id, provenance: Some(reply.provenance) })
    }

    fn without_model(&self, question: &str, id: String, found: Vec<Passage>) -> Answer {
        let shown: Vec<Passage> = found.into_iter().take(3).collect();
        let mut text = if shown.is_empty() {
            format!("No model is set up (`./launcher model`), and DSTNS's documentation has nothing close to \"{question}\". Try `./launcher docs`.")
        } else {
            "No model is set up (`./launcher model`), so here is what DSTNS's documentation says closest to that:\n".to_string()
        };
        for (n, p) in shown.iter().enumerate() {
            let first: String = p.text.split("\n\n").next().unwrap_or("").chars().take(280).collect();
            text.push_str(&format!("\n- **{}** [{}]: {}", p.title, n + 1, first.replace('\n', " ")));
        }
        Answer { text, sources: shown, conversation: id, provenance: None }
    }
}

/// The source numbers an answer cites, in the order it first cites them.
pub fn cited(text: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            let rest = &text[i + 1..];
            if let Some(end) = rest.find(']') {
                for piece in rest[..end].split(',') {
                    if let Ok(n) = piece.trim().parse::<usize>() {
                        if n > 0 && !out.contains(&n) {
                            out.push(n);
                        }
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// The answer with its citations renumbered 1, 2, 3 in the order they appear, and the sources in that order. A number
/// with no source behind it is dropped.
fn renumber(text: &str, cited: &[usize], sources: &[Passage]) -> (String, Vec<Passage>) {
    let kept: Vec<usize> = cited.iter().copied().filter(|n| *n <= sources.len()).collect();
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('[') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find(']') {
            Some(end) if !after[..end].is_empty() && after[..end].split(',').all(|p| p.trim().parse::<usize>().is_ok()) => {
                let numbers: Vec<String> = after[..end].split(',').filter_map(|p| p.trim().parse::<usize>().ok()).filter_map(|n| kept.iter().position(|k| *k == n)).map(|i| (i + 1).to_string()).collect();
                if !numbers.is_empty() {
                    out.push_str(&format!("[{}]", numbers.join(", ")));
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    (out, kept.iter().map(|n| sources[n - 1].clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passage(title: &str, text: &str) -> Passage {
        Passage { title: title.into(), link: format!("https://example.test/{}", anchor(title)), text: text.into() }
    }

    fn index() -> Index {
        Index::new(vec![
            passage("Requirements", "DSTNS needs a 64-bit machine with 4 GB of memory, a C++20 compiler and CMake to build the engine."),
            passage("Realistic News", "Realistic News rewrites each notification in the words of a news report. Turn it off with narration.mode off."),
            passage("Ports", "The server listens on 127.0.0.1:8090 by default. api.port changes it; if the port is taken the next free one is used."),
            passage("Weather", "Storms move across the map, slow traffic and can flood low roads."),
        ])
    }

    #[test]
    fn words_are_compared_by_their_stems_and_parts() {
        assert_eq!(words("Running the routes"), vec!["runn", "rout"]);
        assert_eq!(words("route routed routes"), vec!["rout", "rout", "rout"]);
        assert!(words("narration.mode").contains(&"narration".to_string()) && words("narration.mode").contains(&"mode".to_string()));
        assert!(words("what is the of a").is_empty());
    }

    #[test]
    fn search_finds_the_section_a_question_is_about() {
        let index = index();
        assert_eq!(index.search("what are the minimum requirements?", 1)[0].1.title, "Requirements");
        assert_eq!(index.search("which port does the server use", 1)[0].1.title, "Ports");
        assert_eq!(index.search("how do I switch off the news", 1)[0].1.title, "Realistic News");
        assert!(index.search("quantum chromodynamics", 3).is_empty());
    }

    #[test]
    fn a_page_is_cut_at_its_headings_and_linked_to_each() {
        let page = "---\ntitle: x\n---\n# Configuration\n\nIntro text that is long enough to be kept as its own passage here.\n\n## Ports and addresses\n\nThe server listens on 8090 unless api.port says otherwise, and so on.\n\n```\n## not a heading\n```\n\n### Tiny\n\nshort\n";
        let found = sections(page, "https://docs.test/guide/configuration/");
        assert_eq!(found.len(), 2, "{found:#?}");
        assert_eq!(found[0].title, "Configuration");
        assert_eq!(found[1].title, "Configuration › Ports and addresses");
        assert_eq!(found[1].link, "https://docs.test/guide/configuration/#ports-and-addresses");
        assert!(found[1].text.contains("## not a heading"));
    }

    #[test]
    fn citations_are_renumbered_in_the_order_they_appear() {
        let sources = vec![passage("A", "a"), passage("B", "b"), passage("C", "c")];
        let text = "Use `api.port` [3]. It falls back [3, 1]. See [9] and [the guide] and [x].";
        let cited = cited(text);
        assert_eq!(cited, vec![3, 1, 9]);
        let (out, kept) = renumber(text, &cited, &sources);
        assert_eq!(out, "Use `api.port` [1]. It falls back [1, 2]. See  and [the guide] and [x].");
        assert_eq!(kept.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), vec!["C", "A"]);
    }

    #[test]
    fn without_a_model_the_passages_are_the_answer() {
        let assistant = Assistant::new(index());
        let settings = Settings { provider: "off".into(), ..Default::default() };
        let answer = assistant.ask(&settings, "which port?", None, vec![], None).unwrap();
        assert!(answer.provenance.is_none());
        assert!(answer.text.contains("No model is set up") && answer.text.contains("**Ports**"), "{}", answer.text);
        assert_eq!(answer.sources[0].title, "Ports");
        assert_eq!(answer.conversation.len(), 16);
        assert!(assistant.ask(&settings, "  ", None, vec![], None).is_err());
    }

    #[test]
    fn a_conversation_keeps_only_its_last_turns() {
        let assistant = Assistant::new(index());
        for n in 0..10 {
            assistant.remember("c", &format!("q{n}"), &format!("a{n}"));
        }
        let kept = assistant.history("c");
        assert_eq!(kept.len(), KEPT_MESSAGES);
        assert_eq!(kept[0].content, "q6");
        assistant.forget(Some("c"));
        assert!(assistant.history("c").is_empty());
    }
}
