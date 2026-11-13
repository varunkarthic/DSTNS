// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The MCP Handler: the Model Context Protocol, so that an AI client can call DSTNS.
//!
//! `./launcher mcp serve` speaks MCP over standard input and output, as an MCP client starts it. Every route the
//! running server lists in its endpoint index becomes a tool, as does a generic request and a few of the launcher's
//! own actions. No agent is included: this is the door, for a client to come through, and it is closed by default.
//!
//! What a client may do is the operator's to decide, in ./launcher config under MCP: `mcp.enabled` opens it for
//! reading, `mcp.allow_writes` lets it call routes that change things, and `mcp.allow_launcher` lets it start and stop
//! simulations. Every call is written to the launcher's log. The client acts with the operator's credential, as the
//! launcher does, which is why changes are off until a person turns them on.
//!
//! To add a tool, add a `Tool` to `launcher_tools` (or anything that returns tools): a name, a description, a JSON
//! Schema for its arguments, whether it only reads, and what it does.

use super::{Command, Module, Options};
use crate::api;
use crate::cli::{Context, EXIT_OK};
use crate::config::{self, RunOptions};
use crate::errors::{LauncherError, Result};
use crate::paths::Paths;
use crate::process::Cancel;
use crate::reporting::Quiet;
use crate::session::Session;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::sync::Arc;

/// The MCP revisions this handler speaks, newest first.
pub const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const USAGE: &str = "usage: ./launcher mcp [serve|tools|client-config]

  serve                     Speak the Model Context Protocol over standard input and output, for an MCP
                            client to start. Needs mcp.enabled (./launcher config, under MCP)
  tools                     List the tools a client would be offered now
  client-config             Print what to add to an MCP client's configuration to start this handler
";

pub fn module() -> Module {
    Module {
        commands: vec![Command { name: "mcp", usage: "mcp [serve|tools|client-config]", summary: "The MCP Handler: let an AI client call DSTNS through the Model Context Protocol", run }],
        pages: vec![],
    }
}

/// What the operator allows.
#[derive(Clone, Copy, Debug, Default)]
pub struct Policy {
    pub enabled: bool,
    pub writes: bool,
    pub launcher: bool,
    /// Advanced Security: nothing changes the launcher or the engine from here; Fabric's applications still may.
    pub guarded: bool,
}

/// What a client may still change under Advanced Security: the applications' own routes.
const GUARDED_WRITABLE: &str = "/api/v1/fabric/apps/";

impl Policy {
    pub fn from_config(settings: &Value) -> Self {
        let guarded = config::flag(settings, crate::security::KEY);
        Self { enabled: config::flag(settings, "mcp.enabled"), writes: config::flag(settings, "mcp.allow_writes"), launcher: config::flag(settings, "mcp.allow_launcher") && !guarded, guarded }
    }

    pub fn may_change(&self, path: &str) -> bool {
        self.writes && (!self.guarded || path.starts_with(GUARDED_WRITABLE))
    }
}

pub type Handler = Box<dyn Fn(&Value) -> Result<Value> + Send + Sync>;

pub struct Tool {
    pub name: String,
    pub description: String,
    pub schema: Value,
    pub read_only: bool,
    pub handler: Handler,
}

impl Tool {
    pub fn spec(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": self.schema,
            "annotations": {"readOnlyHint": self.read_only, "destructiveHint": !self.read_only, "openWorldHint": false},
        })
    }
}

/// A route's tool name: its method and path, as words. `/api/v1/fabric/apps/{id}` with PUT is put_fabric_apps_id.
pub fn tool_name(method: &str, path: &str) -> String {
    let trimmed = path.trim_start_matches("/api/v1/").trim_start_matches('/');
    let words: Vec<String> = trimmed.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).map(|w| w.to_lowercase()).collect();
    let name = format!("{}_{}", method.to_lowercase(), words.join("_"));
    name.chars().take(64).collect()
}

