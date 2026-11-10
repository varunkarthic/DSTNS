// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

//! The Markdown a model writes, for a terminal: the few things answers use (paragraphs, headings, lists, quotes, fenced
//! code, **bold**, `code` and [links](url)), as lines and styled pieces. Anything else is shown as it was written.

/// What a line of an answer is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Text,
    Heading,
    /// A list item; its text starts with the marker, "• " or "1. ".
    Item,
    Code,
    Quote,
    Blank,
}

/// The answer as lines, each with what it is. Code keeps its spacing; everything else is trimmed.
pub fn lines(text: &str, unicode: bool) -> Vec<(Kind, String)> {
    let mut out = Vec::new();
    let mut fenced = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            out.push((Kind::Code, line.to_string()));
            continue;
        }
        let trimmed = line.trim_start();
        let indent = " ".repeat(((line.len() - trimmed.len()) / 2).min(4) * 2);
        if trimmed.is_empty() {
            // Never two blank lines in a row.
            if !matches!(out.last(), Some((Kind::Blank, _)) | None) {
                out.push((Kind::Blank, String::new()));
            }
        } else if let Some(h) = trimmed.strip_prefix("### ").or_else(|| trimmed.strip_prefix("## ")).or_else(|| trimmed.strip_prefix("# ")) {
            out.push((Kind::Heading, h.trim().to_string()));
        } else if let Some(item) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")).or_else(|| trimmed.strip_prefix("+ ")) {
            out.push((Kind::Item, format!("{indent}{}{}", if unicode { "• " } else { "- " }, item.trim())));
        } else if trimmed.split_once(". ").map(|(n, _)| !n.is_empty() && n.len() <= 3 && n.chars().all(|c| c.is_ascii_digit())).unwrap_or(false) {
            out.push((Kind::Item, format!("{indent}{trimmed}")));
        } else if let Some(quote) = trimmed.strip_prefix('>') {
            out.push((Kind::Quote, quote.trim().to_string()));
        } else if trimmed.chars().all(|c| c == '-' || c == '*' || c == '_') && trimmed.len() >= 3 {
            out.push((Kind::Blank, String::new()));
        } else {
            out.push((Kind::Text, trimmed.to_string()));
        }
    }
    while matches!(out.last(), Some((Kind::Blank, _))) {
        out.pop();
    }
    out
}

/// How a piece of a line is shown.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Style {
    pub bold: bool,
    pub code: bool,
    pub link: bool,
}

/// Inline styles carried from one wrapped piece of a line to the next.
#[derive(Clone, Copy, Debug, Default)]
pub struct Open {
    bold: bool,
    code: bool,
}

/// A line (or a wrapped piece of one) as styled pieces. **bold**, `code` and [text](url) lose their marks; a link
/// keeps its text and, after it, its address in brackets, since a terminal may not open it. `open` carries a style
/// begun on an earlier piece of the same line.
pub fn pieces(text: &str, open: &mut Open) -> Vec<(Style, String)> {
    let mut out: Vec<(Style, String)> = Vec::new();
    let mut current = String::new();
    let push = |out: &mut Vec<(Style, String)>, current: &mut String, style: Style| {
        if !current.is_empty() {
            out.push((style, std::mem::take(current)));
        }
    };
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let style = Style { bold: open.bold, code: open.code, link: false };
        let c = chars[i];
        if c == '`' {
            push(&mut out, &mut current, style);
            open.code = !open.code;
            i += 1;
        } else if !open.code && c == '*' && chars.get(i + 1) == Some(&'*') {
            push(&mut out, &mut current, style);
            open.bold = !open.bold;
            i += 2;
        } else if !open.code && c == '[' {
            // [text](address)
            let rest: String = chars[i + 1..].iter().collect();
            match rest.find("](").and_then(|mid| rest[mid + 2..].find(')').map(|end| (mid, mid + 2 + end))) {
                Some((mid, end)) if !rest[..mid].contains('[') => {
                    push(&mut out, &mut current, style);
                    let (label, address) = (&rest[..mid], &rest[mid + 2..end]);
                    out.push((Style { link: true, ..style }, label.to_string()));
                    if address != label && !address.is_empty() {
                        out.push((Style { link: false, ..style }, format!(" ({address})")));
                    }
                    i += 1 + rest[..end + 1].chars().count();
                }
                _ => {
                    current.push(c);
                    i += 1;
                }
            }
        } else {
            current.push(c);
            i += 1;
        }
    }
    push(&mut out, &mut current, Style { bold: open.bold, code: open.code, link: false });
    out
}

