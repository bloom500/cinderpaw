//! Credential redaction for anything written to disk.
//!
//! The connector flow tells a user, in plain words, to paste a bot token
//! into the chat. The sidecar already keeps that token out of memory
//! (`CinderpawAgent/src/memory/privacy.ts`), but the conversation the
//! Desktop saves is a second store, written here, and it kept the token
//! in plaintext.
//!
//! ## Why this is hand-written and not a regex
//!
//! Every pattern below is the same three checks — a known prefix, an
//! allowed character set, a minimum length — which is what a credential
//! format actually is. Written directly they need no new dependency
//! (`regex` is not a direct dep of any crate here) and read as what they
//! mean. The scan is one pass over whitespace-separated words.
//!
//! ## Why it is anchored and not entropy-based
//!
//! A "looks random enough" detector eats base64 payloads, hashes and git
//! SHAs. A redactor that mangles ordinary text is one that gets turned
//! off, and then it protects nothing. Every rule here needs a known
//! prefix or a known structure.
//!
//! ## Parity with the sidecar
//!
//! The same formats are recognised in TypeScript by `redactSecrets`.
//! Both sides are tested against the SAME fixture file
//! (`CinderpawAgent/tests/fixtures/secret-redaction-cases.json`) so the
//! two lists cannot silently drift apart — a secret redacted from memory
//! but not from the transcript is still a leaked secret.

/// What kind of credential was found. Used only to label the placeholder,
/// so a person reading a redacted transcript knows what used to be there.
fn placeholder(kind: &str) -> String {
    format!("[REDACTED:{kind}]")
}

/// Characters that can appear inside the credential formats we know.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Trailing punctuation a person types around a pasted value — "here:
/// sk-abc." — which is not part of the credential.
const TRIM: &[char] = &['.', ',', ';', ':', ')', ']', '}', '"', '\'', '!', '?', '>'];

/// Classify one word. `None` when it is ordinary text.
fn classify(word: &str) -> Option<&'static str> {
    // Slack labels its own tokens, which makes them the easiest case.
    if let Some(rest) = word.strip_prefix("xoxb-").or_else(|| word.strip_prefix("xoxp-")) {
        return long_enough(rest, 10).then_some("slack_token");
    }
    for prefix in ["xoxa-", "xoxr-", "xoxs-"] {
        if let Some(rest) = word.strip_prefix(prefix) {
            return long_enough(rest, 10).then_some("slack_token");
        }
    }
    if let Some(rest) = word.strip_prefix("xapp-") {
        return long_enough(rest, 10).then_some("slack_token");
    }
    // Anthropic is checked before the generic `sk-` so the more specific
    // prefix is the one that matches.
    if let Some(rest) = word.strip_prefix("sk-ant-") {
        return long_enough(rest, 20).then_some("api_key");
    }
    if let Some(rest) = word.strip_prefix("sk-") {
        return long_enough(rest, 20).then_some("api_key");
    }
    // Groq and NVIDIA NIM. Not academic: `byok.rs` ships both as first-class
    // providers and declares these exact prefixes as their `key_format`, so
    // the connector flow asks the user to paste one into the chat — and the
    // transcript kept it in plaintext, because this list stopped at the
    // formats somebody happened to think of. `byok_key_formats_are_redacted`
    // in the parity test pins the catalog to this function from now on.
    if let Some(rest) = word.strip_prefix("gsk_") {
        return long_enough(rest, 20).then_some("api_key");
    }
    if let Some(rest) = word.strip_prefix("nvapi-") {
        return long_enough(rest, 20).then_some("api_key");
    }
    // Google: AIza + exactly 35 more.
    if let Some(rest) = word.strip_prefix("AIza") {
        return (rest.chars().count() == 35 && rest.chars().all(is_token_char))
            .then_some("api_key");
    }
    // GitHub personal access / OAuth / server / refresh tokens.
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
        if let Some(rest) = word.strip_prefix(prefix) {
            return (rest.chars().count() >= 36 && rest.chars().all(|c| c.is_ascii_alphanumeric()))
                .then_some("github_token");
        }
    }
    // AWS access key id: AKIA + exactly 16 uppercase/digits.
    if let Some(rest) = word.strip_prefix("AKIA") {
        return (rest.chars().count() == 16
            && rest.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
        .then_some("aws_key");
    }
    // Discord bot tokens and JWTs share a three-part dotted shape. Both
    // are credentials, so one label covers both without pretending to
    // tell them apart.
    if is_three_part_token(word) {
        return Some("token");
    }
    None
}

fn long_enough(rest: &str, min: usize) -> bool {
    rest.chars().count() >= min && rest.chars().all(is_token_char)
}

/// `aaaa.bbb.cccc` where every part is token-shaped and long enough that
/// it cannot be an ordinary dotted word or a version number.
fn is_three_part_token(word: &str) -> bool {
    let parts: Vec<&str> = word.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let lens = [20usize, 6, 20];
    parts
        .iter()
        .zip(lens)
        .all(|(p, min)| p.chars().count() >= min && p.chars().all(is_token_char))
}

/// Redact PEM private key blocks. Done first and on the whole text
/// because the block spans lines, and the word scan would otherwise chop
/// it into pieces and leave the key body behind.
fn redact_pem(input: &str, count: &mut usize) -> String {
    const BEGIN: &str = "-----BEGIN";
    const END_MARK: &str = "PRIVATE KEY-----";
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let Some(start) = rest.find(BEGIN) else {
            out.push_str(rest);
            return out;
        };
        // Only a PRIVATE KEY block; a CERTIFICATE is not a secret.
        let header_end = match rest[start..].find("-----\n").or_else(|| rest[start..].find("-----\r")) {
            Some(i) => start + i + 5,
            None => {
                out.push_str(rest);
                return out;
            }
        };
        if !rest[start..header_end].contains("PRIVATE KEY") {
            out.push_str(&rest[..header_end]);
            rest = &rest[header_end..];
            continue;
        }
        let Some(end_rel) = rest[header_end..].find(END_MARK) else {
            out.push_str(rest);
            return out;
        };
        let end = header_end + end_rel + END_MARK.len();
        out.push_str(&rest[..start]);
        out.push_str(&placeholder("private_key"));
        *count += 1;
        rest = &rest[end..];
    }
}

