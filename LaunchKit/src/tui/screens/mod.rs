// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The launcher's screens.

pub mod about;
pub mod apps;
pub mod completion;
pub mod configuration;
pub mod dashboard;
pub mod diagnostics;
pub mod environment;
pub mod logs;
pub mod places;
pub mod running;
pub mod seeds;
pub mod setup;
pub mod simple;
pub mod splash;
pub mod start;
pub mod tasks;

use super::{Action, Screen, Ui};

/// A page by the name the command bar and `cd` use. `section` opens it somewhere particular, such as a category.
pub fn open(page: &str, section: &str, ui: &Ui) -> Option<Box<dyn Screen>> {
    Some(match page {
        "start" => Box::new(start::StartScreen::new(ui)),
        "running" => Box::new(running::RunningScreen::new(None)),
        "apps" | "applications" => Box::new(apps::AppsScreen::new()),
        "seeds" => Box::new(seeds::SeedsScreen::new(ui)),
        "config" | "configuration" | "settings" => Box::new(configuration::ConfigurationScreen::new(if section.is_empty() { None } else { Some(section.to_string()) })),
        "demo" | "presentation" | "fastboot" => Box::new(tasks::TaskScreen::presentation()),
        "diagnostics" => Box::new(diagnostics::DiagnosticsScreen::new(ui)),
        "logs" => Box::new(logs::LogsScreen::new(ui)),
        "tests" => Box::new(tasks::TaskScreen::tests()),
        "tools" => Box::new(tasks::TaskScreen::tools()),
        "cities" => Box::new(places::PlacesScreen::cities()),
        "countries" | "places" => Box::new(places::PlacesScreen::countries()),
        "about" => Box::new(about::AboutScreen),
        "setup" => Box::new(setup::SetupScreen::new(ui)),
        _ => return None,
    })
}

/// Once the environment check passes: the dashboard, then the requested page; and the setup first, on a first launch.
pub fn after_environment(initial: &str, ui: &mut Ui) -> Action {
    let mut actions = vec![Action::Replace(Box::new(dashboard::DashboardScreen::new()))];
    if crate::setup::first_launch() || initial == "setup" {
        let mut wizard = setup::SetupScreen::new(ui);
        wizard.then = Some(initial.to_string());
        actions.push(Action::Push(Box::new(wizard)));
        return Action::Many(actions);
    }
    actions.push(initial_page(initial, ui));
    Action::Many(actions)
}

pub fn initial_page(initial: &str, ui: &Ui) -> Action {
    match initial {
        "start" => Action::Push(Box::new(running::RunningScreen::new(Some(ui.args.run.clone())))),
        // Demo Mode, running, on its page.
        "demo" => Action::Push(Box::new(tasks::TaskScreen::presentation().begun("demo", ui))),
        "home" | "dashboard" => Action::None,
        page => open(page, "", ui).map(Action::Push).unwrap_or(Action::None),
    }
}