/// Every route in the server's endpoint index, as (method, path, description), with {a|b} alternatives made one each.
pub fn routes(index: &Value) -> Vec<(String, String, String)> {
    let mut out = vec![];
    for group in index.get("groups").and_then(|g| g.as_array()).cloned().unwrap_or_default() {
        for endpoint in group.get("endpoints").and_then(|e| e.as_array()).cloned().unwrap_or_default() {
            let method = endpoint.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_string();
            let path = endpoint.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let description = endpoint.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match (path.find("{"), path.find('|')) {
                (Some(open), Some(bar)) if bar > open => {
                    let close = path[open..].find('}').map(|c| open + c).unwrap_or(path.len());
                    for choice in path[open + 1..close].split('|') {
                        out.push((method.clone(), format!("{}{choice}{}", &path[..open], &path[(close + 1).min(path.len())..]), description.clone()));
                    }
                }
                _ => out.push((method, path, description)),
            }
        }
    }
    out
}

fn parameters(path: &str) -> Vec<String> {
    let mut names = vec![];
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { break };
        names.push(rest[open + 1..open + close].to_string());
        rest = &rest[open + close + 1..];
    }
    names
}

fn percent(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Fill in a route's parameters and query from a tool's arguments.
pub fn address(path: &str, arguments: &Value) -> Result<String> {
    let mut filled = path.to_string();
    for name in parameters(path) {
        let value = arguments.get(&name).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).ok_or_else(|| LauncherError::config(format!("{name} is needed")))?;
        if value.is_empty() || value.contains('/') || value.contains("..") {
            return Err(LauncherError::config(format!("{name} must be a single path segment")));
        }
        filled = filled.replace(&format!("{{{name}}}"), &percent(&value));
    }
    if let Some(query) = arguments.get("query").and_then(|q| q.as_object()).filter(|q| !q.is_empty()) {
        let pairs: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", percent(k), percent(&v.as_str().map(String::from).unwrap_or_else(|| v.to_string())))).collect();
        filled = format!("{filled}?{}", pairs.join("&"));
    }
    Ok(filled)
}

fn answer(response: api::Response) -> Result<Value> {
    if response.code == 0 {
        return Err(LauncherError::generic("The DSTNS server could not be reached.").remedy("Start one with ./launcher start."));
    }
    Ok(json!({"status": response.code, "body": response.body}))
}

/// The tools for every route the running server lists. Without a server, none: the client can ask again later.
pub fn route_tools(paths: &Paths, policy: Policy) -> Vec<Tool> {
    let Some(port) = crate::server::active_port(paths) else { return vec![] };
    let index = api::get(port, "/api/v1/system/endpoints", 5.0, paths).body;
    let mut seen = std::collections::BTreeSet::new();
    let mut tools = vec![];
    for (method, path, description) in routes(&index) {
        let read_only = method == "GET";
        if !read_only && !policy.may_change(&path) {
            continue;
        }
        let name = tool_name(&method, &path);
        if !seen.insert(name.clone()) {
            continue;
        }
        let mut properties = Map::new();
        let required: Vec<String> = parameters(&path);
        for parameter in &required {
            properties.insert(parameter.clone(), json!({"type": "string", "description": format!("The {parameter} in {path}")}));
        }
        properties.insert("query".into(), json!({"type": "object", "description": "Query parameters, as strings", "additionalProperties": {"type": "string"}}));
        if !read_only {
            properties.insert("body".into(), json!({"type": "object", "description": "The JSON request body. See https://dstns.readthedocs.io/api/endpoints/"}));
        }
        let paths = paths.clone();
        let (route_method, route_path) = (method.clone(), path.clone());
        tools.push(Tool {
            name,
            description: format!("{method} {path}: {description}"),
            schema: json!({"type": "object", "properties": properties, "required": required}),
            read_only,
            handler: Box::new(move |arguments| {
                let port = crate::server::active_port(&paths).ok_or_else(|| LauncherError::generic("No DSTNS server is running."))?;
                let target = address(&route_path, arguments)?;
                let body = arguments.get("body").cloned().unwrap_or_else(|| json!({}));
                answer(api::call(port, &target, &route_method, if route_method == "GET" { None } else { Some(&body) }, 60.0, &paths))
            }),
        });
    }
    tools
}

