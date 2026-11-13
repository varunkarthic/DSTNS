// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! One launcher session: the server it uses and the run it started. Every interface drives a session the same way,
//! so starting, observing and stopping behave identically whichever one is on screen.

use crate::apps;
use crate::config::{self, RunOptions};
use crate::errors::{LauncherError, Result};
use crate::narration;
use crate::paths::{local_cache_dir, Paths};
use crate::process::Cancel;
use crate::reporting::{Level, Reporter};
use crate::server::{self, ServerHandle};
use crate::simulation::{self, World};
use crate::supervisor::Supervisor;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// How long the observer has the screen before the engine is asked for a world.
pub const OBSERVER_LEAD_S: f64 = 3.5;

pub struct Session {
    pub paths: Paths,
    pub handle: Mutex<Option<Arc<ServerHandle>>>,
    pub supervisor: Mutex<Option<Arc<Supervisor>>>,
    pub world: Mutex<Option<World>>,
    cancel: Mutex<Cancel>,
    closed: AtomicBool,
    pub launching: AtomicBool,
}

impl Session {
    pub fn new(paths: Paths) -> Arc<Self> {
        Arc::new(Self {
            paths,
            handle: Mutex::default(),
            supervisor: Mutex::default(),
            world: Mutex::default(),
            cancel: Mutex::new(Cancel::new()),
            closed: AtomicBool::new(false),
            launching: AtomicBool::new(false),
        })
    }

    pub fn handle(&self) -> Option<Arc<ServerHandle>> {
        self.handle.lock().unwrap().clone()
    }

    /// The port of this session's server, while it is running.
    pub fn port(&self) -> Option<u16> {
        self.handle().filter(|h| h.running(&self.paths)).map(|h| h.port)
    }

    /// This session's server, else any current server this launcher can reach.
    pub fn any_port(&self) -> Option<u16> {
        self.port().or_else(|| server::active_port(&self.paths))
    }

    pub fn supervisor(&self) -> Option<Arc<Supervisor>> {
        self.supervisor.lock().unwrap().clone()
    }

    /// What looks after this session's applications.
    pub fn supervise(&self, port: u16, reporter: Arc<dyn Reporter>, cancel: Cancel) -> Arc<Supervisor> {
        let mut current = self.supervisor.lock().unwrap();
        match current.as_ref() {
            Some(existing) if existing.port == port => {
                existing.set_reporter(reporter);
                existing.clone()
            }
            _ => {
                let fresh = Supervisor::new(port, reporter, &self.paths, cancel);
                *current = Some(fresh.clone());
                fresh
            }
        }
    }