/// The result of a redaction pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactResult {
    pub text: String,
    /// How many credentials were replaced.
    pub redactions: usize,
}

/// Replace every recognised credential in `input` with
/// `[REDACTED:<kind>]`, preserving all other text and whitespace exactly.
///
/// Safe to run on text with no secrets in it: ordinary prose comes back
/// byte-identical.
pub fn redact_secrets(input: &str) -> RedactResult {
    let mut redactions = 0usize;
    let staged = redact_pem(input, &mut redactions);

    let mut out = String::with_capacity(staged.len());
    // Walk words while copying the whitespace between them verbatim, so a
    // redacted transcript keeps its original line breaks and indentation.
    let mut chars = staged.char_indices().peekable();
    let mut word_start: Option<usize> = None;
    // `Bearer <token>`: the value after the label is a credential even
    // when its own shape gives nothing away.
    let mut previous_word_was_bearer = false;

    let flush = |word: &str, out: &mut String, redactions: &mut usize, bearer: &mut bool| {
        let trimmed = word.trim_end_matches(TRIM);
        let suffix = &word[trimmed.len()..];
        let is_bearer_value =
            *bearer && trimmed.chars().count() >= 20 && trimmed.chars().all(|c| is_token_char(c) || c == '.' || c == '=' || c == '~' || c == '+' || c == '/');
        if is_bearer_value {
            out.push_str(&placeholder("bearer"));
            *redactions += 1;
        } else if let Some(kind) = classify(trimmed) {
            out.push_str(&placeholder(kind));
            *redactions += 1;
        } else {
            out.push_str(trimmed);
        }
        out.push_str(suffix);
        *bearer = trimmed.eq_ignore_ascii_case("Bearer");
    };

    while let Some((i, c)) = chars.next() {
        if c.is_whitespace() {
            if let Some(start) = word_start.take() {
                let word = &staged[start..i];
                flush(word, &mut out, &mut redactions, &mut previous_word_was_bearer);
            }
            out.push(c);
        } else if word_start.is_none() {
            word_start = Some(i);
        }
    }
    if let Some(start) = word_start {
        let word = &staged[start..];
        flush(word, &mut out, &mut redactions, &mut previous_word_was_bearer);
    }

    RedactResult { text: out, redactions }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_a_discord_bot_token() {
        let token = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GxYzAb.aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678";
        let r = redact_secrets(&format!("here you go: {token}"));
        assert!(!r.text.contains(token));
        assert!(r.text.contains("[REDACTED:token]"));
        assert_eq!(r.redactions, 1);
    }

    #[test]
    fn redacts_slack_github_aws_and_provider_keys() {
        assert!(redact_secrets("xoxb-123456789012-abcdefghijklmno").text.contains("[REDACTED:slack_token]"));
        assert!(redact_secrets("xapp-1-A012BCDEF-98765-abcdef").text.contains("[REDACTED:slack_token]"));
        assert!(redact_secrets("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa").text.contains("[REDACTED:api_key]"));
        assert!(redact_secrets(&format!("ghp_{}", "a".repeat(36))).text.contains("[REDACTED:github_token]"));
        assert!(redact_secrets("AKIAIOSFODNN7EXAMPLE").text.contains("[REDACTED:aws_key]"));
    }

    #[test]
    fn redacts_a_bearer_value_that_has_no_telling_shape() {
        let r = redact_secrets("send Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
        assert!(r.text.contains("[REDACTED:bearer]"), "got: {}", r.text);
    }

    #[test]
    fn redacts_a_whole_pem_block_not_just_its_first_line() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc123\n-----END RSA PRIVATE KEY-----";
        let r = redact_secrets(&format!("saved:\n{pem}\ndone"));
        assert!(!r.text.contains("MIIEpAIBAAKCAQEA"));
        assert!(r.text.contains("[REDACTED:private_key]"));
        assert!(r.text.contains("done"));
    }

    #[test]
    fn a_certificate_is_not_a_secret() {
        let cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
        assert_eq!(redact_secrets(cert).redactions, 0);
    }

    #[test]
    fn ordinary_text_comes_back_byte_identical() {
        // A redactor that mangles normal prose is one the user turns off.
        let prose = "connect to discord please, my server is called the-lab and I am on \
                     version 2.1.0 with commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
        let r = redact_secrets(prose);
        assert_eq!(r.text, prose);
        assert_eq!(r.redactions, 0);
    }

    #[test]
    fn does_not_eat_base64_payloads_or_uuids() {
        let text = "data aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgcGF5bG9hZA== \
                    id 550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(redact_secrets(text).redactions, 0);
    }

    #[test]
    fn whitespace_and_line_breaks_survive() {
        let input = "line one\n  indented sk-aaaaaaaaaaaaaaaaaaaaaaaa\n\nlast";
        let r = redact_secrets(input);
        assert!(r.text.starts_with("line one\n  indented "));
        assert!(r.text.ends_with("\n\nlast"));
    }

    #[test]
    fn trailing_punctuation_is_kept_outside_the_placeholder() {
        let r = redact_secrets("the key is sk-aaaaaaaaaaaaaaaaaaaaaaaa.");
        assert!(r.text.ends_with("[REDACTED:api_key]."), "got: {}", r.text);
    }
}