/// Any request to the running server, within what the operator allows.
fn request_tool(paths: &Paths, policy: Policy) -> Tool {
    let paths = paths.clone();
    Tool {
        name: "dstns_request".into(),
        description: "Call any DSTNS API route on the running server. GET reads; POST, PUT and DELETE change things, and are refused unless the operator allows changes.".into(),
        schema: json!({
            "type": "object",
            "properties": {
                "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE"]},
                "path": {"type": "string", "description": "Starting /api/ or /health, such as /api/v1/view/traffic"},
                "query": {"type": "object", "additionalProperties": {"type": "string"}},
                "body": {"type": "object"}
            },
            "required": ["method", "path"]
        }),
        read_only: !policy.writes,
        handler: Box::new(move |arguments| {
            let method = arguments.get("method").and_then(|m| m.as_str()).unwrap_or("GET").to_uppercase();
            let path = arguments.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if !(path.starts_with("/api/") || path == "/health") || path.contains("..") || path.contains('?') || path.contains('#') {
                return Err(LauncherError::config("path must start /api/ or be /health, with any query in query"));
            }
            if method != "GET" && !policy.may_change(path) {
                return Err(if policy.writes {
                    LauncherError::config("Changes are not allowed: Advanced Security is on, and only Fabric's applications may be changed.")
                } else {
                    LauncherError::config("Changes are not allowed.").remedy("The operator can allow them with ./launcher config set mcp.allow_writes on.")
                });
            }
            if !["GET", "POST", "PUT", "DELETE"].contains(&method.as_str()) {
                return Err(LauncherError::config("method must be GET, POST, PUT or DELETE"));
            }
            let port = crate::server::active_port(&paths).ok_or_else(|| LauncherError::generic("No DSTNS server is running."))?;
            let target = address(path, arguments)?;
            let body = arguments.get("body").cloned().unwrap_or(json!({}));
            answer(api::call(port, &target, &method, if method == "GET" { None } else { Some(&body) }, 60.0, &paths))
        }),
    }
}

