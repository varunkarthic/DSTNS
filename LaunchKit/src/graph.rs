// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The knowledge graph, asked from the launcher: where something is, what it holds, what it calls and what calls it.
//!
//! The graph is data/graph/dstns-graph.json, which the Knowledge graph workflow keeps current, so a clone has it. It is
//! read once, and searched in plain words with no model: names are split as code names are (`seekBy` is `seek` and
//! `by`), lightly stemmed, widened by a few of DSTNS's own terms, ranked by how rare a word is and where it is found,
//! and a few question shapes ("who calls X", "what does X import", "what is in X", "functions in the launcher") are read
//! as what they ask. The console's `graph` command, the MCP Handler's graph tools and the plain-language answers all
//! come through here.

use crate::paths::Paths;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::OnceLock;

pub const FILE: &str = "data/graph/dstns-graph.json";
const GROUPS: &[(&str, &[&str], &str, &str)] = &[
    ("contains", &["contains", "defines", "method"], "contains", "is inside"),
    ("calls", &["calls", "indirect_call"], "calls", "is called by"),
    ("imports", &["imports", "imports_from", "dynamic_import", "re_exports"], "depends on", "is used by"),
    ("inherits", &["inherits", "implements"], "builds on", "is built on by"),
    ("references", &["references", "rationale_for"], "refers to", "is referred to by"),
];
const STOP: &[&str] = &["a", "an", "the", "of", "in", "on", "at", "to", "for", "from", "by", "with", "and", "or", "is", "are", "was", "be", "does", "do", "did", "how", "what", "where", "which", "who", "that", "this", "it", "its", "into", "about", "show", "find", "me", "list", "all", "any", "get", "tell", "there", "can", "i", "you"];
const THESAURUS: &[(&str, &[&str])] = &[
    ("seek", &["jump", "rewind", "skip"]), ("rewind", &["seek"]), ("jump", &["seek"]), ("map", &["osm", "topology", "network"]),
    ("weather", &["rain", "storm", "flood"]), ("signal", &["phase", "cycle"]), ("incident", &["accident", "closure"]),
    ("launcher", &["cli", "tui", "console"]), ("observer", &["ui", "webkit"]), ("fabric", &["api", "route", "endpoint"]),
    ("daemon", &["watcher", "rcs"]), ("setting", &["config", "option"]), ("security", &["auth", "token", "hmac"]),
    ("report", &["pdf", "export"]), ("film", &["boot", "particle", "scene"]), ("seed", &["rng", "random"]), ("world", &["scenario", "regenerate"]),
];

fn sort_word(w: &str) -> Option<&'static str> {
    Some(match w {
        "function" | "functions" | "method" | "methods" => "function",
        "class" | "classes" | "struct" | "structs" | "type" | "types" => "class",
        "file" | "files" | "module" | "modules" => "file",
        "doc" | "docs" | "page" | "pages" | "section" | "sections" => "section",
        _ => return None,
    })
}

fn area_word(w: &str) -> Option<&'static str> {
    Some(match w {
        "core" | "engine" => "Core",
        "fabric" | "api" | "webfabric" => "Fabric",
        "daemon" | "daemons" => "Daemon",
        "launcher" | "cli" | "launchkit" => "LaunchKit",
        "observer" | "ui" | "webkit" => "WebKit",
        "docs" | "documentation" => "docs",
        "tests" => "tests",
        "tools" => "tools",
        _ => return None,
    })
}

