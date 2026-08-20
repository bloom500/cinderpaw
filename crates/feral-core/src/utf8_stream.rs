//! Decoding UTF-8 that arrives in pieces.
//!
//! A network chunk boundary falls wherever TCP decides, which is regularly in
//! the middle of a multi-byte character. `String::from_utf8_lossy` per chunk
//! sees the orphaned lead byte, gives up on it, and substitutes `U+FFFD` — so
//! an emoji, a Romanian `ă`, a Cyrillic or Chinese character split across two
//! packets reaches the screen as `�`, at random, for no reason the user can
//! see. The text was never corrupt; only the decoding was.
//!
//! This keeps the incomplete tail (never more than three bytes) and prepends it
//! to the next chunk. Genuinely invalid bytes still become `U+FFFD` — that is
//! what they are — but a merely *unfinished* character waits for its rest.

/// Incremental UTF-8 decoder for a byte stream.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed the next chunk; returns every character that is now complete.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        if self.pending.is_empty() {
            // Fast path: the overwhelming majority of chunks are whole.
            match std::str::from_utf8(bytes) {
                Ok(s) => return s.to_string(),
                Err(_) => self.pending.extend_from_slice(bytes),
            }
        } else {
            self.pending.extend_from_slice(bytes);
        }

        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let good = e.valid_up_to();
                    // SAFETY-free: `valid_up_to` guarantees this prefix parses.
                    out.push_str(std::str::from_utf8(&self.pending[..good]).unwrap_or(""));
                    match e.error_len() {
                        // Truncated at the end — keep it for the next chunk.
                        None => {
                            self.pending.drain(..good);
                            break;
                        }
                        // Really invalid — mark it and carry on past it.
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..good + bad);
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_split_across_chunks_survives_whole() {
        let text = "răspuns 🎙 完成";
        let bytes = text.as_bytes();
        // Every possible split point must reassemble to the same string.
        for cut in 1..bytes.len() {
            let mut s = Utf8Stream::new();
            let mut out = s.push(&bytes[..cut]);
            out.push_str(&s.push(&bytes[cut..]));
            assert_eq!(out, text, "split at byte {cut} mangled the text");
        }
    }

    #[test]
    fn byte_at_a_time_still_reassembles() {
        let text = "ăîâșț 🐻";
        let mut s = Utf8Stream::new();
        let mut out = String::new();
        for b in text.as_bytes() {
            out.push_str(&s.push(&[*b]));
        }
        assert_eq!(out, text);
    }

    #[test]
    fn genuinely_invalid_bytes_become_one_replacement_each() {
        let mut s = Utf8Stream::new();
        let out = s.push(&[0x41, 0xFF, 0x42]);
        assert_eq!(out, "A\u{FFFD}B");
    }
}