/// The knowledge graph, from this checkout: read-only, and so offered whatever else is allowed.
pub fn graph_tools(paths: &Paths) -> Vec<Tool> {
    fn node(g: &crate::graph::Graph, i: usize) -> Value {
        json!({"name": g.label(i), "type": g.sort_of(i), "where": g.where_is(i), "url": g.url(i)})
    }
    let graph = |p: &Paths| crate::graph::load(p).map_err(LauncherError::config);
    let text = |a: &Value, key: &str| a.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (p1, p2, p3, p4) = (paths.clone(), paths.clone(), paths.clone(), paths.clone());
    vec![
        Tool {
            name: "graph_ask".into(),
            description: "Ask DSTNS's knowledge graph in plain words, with no model: \"who calls physics_step\", \"what does next_world.cpp import\", \"what is in SimulationEngine\", \"functions in the launcher that save settings\". Each answer has its file, line and a GitHub link. Ask it before reading source.".into(),
            schema: json!({"type": "object", "properties": {"question": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}}, "required": ["question"]}),
            read_only: true,
            handler: Box::new(move |a| {
                let g = graph(&p1)?;
                let found = g.ask(&text(&a, "question"), a.get("limit").and_then(|l| l.as_u64()).unwrap_or(20) as usize);
                Ok(json!({"read_as": found.understood, "found": found.nodes.iter().map(|i| node(g, *i)).collect::<Vec<_>>()}))
            }),
        },
        Tool {
            name: "graph_show".into(),
            description: "Everything the knowledge graph knows about one file, class or function: where it is, and what it contains, calls, depends on and is used by.".into(),
            schema: json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}),
            read_only: true,
            handler: Box::new(move |a| {
                let g = graph(&p2)?;
                let name = text(&a, "name");
                let i = g.subject(&name, None).ok_or_else(|| LauncherError::config(format!("Nothing in the graph is called {name}.")))?;
                let mut out = node(g, i);
                for (group, direction, key) in [("contains", "out", "contains"), ("contains", "in", "inside"), ("calls", "out", "calls"), ("calls", "in", "called_by"), ("imports", "out", "depends_on"), ("imports", "in", "used_by"), ("references", "out", "refers_to"), ("references", "in", "referred_to_by")] {
                    let items = g.around(i, group, direction);
                    if !items.is_empty() {
                        out[key] = Value::Array(items.iter().take(60).map(|n| node(g, *n)).collect());
                    }
                }
                Ok(out)
            }),
        },
        Tool {
            name: "graph_relations".into(),
            description: "What is joined to a name in the knowledge graph by one relation: callers, callees, dependencies (what a file imports), users (what imports it) or members (what it contains).".into(),
            schema: json!({"type": "object", "properties": {"name": {"type": "string"}, "relation": {"type": "string", "enum": ["callers", "callees", "dependencies", "users", "members"]}}, "required": ["name", "relation"]}),
            read_only: true,
            handler: Box::new(move |a| {
                let g = graph(&p3)?;
                let (group, direction) = match text(&a, "relation").as_str() {
                    "callers" => ("calls", "in"),
                    "callees" => ("calls", "out"),
                    "dependencies" => ("imports", "out"),
                    "users" => ("imports", "in"),
                    _ => ("contains", "out"),
                };
                let name = text(&a, "name");
                let i = g.subject(&name, Some((group, direction))).ok_or_else(|| LauncherError::config(format!("Nothing in the graph is called {name}.")))?;
                Ok(json!({"of": node(g, i), "relation": text(&a, "relation"), "found": g.around(i, group, direction).iter().map(|n| node(g, *n)).collect::<Vec<_>>()}))
            }),
        },
        Tool {
            name: "graph_path".into(),
            description: "The shortest chain of relations between two names in the knowledge graph, such as how SeekFilm reaches SimulationEngine.".into(),
            schema: json!({"type": "object", "properties": {"from": {"type": "string"}, "to": {"type": "string"}}, "required": ["from", "to"]}),
            read_only: true,
            handler: Box::new(move |a| {
                let g = graph(&p4)?;
                let (Some(from), Some(to)) = (g.subject(&text(&a, "from"), None), g.subject(&text(&a, "to"), None)) else { return Err(LauncherError::config("One of them is not in the graph.")) };
                Ok(json!({"from": node(g, from), "to": node(g, to), "steps": g.path(from, to).unwrap_or_default()}))
            }),
        },
    ]
}

/// The launcher's own: what is running, its settings, and, if allowed, starting and stopping.
/// Questions about DSTNS, answered from its documentation and code. It only informs: it runs nothing and changes
/// nothing, and an answer that calls for an action names the command for whoever asked.
pub fn ask_tool(paths: &Paths) -> Tool {
    let p = paths.clone();
    Tool {
        name: "dstns_ask".into(),
        description: "Ask about DSTNS in plain words: what it does, what it needs, how to use a feature, what a setting means, how to fix a problem. The answer is Markdown, grounded in DSTNS's documentation (and its code, for questions about code), with the sources it cites. Pass conversation from a previous answer to ask a follow-up. It only informs: nothing is run or changed. AI-written: check anything that matters.".into(),
        schema: json!({"type": "object", "properties": {
            "question": {"type": "string", "description": "The question, in plain words"},
            "conversation": {"type": "string", "description": "The conversation of an earlier answer, for a follow-up"}
        }, "required": ["question"]}),
        read_only: true,
        handler: Box::new(move |a| {
            let question = a.get("question").and_then(|v| v.as_str()).unwrap_or("");
            let conversation = a.get("conversation").and_then(|v| v.as_str());
            let answer = crate::assistant::answer(&p, question, conversation, None).map_err(LauncherError::config)?;
            Ok(crate::assistant::answer_json(&answer))
        }),
    }
}

