//! A list you can walk with the arrow keys, for lists too long to number.
//!
//! The numbered menu this replaces was fine at a dozen rows and useless past
//! them: the list scrolls off the top of the terminal, and the only way to
//! reach row 80 is to already know it is 80. Typing a number also means reading
//! every row to find the one you want, every time.
//!
//! So: arrows to move, type to filter, Enter to take it. The filter is the part
//! that actually scales — with a hundred providers, "open" narrowing to two
//! rows beats any amount of scrolling.
//!
//! Falls back to the numbered prompt when stdin is not a terminal, or when raw
//! mode cannot be entered. A pipeline that already parses this output keeps
//! working, and a terminal that refuses raw mode gets a list rather than an
//! error.

use std::io::{IsTerminal, Write};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use crossterm::{cursor, execute, queue, style::Print, terminal};

use crate::common::palette;

/// One row. `badge` is state the user needs before choosing (a stored key, the
/// active route); `hint` is detail that helps but can be truncated away.
pub struct Item {
    pub label: String,
    pub badge: String,
    pub hint: String,
}

impl Item {
    pub fn new(label: impl Into<String>) -> Self {
        Self { label: label.into(), badge: String::new(), hint: String::new() }
    }
    pub fn badge(mut self, b: impl Into<String>) -> Self {
        self.badge = b.into();
        self
    }
    pub fn hint(mut self, h: impl Into<String>) -> Self {
        self.hint = h.into();
        self
    }
}

/// Rows kept on screen at most. Below the terminal's height so the title, the
/// filter line and the shell prompt all still fit.
const MAX_ROWS: usize = 12;

/// Show `items` and return the index chosen, or `None` if the user backed out.
pub fn select(title: &str, items: &[Item]) -> Option<usize> {
    if items.is_empty() {
        return None;
    }
    if !std::io::stdin().is_terminal() || enable_raw_mode().is_err() {
        return numbered_fallback(title, items);
    }
    // Raw mode is on from here: every exit path below must turn it back off, or
    // the shell the user returns to stops echoing what they type.
    let picked = interactive(title, items);
    let _ = disable_raw_mode();
    let mut err = std::io::stderr();
    let _ = execute!(err, cursor::Show);
    let _ = writeln!(err);
    picked
}

fn interactive(title: &str, items: &[Item]) -> Option<usize> {
    let p = palette();
    let mut err = std::io::stderr();
    let _ = execute!(err, cursor::Hide);

    let mut query = String::new();
    let mut cursor_at = 0usize; // index into the FILTERED list
    let mut top = 0usize; // first visible filtered row
    let mut drawn = 0usize; // lines drawn last frame, to erase them

    loop {
        let filtered: Vec<usize> = items
            .iter()
            .enumerate()
            .filter(|(_, it)| matches(&query, it))
            .map(|(i, _)| i)
            .collect();
        cursor_at = cursor_at.min(filtered.len().saturating_sub(1));
        let rows = MAX_ROWS.min(visible_rows());
        if cursor_at < top {
            top = cursor_at;
        } else if cursor_at >= top + rows {
            top = cursor_at + 1 - rows;
        }
        top = top.min(filtered.len().saturating_sub(rows.max(1)).max(0));

        // Redraw in place: move back over what was printed last time rather
        // than clearing the screen, so the command's own scrollback survives.
        if drawn > 0 {
            let _ = queue!(err, cursor::MoveToPreviousLine(drawn as u16));
        }
        let mut lines = 0usize;
        let mut put = |s: String| {
            let _ = queue!(
                err,
                terminal::Clear(terminal::ClearType::CurrentLine),
                Print(s),
                Print("\r\n")
            );
            lines += 1;
        };

        put(format!("  {}{}{}", p.bold, title, p.reset));
        put(format!(
            "  {}{}{}",
            p.dim,
            if query.is_empty() {
                "arrows to move · type to filter · Enter to choose · Esc to cancel".to_string()
            } else {
                format!("filter: {query}   ({} of {})", filtered.len(), items.len())
            },
            p.reset
        ));

        if filtered.is_empty() {
            put(format!("  {}nothing matches{}", p.fail, p.reset));
        }
        for (row, &idx) in filtered.iter().enumerate().skip(top).take(rows) {
            let it = &items[idx];
            let selected = row == cursor_at;
            let marker = if selected { format!("{}>{}", p.accent, p.reset) } else { " ".into() };
            let name = if selected {
                format!("{}{}{}{}", p.bold, p.accent, it.label, p.reset)
            } else {
                format!("{}{}{}", p.text, it.label, p.reset)
            };
            let badge =
                if it.badge.is_empty() { String::new() } else { format!("  {}", it.badge) };
            let hint = if it.hint.is_empty() {
                String::new()
            } else {
                format!("  {}{}{}", p.dim, it.hint, p.reset)
            };
            put(format!("  {marker} {name}{badge}{hint}"));
        }
        // More below than fits: say so, or a list that scrolls looks like a
        // list that ends.
        if filtered.len() > top + rows {
            put(format!("  {}  … {} more{}", p.dim, filtered.len() - top - rows, p.reset));
        }
        let _ = err.flush();
        drawn = lines;

        let Ok(Event::Key(KeyEvent { code, modifiers, kind, .. })) = event::read() else {
            continue;
        };
        if kind != KeyEventKind::Press {
            continue; // Windows reports press AND release; acting on both double-steps
        }
        match code {
            KeyCode::Up => cursor_at = cursor_at.saturating_sub(1),
            KeyCode::Down => cursor_at = (cursor_at + 1).min(filtered.len().saturating_sub(1)),
            KeyCode::PageUp => cursor_at = cursor_at.saturating_sub(rows),
            KeyCode::PageDown => cursor_at = (cursor_at + rows).min(filtered.len().saturating_sub(1)),
            KeyCode::Home => cursor_at = 0,
            KeyCode::End => cursor_at = filtered.len().saturating_sub(1),
            KeyCode::Enter => return filtered.get(cursor_at).copied(),
            KeyCode::Esc => return None,
            KeyCode::Backspace => {
                query.pop();
                cursor_at = 0;
                top = 0;
            }
            KeyCode::Char('c') if modifiers.contains(KeyModifiers::CONTROL) => return None,
            KeyCode::Char(c) => {
                query.push(c);
                cursor_at = 0;
                top = 0;
            }
            _ => {}
        }
    }
}