/// A name or a sentence as words: camelCase and snake_case split, lower case.
pub fn words(text: &str) -> Vec<String> {
    let mut spaced = String::new();
    let mut previous: Option<char> = None;
    for c in text.chars() {
        if let Some(p) = previous {
            if c.is_uppercase() && (p.is_lowercase() || p.is_ascii_digit()) {
                spaced.push(' ');
            }
        }
        spaced.push(c);
        previous = Some(c);
    }
    spaced.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

pub fn stem(w: &str) -> String {
    if w.len() > 5 && w.ends_with("ies") {
        return format!("{}y", &w[..w.len() - 3]);
    }
    if w.len() > 5 && w.ends_with("ing") {
        return w[..w.len() - 3].to_string();
    }
    if w.len() > 5 && w.ends_with("ed") {
        return w[..w.len() - 2].to_string();
    }
    if w.len() > 4 && w.ends_with('s') && !w.ends_with("ss") {
        return w[..w.len() - 1].to_string();
    }
    w.to_string()
}

pub struct Graph {
    pub repo: String,
    pub commit: String,
    labels: Vec<String>,
    files: Vec<String>,
    file: Vec<usize>,
    line: Vec<u64>,
    sort: Vec<String>,
    area: Vec<String>,
    degree: Vec<u64>,
    edges: Vec<(usize, usize, String)>,
    adjacency: Vec<Vec<usize>>,
    index: HashMap<String, HashMap<usize, f64>>,
}

/// What a question asked for, and what it found.
pub struct Found {
    pub understood: String,
    pub nodes: Vec<usize>,
}

impl Graph {
    pub fn parse(text: &str) -> Result<Graph, String> {
        let d: Value = serde_json::from_str(text).map_err(|e| format!("The graph could not be read: {e}"))?;
        let n = &d["nodes"];
        let strings = |v: &Value| v.as_array().map(|a| a.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect::<Vec<_>>()).unwrap_or_default();
        let numbers = |v: &Value| v.as_array().map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0)).collect::<Vec<_>>()).unwrap_or_default();
        let labels = strings(&n["label"]);
        let sorts = strings(&d["sorts"]);
        let areas = strings(&d["areas"]);
        let relations = strings(&d["relations"]);
        let count = labels.len();
        let pick = |names: &[String], key: &str| numbers(&n[key]).into_iter().map(|i| names.get(i as usize).cloned().unwrap_or_default()).collect::<Vec<_>>();
        let flat = numbers(&d["edges"]);
        let edges: Vec<(usize, usize, String)> = flat.chunks(3).filter(|c| c.len() == 3).map(|c| (c[0] as usize, c[1] as usize, relations.get(c[2] as usize).cloned().unwrap_or_default())).collect();
        let mut adjacency = vec![vec![]; count];
        for (k, (s, t, _)) in edges.iter().enumerate() {
            if *s < count && *t < count {
                adjacency[*s].push(k);
                adjacency[*t].push(k);
            }
        }
        let mut graph = Graph {
            repo: d["repo"].as_str().unwrap_or("varunkarthic/DSTNS").into(),
            commit: d["commit"].as_str().unwrap_or("").into(),
            files: strings(&d["files"]),
            file: numbers(&n["file"]).into_iter().map(|x| x as usize).collect(),
            line: numbers(&n["line"]),
            sort: if sorts.is_empty() { vec!["other".into(); count] } else { pick(&sorts, "sort") },
            area: pick(&areas, "area"),
            degree: numbers(&n["degree"]),
            labels,
            edges,
            adjacency,
            index: HashMap::new(),
        };
        for i in 0..count {
            for w in words(&graph.labels[i]) {
                graph.add(&w, i, 3.0);
            }
            let flat: String = graph.labels[i].to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            graph.add(&flat, i, 3.5);
            for w in words(&graph.file_of(i).to_string()) {
                graph.add(&w, i, 1.1);
            }
        }
        Ok(graph)
    }

    fn add(&mut self, token: &str, node: usize, weight: f64) {
        let slot = self.index.entry(stem(token)).or_default();
        let old = slot.get(&node).copied().unwrap_or(0.0);
        slot.insert(node, old.max(weight));
    }

    pub fn count(&self) -> usize {
        self.labels.len()
    }
    pub fn edge_count(&self) -> usize {
        self.edges.len()
    }
    pub fn label(&self, i: usize) -> &str {
        &self.labels[i]
    }
    pub fn file_of(&self, i: usize) -> &str {
        self.file.get(i).and_then(|f| self.files.get(*f)).map(String::as_str).unwrap_or("")
    }
    pub fn sort_of(&self, i: usize) -> &str {
        &self.sort[i]
    }
    pub fn where_is(&self, i: usize) -> String {
        match (self.file_of(i), self.line.get(i).copied().unwrap_or(0)) {
            ("", _) => self.area.get(i).cloned().unwrap_or_default(),
            (f, 0) => f.to_string(),
            (f, l) => format!("{f}:{l}"),
        }
    }
    pub fn url(&self, i: usize) -> String {
        let f = self.file_of(i);
        if f.is_empty() {
            return String::new();
        }
        let line = self.line.get(i).copied().unwrap_or(0);
        format!("https://github.com/{}/blob/{}/{f}{}", self.repo, self.commit, if line > 0 { format!("#L{line}") } else { String::new() })
    }
    /// One line for a node: its name, what it is, and where.
    pub fn describe(&self, i: usize) -> String {
        format!("{:<40} {:<9} {}", self.labels[i], self.sort[i], self.where_is(i))
    }

    fn idf(&self, token: &str) -> f64 {
        self.index.get(token).map(|s| (1.0 + self.count() as f64 / s.len() as f64).ln()).unwrap_or(0.0)
    }

    fn expand(&self, word: &str) -> Vec<(String, f64)> {
        let t = stem(word);
        let mut out = vec![(t.clone(), 1.0)];
        for (key, related) in THESAURUS {
            if *key == t || *key == word {
                out.extend(related.iter().map(|r| (stem(r), 0.8)));
            }
        }
        if !self.index.contains_key(&t) && t.len() >= 4 {
            out.extend(self.index.keys().filter(|k| k.starts_with(&t)).take(8).map(|k| (k.clone(), 0.7)));
        }
        out
    }

    /// Nodes for words, best first: short queries need every word, a sentence most of them.
    fn rank(&self, query: &[String], sorts: &[&str], areas: &[&str], among: Option<&HashSet<usize>>, limit: usize) -> Vec<usize> {
        let mut score: HashMap<usize, f64> = HashMap::new();
        let mut covered: HashMap<usize, usize> = HashMap::new();
        if query.is_empty() {
            let all: Box<dyn Iterator<Item = usize>> = match among {
                Some(set) => Box::new(set.iter().copied()),
                None => Box::new(0..self.count()),
            };
            for i in all {
                score.insert(i, 1.0 + (1.0 + self.degree[i] as f64).ln());
                covered.insert(i, 0);
            }
        } else {
            for word in query {
                let mut got: HashMap<usize, f64> = HashMap::new();
                for (term, weight) in self.expand(word) {
                    if let Some(slot) = self.index.get(&term) {
                        let idf = self.idf(&term) * weight;
                        for (node, field) in slot {
                            let v = got.entry(*node).or_insert(0.0);
                            *v = v.max(field * idf);
                        }
                    }
                }
                for (node, v) in got {
                    *score.entry(node).or_insert(0.0) += v;
                    *covered.entry(node).or_insert(0) += 1;
                }
            }
        }
        let need = if query.len() <= 2 { query.len() } else { (query.len() as f64 * 0.6).ceil() as usize };
        let whole: String = query.concat();
        let mut out: Vec<(f64, usize)> = score
            .into_iter()
            .filter(|(node, _)| covered[node] >= need)
            .filter(|(node, _)| among.map(|s| s.contains(node)).unwrap_or(true))
            .filter(|(node, _)| sorts.is_empty() || sorts.contains(&self.sort[*node].as_str()))
            .filter(|(node, _)| areas.is_empty() || areas.contains(&self.area[*node].as_str()))
            .map(|(node, v)| {
                let flat: String = self.labels[node].to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
                let exact = if !whole.is_empty() && flat == whole { 30.0 } else if !whole.is_empty() && flat.starts_with(&whole) { 12.0 } else { 0.0 };
                let share = if query.is_empty() { 1.0 } else { covered[&node] as f64 / query.len() as f64 };
                (v * share + exact + (1.0 + self.degree[node] as f64).ln() * 0.4, node)
            })
            .collect();
        out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
        out.into_iter().take(limit).map(|(_, n)| n).collect()
    }

    fn group(name: &str) -> &'static (&'static str, &'static [&'static str], &'static str, &'static str) {
        GROUPS.iter().find(|g| g.0 == name).unwrap_or(&GROUPS[0])
    }

    /// What is joined to a node by a kind of relation, in one direction: "out" is what it calls, "in" what calls it.
    pub fn around(&self, node: usize, group: &str, direction: &str) -> Vec<usize> {
        let kinds = Self::group(group).1;
        let mut out: Vec<usize> = self.adjacency[node]
            .iter()
            .filter_map(|k| {
                let (s, t, rel) = &self.edges[*k];
                if !kinds.contains(&rel.as_str()) {
                    return None;
                }
                if direction == "out" && *s == node { Some(*t) } else if direction == "in" && *t == node { Some(*s) } else { None }
            })
            .collect();
        out.sort_by(|a, b| self.file_of(*a).cmp(self.file_of(*b)).then(self.line[*a].cmp(&self.line[*b])));
        out.dedup();
        out
    }

    fn file_node(&self, node: usize) -> usize {
        if self.sort[node] == "file" || self.file_of(node).is_empty() {
            return node;
        }
        (0..self.count()).find(|i| self.sort[*i] == "file" && self.file[*i] == self.file[node]).unwrap_or(node)
    }

    /// The node a name means. With a relation, the first of the likely ones the question has an answer for; what
    /// depends on what is said of files, so a class or function stands for its file there.
    pub fn subject(&self, name: &str, relation: Option<(&str, &str)>) -> Option<usize> {
        let mut found = self.rank(&words(name), &[], &[], None, 8);
        if found.is_empty() {
            let mut rare: Vec<String> = words(name).into_iter().filter(|w| !STOP.contains(&w.as_str())).collect();
            rare.sort_by(|a, b| self.idf(&stem(b)).partial_cmp(&self.idf(&stem(a))).unwrap_or(std::cmp::Ordering::Equal));
            for w in rare {
                found = self.rank(&[w], &[], &[], None, 8);
                if !found.is_empty() {
                    break;
                }
            }
        }
        let Some((group, direction)) = relation else { return found.first().copied() };
        let stand = |n: usize| if group == "imports" { self.file_node(n) } else { n };
        found.iter().map(|n| stand(*n)).find(|n| !self.around(*n, group, direction).is_empty()).or(found.first().map(|n| stand(*n)))
    }

    /// A question in plain words, answered from the graph alone.
    pub fn ask(&self, question: &str, limit: usize) -> Found {
        let text = question.trim().trim_end_matches(['?', '.', '!']);
        let lower = text.to_lowercase();
        // Matched in lower case; the name keeps its own case, so seekBy still splits into seek and by.
        let original = |found: &str| lower.rfind(found).and_then(|at| text.get(at..at + found.len())).map(String::from).unwrap_or_else(|| found.to_string());
        let shapes: &[(&str, &str, &str, &str)] = &[
            (r"^(?:who|what|which(?: \w+)?)?\s*(?:calls|uses|invokes)\s+(.+)$", "calls", "in", ""),
            (r"^(?:callers|users) of\s+(.+)$", "calls", "in", ""),
            (r"^what (?:does|do)\s+(.+?)\s+(?:call|use|invoke)$", "calls", "out", ""),
            (r"^(?:who|what|which(?: \w+)?)?\s*(?:imports|depends on|needs|includes)\s+(.+)$", "imports", "in", ""),
            (r"^what (?:does|do)\s+(.+?)\s+(?:import|depend on|need|include)$", "imports", "out", ""),
            (r"^(?:dependencies|imports) of\s+(.+)$", "imports", "out", ""),
            (r"^what(?:'s| is)? (?:in|inside)\s+(.+)$", "contains", "out", ""),
            (r"^(?:contents|members) of\s+(.+)$", "contains", "out", ""),
        ];
        for (shape, group, direction, _) in shapes {
            if let Some(m) = regex::Regex::new(shape).ok().and_then(|r| r.captures(&lower)) {
                let name = original(&m[1]);
                let Some(node) = self.subject(&name, Some((group, direction))) else {
                    return Found { understood: format!("nothing in the graph is called {name}"), nodes: vec![] };
                };
                let g = Self::group(group);
                let mut nodes = self.around(node, group, direction);
                nodes.truncate(limit);
                return Found { understood: format!("what {} {} ({})", if *direction == "out" { g.2 } else { g.3 }, self.labels[node], self.where_is(node)), nodes };
            }
        }
        let text = regex::Regex::new(r"^where (?:is|are)\s+(.+?)(?: defined| declared)?$").ok().and_then(|r| r.captures(&lower)).map(|m| original(&m[1])).unwrap_or_else(|| text.to_string());
        let tokens: Vec<String> = text.split_whitespace().map(|t| t.to_lowercase()).collect();
        let mut sorts = vec![];
        let mut areas = vec![];
        let mut query = vec![];
        let mut i = 0;
        while i < tokens.len() {
            let w = tokens[i].as_str();
            if matches!(w, "in" | "inside" | "from") {
                let next = if tokens.get(i + 1).map(String::as_str) == Some("the") { i + 2 } else { i + 1 };
                if let Some(area) = tokens.get(next).and_then(|t| area_word(t)) {
                    areas.push(area);
                    i = next + 1;
                    continue;
                }
            }
            if let Some(s) = sort_word(w).filter(|_| tokens.len() > 1) {
                sorts.push(s);
            } else if !STOP.contains(&w) {
                query.extend(words(text.split_whitespace().nth(i).unwrap_or(w)));
            }
            i += 1;
        }
        let nodes = self.rank(&query, &sorts, &areas, None, limit);
        let mut understood = vec![];
        if !sorts.is_empty() {
            understood.push(sorts.join(", "));
        }
        if !areas.is_empty() {
            understood.push(format!("in {}", areas.join(", ")));
        }
        if !query.is_empty() {
            understood.push(format!("matching {}", query.join(" ")));
        }
        Found { understood: understood.join(", "), nodes }
    }

    /// Everything about one node, as lines.
    pub fn show(&self, node: usize) -> Vec<String> {
        let mut out = vec![
            format!("{}  ({}, {})", self.labels[node], self.sort[node], self.area[node]),
            format!("  source       {}", self.where_is(node)),
        ];
        let url = self.url(node);
        if !url.is_empty() {
            out.push(format!("  on GitHub    {url}"));
        }
        out.push(format!("  connections  {}", self.degree[node]));
        for (group, _, outward, inward) in GROUPS {
            for (direction, name) in [("out", outward), ("in", inward)] {
                let items = self.around(node, group, direction);
                if items.is_empty() {
                    continue;
                }
                out.push(format!("  {name} ({}):", items.len()));
                for i in items.iter().take(12) {
                    out.push(format!("    {}", self.describe(*i)));
                }
                if items.len() > 12 {
                    out.push(format!("    and {} more", items.len() - 12));
                }
            }
        }
        out
    }

    /// The shortest chain between two nodes, as steps.
    pub fn path(&self, from: usize, to: usize) -> Option<Vec<String>> {
        let mut before: HashMap<usize, Option<(usize, usize)>> = HashMap::from([(from, None)]);
        let mut queue = VecDeque::from([from]);
        while let Some(v) = queue.pop_front() {
            if v == to {
                break;
            }
            for k in &self.adjacency[v] {
                let (s, t, _) = &self.edges[*k];
                let o = if *s == v { *t } else { *s };
                if let std::collections::hash_map::Entry::Vacant(e) = before.entry(o) {
                    e.insert(Some((v, *k)));
                    queue.push_back(o);
                }
            }
        }
        before.get(&to)?;
        let mut steps = vec![];
        let mut v = to;
        while let Some(Some((p, k))) = before.get(&v) {
            steps.push(format!("{} --{}--> {}   ({})", self.labels[*p], self.edges[*k].2, self.labels[v], self.where_is(v)));
            v = *p;
        }
        steps.reverse();
        Some(steps)
    }

    /// What the graph says about a question, as facts a model can answer from.
    pub fn facts(&self, question: &str) -> Vec<String> {
        let found = self.ask(question, 12);
        let mut out = vec![format!("The question was read as: {}.", if found.understood.is_empty() { "a search" } else { &found.understood })];
        out.extend(found.nodes.iter().map(|i| format!("- {} ({}) at {}", self.labels[*i], self.sort[*i], self.where_is(*i))));
        if let Some(first) = found.nodes.first() {
            for (group, _, outward, inward) in GROUPS.iter().take(3) {
                for (direction, name) in [("out", outward), ("in", inward)] {
                    let items = self.around(*first, group, direction);
                    if !items.is_empty() {
                        out.push(format!("- {} {name}: {}", self.labels[*first], items.iter().take(8).map(|i| self.labels[*i].as_str()).collect::<Vec<_>>().join(", ")));
                    }
                }
            }
        }
        out
    }
}