pub fn launcher_tools(paths: &Paths, policy: Policy, session: Arc<Session>) -> Vec<Tool> {
    let p = paths.clone();
    let mut tools = vec![
        Tool {
            name: "launcher_status".into(),
            description: "Whether a DSTNS server is running, and what its simulation is doing.".into(),
            schema: json!({"type": "object", "properties": {}}),
            read_only: true,
            handler: Box::new(move |_| {
                Ok(match crate::server::active_port(&p) {
                    None => json!({"server": "not running"}),
                    Some(port) => {
                        let status = crate::simulation::status(port, &p);
                        json!({"server": "running", "port": port, "lifecycle": status.lifecycle, "seed": status.seed, "clock": status.clock, "observer": format!("http://127.0.0.1:{port}/")})
                    }
                })
            }),
        },
        {
            let p = paths.clone();
            Tool {
                name: "launcher_config_get".into(),
                description: "Read the launcher's settings: one, by key, or all of them.".into(),
                schema: json!({"type": "object", "properties": {"key": {"type": "string", "description": "Such as performance.compression; leave out for all"}}}),
                read_only: true,
                handler: Box::new(move |arguments| {
                    let current = config::load(&p)?;
                    match arguments.get("key").and_then(|k| k.as_str()) {
                        Some(key) => Ok(json!({key: config::field(key).ok_or_else(|| LauncherError::config(format!("No setting {key}.")))?.get(&current)})),
                        None => Ok(Value::Object(config::fields().iter().map(|f| (f.key.to_string(), f.get(&current))).collect())),
                    }
                }),
            }
        },
        {
            let p = paths.clone();
            Tool {
                name: "launcher_seeds_list".into(),
                description: "The saved seeds: named, complete run configurations.".into(),
                schema: json!({"type": "object", "properties": {}}),
                read_only: true,
                handler: Box::new(move |_| crate::seeds::operate("list", &json!({}), &p)),
            }
        },
        {
            let p = paths.clone();
            Tool {
                name: "launcher_suggest".into(),
                description: "Turn a request in plain words into a line of the launcher's console commands, checked as the command bar checks it, by the launcher's own model. It is only a suggestion: nothing is run.".into(),
                schema: json!({"type": "object", "properties": {"request": {"type": "string", "description": "What is wanted, in plain words"}}, "required": ["request"]}),
                read_only: true,
                handler: Box::new(move |arguments| {
                    let request = arguments.get("request").and_then(|r| r.as_str()).unwrap_or("");
                    let (suggestion, by) = crate::assistant::suggest(&p, request).map_err(LauncherError::config)?;
                    Ok(json!({"line": suggestion.line, "notes": suggestion.warnings, "model": by, "run": false}))
                }),
            }
        },
        {
            let p = paths.clone();
            Tool {
                name: "launcher_apps_list".into(),
                description: "The applications this launcher can start alongside a simulation.".into(),
                schema: json!({"type": "object", "properties": {}}),
                read_only: true,
                handler: Box::new(move |_| Ok(Value::Array(crate::apps::load(&p)?.values().map(|a| a.to_json()).collect()))),
            }
        },
    ];
    if policy.launcher {
        let s = session.clone();
        tools.push(Tool {
            name: "launcher_start".into(),
            description: "Start a simulation, as ./launcher start does, without opening a browser. Builds what changed first, which can take minutes the first time.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "seed": {"type": "string", "description": "Decimal or 0x hexadecimal; leave out for a new one"},
                    "saved_seed": {"type": "string"},
                    "day_type": {"type": "string", "enum": ["weekday", "weekend"]},
                    "speed": {"type": "number", "minimum": 0.01, "maximum": 10},
                    "engine": {"type": "string", "enum": config::ENGINES, "description": "Which engine runs the world; leave out for the launcher's setting"},
                    "osm_file": {"type": "string", "description": "A map file in this checkout, instead of the seed's city"}
                }
            }),
            read_only: false,
            handler: Box::new(move |arguments| {
                let text = |key: &str| arguments.get(key).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string()));
                let options = RunOptions { seed: text("seed"), saved_seed: text("saved_seed"), day_type: text("day_type"), speed: text("speed"), engine: text("engine"), osm_file: text("osm_file"), ..Default::default() };
                let world = s.launch(&options, Arc::new(Quiet), false, Cancel::new())?;
                let port = s.port().unwrap_or(0);
                Ok(json!({"started": true, "port": port, "observer": format!("http://127.0.0.1:{port}/"), "place": world.as_ref().map(|w| w.place()), "seed": world.as_ref().map(|w| w.seed.clone())}))
            }),
        });
        let p = paths.clone();
        tools.push(Tool {
            name: "launcher_stop".into(),
            description: "Stop the running DSTNS server, and the applications this launcher started.".into(),
            schema: json!({"type": "object", "properties": {}}),
            read_only: false,
            handler: Box::new(move |_| {
                let port = crate::server::active_port(&p).ok_or_else(|| LauncherError::generic("No DSTNS server is running."))?;
                Ok(json!({"stopped": crate::server::shut_down(&crate::server::ServerHandle::attached(port), &p)}))
            }),
        });
    }
    if policy.launcher && policy.writes {
        let p = paths.clone();
        tools.push(Tool {
            name: "launcher_config_set".into(),
            description: "Change one of the launcher's settings, as ./launcher config set does. Most apply from the server's next start.".into(),
            schema: json!({"type": "object", "properties": {"key": {"type": "string"}, "value": {"description": "As it would be typed: on, off, a number, a word"}}, "required": ["key", "value"]}),
            read_only: false,
            handler: Box::new(move |arguments| {
                let key = arguments.get("key").and_then(|k| k.as_str()).unwrap_or("");
                let field = config::field(key).ok_or_else(|| LauncherError::config(format!("No setting {key}.")))?;
                let text = arguments.get("value").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default();
                let mut current = config::load(&p)?;
                let value = field.parse(&text).map_err(LauncherError::config)?;
                let problem = config::check_field(field, &value, &current);
                if !problem.is_empty() {
                    return Err(LauncherError::config(problem));
                }
                field.set(&mut current, value.clone());
                config::save(&current, &p)?;
                Ok(json!({key: value}))
            }),
        });
    }
    tools
}

