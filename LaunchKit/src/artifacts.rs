// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! Content fingerprints: rebuild an output only when its sources changed. The fingerprint hashes each file's relative
//! path and bytes, in sorted order, so it matches the one the launcher has always written to `.launcher-source`.

use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

pub fn source_fingerprint(root: &Path, inputs: &[&str]) -> String {
    fn add(digest: &mut Sha256, root: &Path, relative: &str) {
        let full = root.join(relative);
        if full.is_dir() {
            let mut names: Vec<String> = fs::read_dir(&full)
                .map(|entries| entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
                .unwrap_or_default();
            names.sort();
            for name in names {
                add(digest, root, &format!("{relative}/{name}"));
            }
        } else if full.is_file() {
            digest.update(relative.as_bytes());
            digest.update([0u8]);
            if let Ok(bytes) = fs::read(&full) {
                digest.update(bytes);
            }
        }
    }
    let mut digest = Sha256::new();
    for input in inputs {
        add(&mut digest, root, input);
    }
    crate::paths::hex(&digest.finalize())
}

pub struct BuildState {
    pub fingerprint: String,
    pub needed: bool,
}

pub fn needs_build(root: &Path, inputs: &[&str], output: &Path, stamp: &Path) -> BuildState {
    let fingerprint = source_fingerprint(root, inputs);
    let previous = fs::read_to_string(stamp).ok();
    let needed = !output.exists() || previous.as_deref() != Some(fingerprint.as_str());
    BuildState { fingerprint, needed }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_to_any_input_changes_the_fingerprint() {
        let dir = std::env::temp_dir().join(format!("dstns-fp-{}", std::process::id()));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/a.txt"), "one").unwrap();
        let first = source_fingerprint(&dir, &["src"]);
        assert_eq!(first, source_fingerprint(&dir, &["src"]));
        fs::write(dir.join("src/a.txt"), "two").unwrap();
        assert_ne!(first, source_fingerprint(&dir, &["src"]));
        // The same layout as the launcher has always hashed: path, a zero byte, the bytes.
        let mut digest = Sha256::new();
        digest.update(b"src/a.txt\0two");
        assert_eq!(source_fingerprint(&dir, &["src"]), crate::paths::hex(&digest.finalize()));
        fs::remove_dir_all(dir).ok();
    }
}
