// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The DSTNS launcher: it checks this machine, builds what changed, and runs the simulator, in a terminal interface
//! or with a single command. `./launcher help` lists what it does.

mod api;
mod apps;
mod artifacts;
mod assistant;
mod buildplan;
mod cli;
mod config;
mod console;
mod daemons;
mod environment;
mod errors;
mod fabric;
mod graph;
mod inspect;
mod interface;
mod log;

mod logs;
mod maintenance;
mod markdown;
mod modules;
mod narration;
mod output;
mod paths;
mod process;
mod reporting;
mod security;
mod seeds;
mod server;
mod session;
mod setup;
mod signals;
mod state;
mod simulation;
mod sumo;
mod supervisor;
mod terminal;
mod testing;
mod tui;
mod version;

fn main() {
    let code = cli::run(std::env::args().skip(1).collect());
    std::process::exit(code);
}