/// The graph in this checkout, read once.
pub fn load(paths: &Paths) -> Result<&'static Graph, String> {
    static GRAPH: OnceLock<Result<Graph, String>> = OnceLock::new();
    GRAPH
        .get_or_init(|| {
            let file = paths.root.join(FILE);
            let text = std::fs::read_to_string(&file).map_err(|_| format!("No knowledge graph at {FILE}. graph update builds it (it needs graphify: pip install graphifyy)."))?;
            Graph::parse(&text)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// A few lines for a question, from the graph alone: what it was read as, and what was found, each with where.
pub fn answer(graph: &Graph, question: &str, limit: usize) -> Vec<String> {
    let found = graph.ask(question, limit);
    let mut out = vec![];
    if !found.understood.is_empty() {
        out.push(format!("Read as {}.", found.understood));
    }
    if found.nodes.is_empty() {
        out.push("Nothing in the graph answers that. Try other words, or graph search NAME.".into());
    }
    out.extend(found.nodes.iter().map(|i| graph.describe(*i)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> Graph {
        Graph::parse(r#"{"repo":"x/y","commit":"abc","files":["","Core/src/engine.cpp","WebKit/src/SeekFilm.tsx","LaunchKit/src/config.rs"],
          "sorts":["file","class","function","section","document","concept","other"],
          "areas":["Core","WebKit","LaunchKit","Other","Concepts"],"relations":["calls","contains","imports"],
          "nodes":{"id":["a","b","c","d","e"],"label":["SimulationEngine","SimulationEngine::step_to()","physics_step()","SeekFilm()","save()"],
            "file":[1,1,1,2,3],"line":[37,1656,1451,40,54],"sort":[1,2,2,2,2],"area":[0,0,0,1,2],"degree":[2,2,1,0,0]},
          "edges":[1,2,0, 0,1,1]}"#).unwrap()
    }

    #[test]
    fn names_split_as_code_names_do() {
        assert_eq!(words("seekBy step_to SimulationEngine"), vec!["seek", "by", "step", "to", "simulation", "engine"]);
        assert_eq!(stem("settings"), "setting");
    }

    #[test]
    fn questions_are_read_as_what_they_ask() {
        let g = tiny();
        let callers = g.ask("who calls physics_step", 10);
        assert_eq!(callers.nodes.iter().map(|n| g.label(*n)).collect::<Vec<_>>(), vec!["SimulationEngine::step_to()"]);
        assert!(callers.understood.contains("is called by physics_step()"), "{}", callers.understood);
        let inside = g.ask("what is in SimulationEngine", 10);
        assert_eq!(inside.nodes.len(), 1);
        let launcher = g.ask("functions in the launcher that save settings", 10);
        assert_eq!(launcher.nodes.iter().map(|n| g.label(*n)).collect::<Vec<_>>(), vec!["save()"]);
        // A typo's worth of a name still finds it, by what it starts with.
        assert_eq!(g.label(g.ask("simulat", 1).nodes[0]), "SimulationEngine");
        assert!(g.path(0, 2).unwrap().len() == 2);
        assert!(g.url(2).ends_with("Core/src/engine.cpp#L1451"));
    }
}