/// Case-insensitive substring over everything on the row. Deliberately not
/// fuzzy: a fuzzy match on short ids puts surprising rows first, and the row
/// you meant is the one you typed.
fn matches(query: &str, it: &Item) -> bool {
    if query.is_empty() {
        return true;
    }
    let q = query.to_lowercase();
    it.label.to_lowercase().contains(&q) || it.hint.to_lowercase().contains(&q)
}

fn visible_rows() -> usize {
    terminal::size().map(|(_, h)| h.saturating_sub(6) as usize).unwrap_or(MAX_ROWS).max(3)
}

/// The old menu, kept for pipes and for terminals that will not go raw.
fn numbered_fallback(title: &str, items: &[Item]) -> Option<usize> {
    let p = palette();
    eprintln!();
    eprintln!("  {}{}{}", p.bold, title, p.reset);
    for (i, it) in items.iter().enumerate() {
        eprintln!("  {}{:>3}{}  {}{}{}  {}", p.bold, i + 1, p.reset, p.text, it.label, p.reset, it.badge);
    }
    eprint!("  {}> {}", p.meta, p.reset);
    let _ = std::io::stderr().flush();
    let mut s = String::new();
    if std::io::stdin().read_line(&mut s).ok()? == 0 {
        return None;
    }
    let s = s.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("q") {
        return None;
    }
    s.parse::<usize>().ok().filter(|n| *n >= 1 && *n <= items.len()).map(|n| n - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The filter is what makes a hundred-row catalogue usable, so it has to
    /// match the way people actually type: any case, and against the hint as
    /// well, since "free tier" is a reason to pick a row and is never in the
    /// name.
    #[test]
    fn filter_matches_name_and_hint_in_any_case() {
        let it = Item::new("OpenRouter").hint("free tier available");
        assert!(matches("", &it), "an empty filter shows everything");
        assert!(matches("open", &it));
        assert!(matches("ROUTER", &it));
        assert!(matches("free", &it), "the hint is searchable too");
        assert!(!matches("anthropic", &it));
    }

    /// A window that never leaves room for a row would render an empty list on
    /// a short terminal — which reads as "there are no providers".
    #[test]
    fn the_window_always_has_room_for_rows() {
        assert!(visible_rows() >= 3);
    }
}