/// The answer for a plain terminal: wrapped to `width`, with ANSI styles when `color`.
pub fn terminal(text: &str, width: usize, color: bool, unicode: bool) -> Vec<String> {
    let width = width.max(30);
    let style = |s: Style, text: &str| -> String {
        if !color {
            return text.to_string();
        }
        match (s.bold, s.code, s.link) {
            (_, true, _) => format!("\x1b[36m{text}\x1b[0m"),
            (_, _, true) => format!("\x1b[4;34m{text}\x1b[0m"),
            (true, _, _) => format!("\x1b[1m{text}\x1b[0m"),
            _ => text.to_string(),
        }
    };
    let mut out = Vec::new();
    for (kind, line) in lines(text, unicode) {
        match kind {
            Kind::Blank => out.push(String::new()),
            Kind::Code => out.push(if color { format!("    \x1b[36m{line}\x1b[0m") } else { format!("    {line}") }),
            Kind::Heading => out.push(if color { format!("\x1b[1m{line}\x1b[0m") } else { line.to_uppercase() }),
            _ => {
                // A nested item keeps its indent, which wrapping would take off.
                let content = line.trim_start();
                let indent = " ".repeat(line.chars().count() - content.chars().count());
                let lead = if kind == Kind::Quote { if unicode { "│ " } else { "| " } } else { "" };
                // A list item's wrapped lines line up under its words, not its marker (counted in characters: "•" is
                // one on screen though three bytes).
                let marker = if kind == Kind::Item { content.chars().take_while(|c| !(c.is_alphanumeric() || *c == '`' || *c == '*')).count().min(6) } else { 0 };
                let hang = indent.chars().count() + marker + lead.chars().count();
                let mut open = Open::default();
                for (n, piece) in crate::tui::widgets::wrap(content, width.saturating_sub(hang).max(20)).into_iter().enumerate() {
                    let rendered: String = pieces(&piece, &mut open).iter().map(|(s, t)| style(*s, t)).collect();
                    let prefix = if n == 0 { format!("{indent}{lead}") } else { " ".repeat(hang) };
                    out.push(format!("{prefix}{rendered}"));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_are_told_apart() {
        let text = "## Ports\n\nThe server uses **8090**.\n\n\n- one\n  * nested\n2. two\n> careful\n```bash\n./launcher  start\n```\n---\n";
        let found = lines(text, true);
        assert_eq!(
            found,
            vec![
                (Kind::Heading, "Ports".into()),
                (Kind::Blank, "".into()),
                (Kind::Text, "The server uses **8090**.".into()),
                (Kind::Blank, "".into()),
                (Kind::Item, "• one".into()),
                (Kind::Item, "  • nested".into()),
                (Kind::Item, "2. two".into()),
                (Kind::Quote, "careful".into()),
                (Kind::Code, "./launcher  start".into()),
            ]
        );
    }

    #[test]
    fn inline_marks_become_styles() {
        let mut open = Open::default();
        let got = pieces("Set **api.port** with `set api.port 9000`, see [Ports](https://x.test/p) or [1].", &mut open);
        let bold = Style { bold: true, ..Default::default() };
        let code = Style { code: true, ..Default::default() };
        let link = Style { link: true, ..Default::default() };
        assert_eq!(got[1], (bold, "api.port".into()));
        assert_eq!(got[3], (code, "set api.port 9000".into()));
        assert_eq!(got[5], (link, "Ports".into()));
        assert_eq!(got[6].1, " (https://x.test/p)");
        assert!(got.last().unwrap().1.ends_with("or [1]."));
    }

    #[test]
    fn a_style_carries_across_a_wrapped_line() {
        let mut open = Open::default();
        let first = pieces("start **of a bold", &mut open);
        let second = pieces("phrase** ends", &mut open);
        assert!(first.last().unwrap().0.bold);
        assert!(second[0].0.bold && !second[1].0.bold);
    }

    #[test]
    fn a_plain_terminal_gets_plain_wrapped_text() {
        let text = "# Answer\n- a long list item that has to wrap because the terminal is narrow here\n```\nkeep   spacing\n```";
        let out = terminal(text, 40, false, false);
        assert_eq!(out[0], "ANSWER");
        assert!(out[1].starts_with("- a long"));
        assert!(out[2].starts_with("  ") && !out[2].starts_with("   "), "{out:?}");
        let nested = terminal("- top\n  - inner item that is long enough to wrap onto a second line here", 40, false, true);
        assert!(nested[1].starts_with("  • inner"), "{nested:?}");
        assert!(nested[2].starts_with("    ") && !nested[2].starts_with("     "), "{nested:?}");
        assert_eq!(out.last().unwrap(), "    keep   spacing");
        assert!(out.iter().all(|l| !l.contains('\x1b')));
        assert!(terminal("**x**", 40, true, true)[0].contains("\x1b[1m"));
    }
}
