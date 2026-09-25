//! The key-spec grammar every backend shares, parsed once, platform-free.
//!
//! `"hello{Enter}"`, `"{ctrl+t}"`, `"{{"` for a literal brace: the same
//! grammar the Windows backend has always read (`parse_keys` there). The
//! macOS and Linux backends turn these tokens into their own input; keeping
//! the parse here means all three read a spec the same way, and the tests run
//! on every platform.

/// One step of a key spec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyTok {
    /// Literal text to type.
    Text(String),
    /// A named key, with modifiers held while it is pressed. Names are
    /// lowercased; modifiers are normalised to `ctrl`, `control`, `alt`,
    /// `shift` and `cmd` (see [`modifier`]).
    Chord { mods: Vec<&'static str>, key: String },
}

/// Longest spec accepted, the same bound the Windows backend has.
pub const MAX_KEYS_LEN: usize = 2000;

/// A modifier's canonical name. `ctrl` is the platform's accelerator
/// (Command on macOS, Ctrl elsewhere): the Jev key maps and the agent write
/// `{ctrl+t}` for "new tab" on every system. `control` is the Control key
/// itself, wherever it matters that it is not Command.
pub fn modifier(m: &str) -> Option<&'static str> {
    Some(match m.to_lowercase().as_str() {
        "ctrl" | "ctl" => "ctrl",
        "control" => "control",
        "alt" | "option" | "opt" => "alt",
        "shift" => "shift",
        "cmd" | "command" | "win" | "super" | "meta" => "cmd",
        _ => return None,
    })
}

/// Parse a spec into tokens. Adjacent literal characters become one `Text`.
pub fn parse(spec: &str) -> Result<Vec<KeyTok>, String> {
    if spec.len() > MAX_KEYS_LEN {
        return Err(format!("desktop control: key spec too long (max {MAX_KEYS_LEN} chars)"));
    }
    let mut out: Vec<KeyTok> = Vec::new();
    let mut text = String::new();
    let flush = |text: &mut String, out: &mut Vec<KeyTok>| {
        if !text.is_empty() {
            out.push(KeyTok::Text(std::mem::take(text)));
        }
    };
    let mut chars = spec.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            if chars.peek() == Some(&'{') {
                chars.next();
                text.push('{');
                continue;
            }
            let mut token = String::new();
            let mut closed = false;
            for n in chars.by_ref() {
                if n == '}' {
                    closed = true;
                    break;
                }
                token.push(n);
            }
            if !closed {
                return Err("desktop control: unterminated '{' in key spec".into());
            }
            // "{ctrl++}" names the plus key: a trailing "+" after a "+" is the key.
            let parts: Vec<&str> = if let Some(head) = token.strip_suffix("++") {
                head.split('+').map(str::trim).filter(|s| !s.is_empty()).chain(std::iter::once("+")).collect()
            } else {
                token.split('+').map(str::trim).filter(|s| !s.is_empty()).collect()
            };
            let Some((key, mods)) = parts.split_last() else { continue };
            let mods = mods
                .iter()
                .map(|m| modifier(m).ok_or_else(|| format!("desktop control: unknown modifier \"{m}\"")))
                .collect::<Result<Vec<_>, _>>()?;
            flush(&mut text, &mut out);
            out.push(KeyTok::Chord { mods, key: key.to_lowercase() });
        } else if c == '}' && chars.peek() == Some(&'}') {
            chars.next();
            text.push('}');
        } else {
            text.push(c);
        }
    }
    flush(&mut text, &mut out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(mods: &[&'static str], key: &str) -> KeyTok {
        KeyTok::Chord { mods: mods.to_vec(), key: key.into() }
    }

    #[test]
    fn text_and_named_keys() {
        assert_eq!(parse("hello{Enter}").unwrap(), vec![KeyTok::Text("hello".into()), chord(&[], "enter")]);
    }

    #[test]
    fn chords_normalise_modifiers() {
        assert_eq!(parse("{Ctrl+Shift+T}").unwrap(), vec![chord(&["ctrl", "shift"], "t")]);
        assert_eq!(parse("{cmd+w}{option+left}").unwrap(), vec![chord(&["cmd"], "w"), chord(&["alt"], "left")]);
        assert_eq!(parse("{control+c}").unwrap(), vec![chord(&["control"], "c")]);
    }

    #[test]
    fn plus_and_braces_as_keys() {
        assert_eq!(parse("{ctrl++}").unwrap(), vec![chord(&["ctrl"], "+")]);
        assert_eq!(parse("a{{b}}").unwrap(), vec![KeyTok::Text("a{b}".into())]);
    }

    #[test]
    fn bad_specs_are_refused() {
        assert!(parse("{ctrl+t").is_err());
        assert!(parse("{hyper+t}").is_err());
        assert!(parse(&"x".repeat(MAX_KEYS_LEN + 1)).is_err());
    }
}