    /// Start (or reuse) a server and start a run, or observe the run already there. Returns the world, or None when an
    /// existing run is being observed.
    pub fn launch(&self, options: &RunOptions, reporter: Arc<dyn Reporter>, open_browser: bool, cancel: Cancel) -> Result<Option<World>> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(LauncherError::cancelled());
        }
        *self.cancel.lock().unwrap() = cancel.clone();
        self.launching.store(true, Ordering::SeqCst);
        let outcome = self.launch_inner(options, reporter, open_browser, &cancel);
        self.launching.store(false, Ordering::SeqCst);
        outcome
    }

    fn launch_inner(&self, options: &RunOptions, reporter: Arc<dyn Reporter>, open_browser: bool, cancel: &Cancel) -> Result<Option<World>> {
        cancel.check()?;
        let request = simulation::prepare_request(options, &self.paths)?;
        simulation::ACCEPT_RISK.store(options.accept_risk, std::sync::atomic::Ordering::Relaxed);
        let handle = Arc::new(server::start(reporter.as_ref(), &self.paths, true, Some(cancel), false)?);
        // config/engines.json shows what each engine is, as this build says.
        crate::config::sync_engine_identities(handle.port, &self.paths);
        {
            let mut current = self.handle.lock().unwrap();
            // Re-attaching to the server this session started must not forget that the session owns it.
            let ours = current.as_ref().map(|h| h.managed() && h.port == handle.port).unwrap_or(false);
            if !(ours && !handle.managed()) {
                *current = Some(handle.clone());
            }
        }
        if cancel.is_set() {
            server::stop_handle(&handle);
            cancel.check()?;
        }
        let lifecycle = handle.health.get("lifecycle").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let observing = (lifecycle == "RUNNING" || lifecycle == "PAUSED") && !options.explicit();
        let address = self.observer_address(&handle.url(), options);
        let mut loaded = false;
        if open_browser && !observing {
            self.open_observer(&address, false);
            loaded = simulation::wait_for_observer(handle.port, 12.0, &self.paths, Some(cancel))?;
            reporter.message(Level::Info, if loaded { "Observer open" } else { "Observer opening" }, &format!("{} · preparing the world", handle.url()));
            // Intentional: the observer opens on its title and starts its film before any world is requested, so
            // the whole start-up is seen from the beginning.
            if loaded && cancel.wait(OBSERVER_LEAD_S) {
                cancel.check()?;
            }
        }
        cancel.check()?;
        // Then the applications. The engine is built and running and the observer is open, and the simulation does
        // not start until they are all ready.
        let chosen = apps::selection(options, &self.paths)?;
        if !chosen.is_empty() {
            reporter.message(Level::Info, "Starting applications", &chosen.iter().map(|a| a.title()).collect::<Vec<_>>().join(", "));
            self.supervise(handle.port, reporter.clone(), cancel.clone()).launch(&chosen)?;
        }
        cancel.check()?;
        let world = if observing {
            let source = simulation::network(handle.port, &self.paths).ok().and_then(|(_, n)| n.get("source").and_then(|s| s.as_str()).map(String::from));
            if source.as_deref() != Some("OpenStreetMap") {
                return Err(LauncherError::start("The active server is running a synthetic fixture. Stop that run before launching an OSM simulation."));
            }
            reporter.message(Level::Info, "Observing the existing real OSM simulation", "");
            None
        } else {
            let world = simulation::start_run(handle.port, &request, reporter.as_ref(), &self.paths, Some(cancel), loaded)?;
            if handle.managed() {
                narration::confirm(handle.port, reporter.as_ref(), &self.paths, Some(cancel));
            }
            Some(world)
        };
        *self.world.lock().unwrap() = world.clone();
        reporter.message(Level::Info, "Observer ready", &handle.url());
        if open_browser && observing {
            self.open_observer(&address, false);
        }
        Ok(world)
    }

    /// In a window of its own when it should be full screen or play music; otherwise as usual.
    pub fn open_observer(&self, address: &str, demo: bool) -> bool {
        let config = config::load(&self.paths).unwrap_or(Value::Null);
        let shown = config::presentation(&config, demo);
        simulation::open_presentation(
            address,
            shown["fullscreen"].as_bool().unwrap_or(false),
            shown["music"].as_bool().unwrap_or(false),
            &local_cache_dir().join("browser"),
        )
    }

    /// The page to open: asked to forget this browser's settings, if so configured.
    fn observer_address(&self, url: &str, options: &RunOptions) -> String {
        let wanted = options.default_settings || config::load(&self.paths).map(|c| config::flag(&c, "launcher.default_settings")).unwrap_or(false);
        if wanted {
            format!("{url}?defaults")
        } else {
            url.to_string()
        }
    }

    /// Terminate the server gracefully. Returns whether it has stopped.
    pub fn stop_server(&self) -> bool {
        if let Some(supervisor) = self.supervisor() {
            supervisor.stop_all();
        }
        let Some(handle) = self.handle() else { return true };
        let stopped = server::shut_down(&handle, &self.paths);
        crate::log::info(&format!("server on port {} stopped: {stopped}", handle.port));
        stopped
    }

    /// Stop a server this session started; leave one it attached to running.
    pub fn cleanup(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.cancel.lock().unwrap().set();
        // Applications this session started go with it, whichever server they were talking to.
        if let Some(supervisor) = self.supervisor() {
            supervisor.stop_all();
        }
        if let Some(handle) = self.handle() {
            if handle.managed() && handle.exit_code().is_none() {
                crate::log::info(&format!("cleanup: stopping managed server on port {}", handle.port));
                server::stop_handle(&handle);
            }
        }
        // Give a build or pending start a moment to notice, so no worker spawns a server after the launcher exits.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while self.launching.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}