pub struct McpServer {
    pub paths: Paths,
    pub policy: Policy,
    pub session: Arc<Session>,
}

impl McpServer {
    pub fn tools(&self) -> Vec<Tool> {
        let mut tools = launcher_tools(&self.paths, self.policy, self.session.clone());
        tools.extend(graph_tools(&self.paths));
        if crate::assistant::assist_enabled(&self.paths) {
            tools.push(ask_tool(&self.paths));
        }
        tools.push(request_tool(&self.paths, self.policy));
        tools.extend(route_tools(&self.paths, self.policy));
        tools
    }

    /// One JSON-RPC message in, at most one out. Notifications have no answer.
    pub fn handle(&self, message: &Value) -> Option<Value> {
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let reply = |result: Value| Some(json!({"jsonrpc": "2.0", "id": id, "result": result}));
        let error = |code: i64, text: &str| Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": text}}));
        if id.is_none() {
            // A notification, such as notifications/initialized: nothing to say.
            return None;
        }
        match method {
            "initialize" => {
                let asked = message.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL_VERSIONS[0]);
                let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(PROTOCOL_VERSIONS[0]);
                reply(json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "dstns", "title": "DSTNS", "version": crate::version::engine_version()},
                    "instructions": format!(
                        "DSTNS simulates a day of traffic in a real city district. The route tools call its HTTP API; launcher_status says whether a server is running. {}{}",
                        if self.policy.writes { "Changes are allowed. " } else { "Only reading is allowed: the operator has not allowed changes. " },
                        if self.policy.launcher { "Starting and stopping simulations is allowed." } else { "Starting and stopping simulations is not allowed." }
                    ),
                }))
            }
            "ping" => reply(json!({})),
            "tools/list" => reply(json!({"tools": self.tools().iter().map(Tool::spec).collect::<Vec<_>>()})),
            "tools/call" => {
                let name = message.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("");
                let arguments = message.pointer("/params/arguments").cloned().unwrap_or(json!({}));
                let tools = self.tools();
                let Some(tool) = tools.iter().find(|t| t.name == name) else { return error(-32602, &format!("Unknown tool: {name}")) };
                crate::log::info(&format!("mcp: {name} {arguments}"));
                match (tool.handler)(&arguments) {
                    Ok(result) => reply(json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&result).unwrap()}], "structuredContent": result, "isError": false})),
                    Err(problem) => {
                        crate::log::warn(&format!("mcp: {name} refused: {}", problem.message));
                        let text = if problem.remedy.is_empty() { problem.message } else { format!("{} {}", problem.message, problem.remedy) };
                        reply(json!({"content": [{"type": "text", "text": text}], "isError": true}))
                    }
                }
            }
            "resources/list" => reply(json!({"resources": []})),
            "prompts/list" => reply(json!({"prompts": []})),
            _ => error(-32601, &format!("Method not found: {method}")),
        }
    }
}

