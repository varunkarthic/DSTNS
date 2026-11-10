// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! API keys: from the environment by default (which includes config/launcher.env, loaded by the launcher), or from the
//! system's credential store when the settings say so. A key is only ever handed to its own provider; nothing here
//! prints or logs one.

use crate::providers::Provider;
use crate::{KeyStore, Settings};
use std::io::Write;
use std::process::{Command, Stdio};

const KEYCHAIN_SWIFT: &str = include_str!("../assets/keychain.swift");

/// The provider's key: the system store first when it is chosen, then each of its environment variables in turn.
pub fn find(provider: &Provider, settings: &Settings) -> Option<String> {
    let stored = if settings.key_store == KeyStore::System { system_get(provider.id, settings).ok().flatten() } else { None };
    stored.or_else(|| provider.key_names.iter().filter_map(|name| std::env::var(name).ok()).map(|k| k.trim().to_string()).find(|k| !k.is_empty()))
}

/// Where the key would come from, without reading the store's secret: for status screens.
pub fn source(provider: &Provider, settings: &Settings) -> Option<String> {
    if settings.key_store == KeyStore::System && system_get(provider.id, settings).ok().flatten().is_some() {
        return Some(format!("the {}", system_store_name()));
    }
    provider.key_names.iter().find(|name| std::env::var(name).map(|v| !v.trim().is_empty()).unwrap_or(false)).map(|name| name.to_string())
}

pub fn system_store_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS Keychain"
    } else if cfg!(windows) {
        "Windows Credential Manager"
    } else {
        "Secret Service keyring"
    }
}

fn run(mut command: Command, input: Option<&str>) -> Result<(i32, String), String> {
    command.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().map_err(|e| format!("the {} could not be reached: {e}", system_store_name()))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((output.status.code().unwrap_or(2), String::from_utf8_lossy(&output.stdout).trim().to_string()))
}

/// PowerShell for Windows' PasswordVault. The account and secret arrive on standard input, never in the command line.
const WINDOWS: &str = "$ErrorActionPreference='Stop'; $lines=@($input); $op=$lines[0]; $account=$lines[1]; \
    [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; \
    $vault=New-Object Windows.Security.Credentials.PasswordVault; $resource='DSTNS AI provider key'; \
    try { $found=$vault.Retrieve($resource,$account) } catch { $found=$null }; \
    if ($op -eq 'get') { if ($found) { $found.RetrievePassword(); [Console]::Out.Write($found.Password); exit 0 } else { exit 1 } } \
    if ($op -eq 'delete') { if ($found) { $vault.Remove($found); exit 0 } else { exit 1 } } \
    if ($found) { $vault.Remove($found) }; $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($resource,$account,$lines[2]))); exit 0";

fn store(op: &str, account: &str, secret: Option<&str>, settings: &Settings) -> Result<(i32, String), String> {
    if cfg!(target_os = "macos") {
        let helper = crate::apple::swift_program(&settings.cache_dir, "dstns-keychain", KEYCHAIN_SWIFT, &[]).ok_or("the Keychain helper could not be built: the Swift compiler is missing (xcode-select --install)")?;
        let mut command = Command::new(helper);
        command.args([op, account]);
        run(command, secret)
    } else if cfg!(windows) {
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-NonInteractive", "-Command", WINDOWS]);
        run(command, Some(&format!("{op}\n{account}\n{}\n", secret.unwrap_or(""))))
    } else {
        let mut command = Command::new("secret-tool");
        match op {
            "get" => command.args(["lookup", "service", "dstns-ai", "account", account]),
            "set" => command.args(["store", "--label", &format!("DSTNS: {account} API key"), "service", "dstns-ai", "account", account]),
            _ => command.args(["clear", "service", "dstns-ai", "account", account]),
        };
        run(command, secret)
    }
}

/// The key kept in the system store for `account` (a provider's id), None if none is.
pub fn system_get(account: &str, settings: &Settings) -> Result<Option<String>, String> {
    match store("get", account, None, settings)? {
        (0, key) if !key.is_empty() => Ok(Some(key)),
        (0 | 1, _) => Ok(None),
        _ => Err(format!("the {} refused to say", system_store_name())),
    }
}

pub fn system_set(account: &str, key: &str, settings: &Settings) -> Result<(), String> {
    match store("set", account, Some(key.trim()), settings)? {
        (0, _) => Ok(()),
        _ => Err(format!("the {} did not keep it", system_store_name())),
    }
}

pub fn system_delete(account: &str, settings: &Settings) -> Result<(), String> {
    match store("delete", account, None, settings)? {
        (0 | 1, _) => Ok(()),
        _ => Err(format!("the {} did not forget it", system_store_name())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers;

    #[test]
    fn the_environment_is_read_in_order_and_blank_keys_are_skipped() {
        let hf = providers::find("huggingface").unwrap();
        let settings = Settings::default();
        for name in hf.key_names {
            std::env::remove_var(name);
        }
        assert_eq!(find(hf, &settings), None);
        std::env::set_var("HF_TOKEN", "  ");
        std::env::set_var("HUGGINGFACE_API_KEY", "from-the-third");
        assert_eq!(find(hf, &settings).as_deref(), Some("from-the-third"));
        std::env::set_var("DSTNS_HF_TOKEN", "dstns-own");
        assert_eq!(find(hf, &settings).as_deref(), Some("dstns-own"));
        assert_eq!(source(hf, &settings).as_deref(), Some("DSTNS_HF_TOKEN"));
        for name in hf.key_names {
            std::env::remove_var(name);
        }
    }

    #[test]
    #[ignore = "writes to this Mac's login Keychain"]
    fn the_keychain_keeps_and_forgets_a_key() {
        let settings = Settings { cache_dir: std::env::temp_dir().join("dstns-keychain-test"), key_store: KeyStore::System, ..Default::default() };
        let account = format!("test-{}", std::process::id());
        system_set(&account, "kept-in-the-keychain", &settings).unwrap();
        assert_eq!(system_get(&account, &settings).unwrap().as_deref(), Some("kept-in-the-keychain"));
        system_delete(&account, &settings).unwrap();
        assert_eq!(system_get(&account, &settings).unwrap(), None);
    }
}