fn serve(handler: McpServer) -> Result<i32> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    crate::log::info("mcp: serving on standard input and output");
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Err(_) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "Parse error"}})),
            Ok(Value::Array(batch)) => {
                let answers: Vec<Value> = batch.iter().filter_map(|m| handler.handle(m)).collect();
                (!answers.is_empty()).then_some(Value::Array(answers))
            }
            Ok(message) => handler.handle(&message),
        };
        if let Some(answer) = answer {
            writeln!(stdout, "{answer}")?;
            stdout.flush()?;
        }
    }
    Ok(EXIT_OK)
}

fn run(context: &Context) -> Result<i32> {
    let options = Options::parse(&context.args.rest, &[], &["--help", "-h"])?;
    if options.has("--help") || options.has("-h") {
        print!("{USAGE}");
        return Ok(EXIT_OK);
    }
    let settings = config::load(&context.paths)?;
    let policy = Policy::from_config(&settings);
    let handler = McpServer { paths: context.paths.clone(), policy, session: context.session.clone() };
    match options.positional.first().map(String::as_str).unwrap_or("tools") {
        "serve" => {
            if !policy.enabled {
                return Err(LauncherError::config("The MCP Handler is turned off.").remedy("Turn it on with ./launcher config set mcp.enabled on, or under MCP in ./launcher config."));
            }
            serve(handler)
        }
        "tools" => {
            let out = &context.out;
            out.heading(&format!(
                "MCP Handler: {}{}{}",
                if policy.enabled { "on" } else { "off" },
                if policy.writes { ", changes allowed" } else { ", reading only" },
                if policy.launcher { ", launcher actions allowed" } else { "" }
            ));
            let rows: Vec<Vec<String>> = handler.tools().iter().map(|t| vec![t.name.clone(), if t.read_only { "reads" } else { "changes" }.into(), t.description.clone()]).collect();
            out.table(&["Tool", "Kind", "What it does"], &rows, 70);
            if crate::server::active_port(&context.paths).is_none() {
                out.muted("No server is running, so the routes' own tools aren't listed: they come from its endpoint index.");
            }
            Ok(EXIT_OK)
        }
        "client-config" => {
            let launcher = context.paths.root.join("launcher");
            println!("{}", serde_json::to_string_pretty(&json!({"mcpServers": {"dstns": {"command": launcher.to_string_lossy(), "args": ["mcp", "serve"]}}})).unwrap());
            Ok(EXIT_OK)
        }
        other => Err(LauncherError::config(format!("Unknown action {other}.")).remedy("./launcher mcp --help lists them.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handler(policy: Policy) -> McpServer {
        let dir = std::env::temp_dir().join(format!("dstns-mcp-{}", std::process::id()));
        let paths = Paths::new(&dir);
        McpServer { session: Session::new(paths.clone()), paths, policy }
    }

    #[test]
    fn routes_become_tool_names() {
        assert_eq!(tool_name("GET", "/api/v1/view/snapshot"), "get_view_snapshot");
        assert_eq!(tool_name("PUT", "/api/v1/fabric/apps/{id}/storage/{key}"), "put_fabric_apps_id_storage_key");
        assert_eq!(tool_name("GET", "/health"), "get_health");
    }

    #[test]
    fn alternatives_become_one_route_each() {
        let index = json!({"groups": [{"endpoints": [{"method": "POST", "path": "/api/v1/fabric/engine/{play|pause}", "description": "d"}]}]});
        let found: Vec<String> = routes(&index).into_iter().map(|(_, p, _)| p).collect();
        assert_eq!(found, vec!["/api/v1/fabric/engine/play", "/api/v1/fabric/engine/pause"]);
    }

    #[test]
    fn parameters_are_filled_in_and_cannot_escape() {
        assert_eq!(address("/api/v1/fabric/apps/{id}", &json!({"id": "org.x", "query": {"limit": "5"}})).unwrap(), "/api/v1/fabric/apps/org.x?limit=5");
        assert!(address("/api/v1/fabric/apps/{id}", &json!({"id": "../system/terminate"})).is_err());
        assert!(address("/api/v1/fabric/apps/{id}", &json!({})).is_err());
    }

    #[test]
    fn it_speaks_the_protocol() {
        let h = handler(Policy { enabled: true, ..Default::default() });
        let init = h.handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})).unwrap();
        assert_eq!(init["result"]["protocolVersion"], json!("2025-03-26"));
        assert_eq!(init["result"]["serverInfo"]["name"], json!("dstns"));
        assert!(h.handle(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).is_none());
        let listed = h.handle(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).unwrap();
        let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"dstns_request") && names.contains(&"launcher_status"));
        assert!(!names.contains(&"launcher_start"), "starting needs the operator's leave");
        let unknown = h.handle(&json!({"jsonrpc": "2.0", "id": 3, "method": "nothing"})).unwrap();
        assert_eq!(unknown["error"]["code"], json!(-32601));
    }

    #[test]
    fn advanced_security_leaves_only_the_applications_to_change() {
        let settings = json!({"mcp": {"enabled": true, "allow_writes": true, "allow_launcher": true}, "security": {"advanced": true}});
        let policy = Policy::from_config(&settings);
        assert!(policy.guarded && !policy.launcher, "the launcher's tools are withdrawn");
        assert!(policy.may_change("/api/v1/fabric/apps/org.x/ui/panel"));
        assert!(!policy.may_change("/api/v1/system/terminate") && !policy.may_change("/api/v1/playback/start"), "the engine is not changed from here");
        let h = handler(policy);
        let names: Vec<String> = h.handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).unwrap()["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str().map(String::from)).collect();
        assert!(!names.iter().any(|n| n == "launcher_start" || n == "launcher_stop" || n == "launcher_config_set"));
        let call = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "dstns_request", "arguments": {"method": "POST", "path": "/api/v1/system/terminate"}}});
        assert!(h.handle(&call).unwrap()["result"]["content"][0]["text"].as_str().unwrap().contains("Advanced Security"));
    }

    #[test]
    fn changes_are_refused_unless_allowed() {
        let h = handler(Policy { enabled: true, ..Default::default() });
        let call = json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "dstns_request", "arguments": {"method": "POST", "path": "/api/v1/system/terminate"}}});
        let refused = h.handle(&call).unwrap();
        assert_eq!(refused["result"]["isError"], json!(true));
        assert!(refused["result"]["content"][0]["text"].as_str().unwrap().contains("not allowed"));
    }

    #[test]
    fn the_graph_answers_from_the_checkout() {
        let paths = Paths::default();
        if !paths.root.join(crate::graph::FILE).is_file() {
            return;
        }
        let tools = graph_tools(&paths);
        assert_eq!(tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["graph_ask", "graph_show", "graph_relations", "graph_path"]);
        assert!(tools.iter().all(|t| t.read_only), "the graph only reads");
        let found = (tools[0].handler)(&json!({"question": "who calls physics_step"})).unwrap();
        assert!(found["found"].as_array().unwrap().iter().any(|n| n["name"] == "SimulationEngine::step_to()"), "{found}");
        assert!(found["found"][0]["url"].as_str().unwrap().contains("#L"));
    }
}
