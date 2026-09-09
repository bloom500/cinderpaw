//! Grapheme-to-phoneme for the on-device voices, without espeak-ng.
//!
//! ## Why this file exists
//!
//! Kokoro takes phonemes, not text, and until now those phonemes came from
//! `espeak_rs::text_to_phonemes`. espeak-ng is **GPLv3**, and it is compiled
//! into the binary rather than called as a separate program, so every Windows
//! and macOS installer we shipped carried GPL code inside a BUSL-1.1 product.
//! The wrapper crates advertise themselves as MIT, which is true of the wrapper
//! and false of what lands in the executable.
//!
//! ## The three pieces, and why one is not enough
//!
//! Measured before this was written, not assumed:
//!
//! * **A dictionary alone spells names out.** `misaki-rs` with its espeak
//!   fallback disabled turns "Cinderpaw" into `sˈi ˈaɪ ˈɛn dˈiː …` — the letters
//!   C, I, N, D, E, R, P, A, W read one by one. The agent would spell its own
//!   name.
//! * **`piper-plus-g2p` alone drops them.** Its own docs: "Truly OOV words (no
//!   dict entry and no morphological match) produce no output." Silence inside a
//!   sentence is worse than a wrong guess, because nothing on screen says a word
//!   went missing.
//! * **Prediction alone mangles compounds.** `grapheme_to_phoneme` guesses
//!   "cinderpaw" and "lifecycle" correctly, but "typescript" became
//!   `T AY1 S P IH2 K T R AH2 P`.
//!
//! So: the dictionary answers for words it knows, camelCase and compound words
//! are split first so each half can be looked up, and only what is left over is
//! predicted from its letters. `TypeScript` → `Type` + `Script` →
//! `T AY1 P S K R IH1 P T`, which is right.
//!
//! ## Licences
//!
//! `misaki-rs` MIT, `grapheme_to_phoneme` and `arpabet` BSD-4-Clause. None are
//! copyleft. BSD-4-Clause carries the advertising clause, so those two owe an
//! acknowledgement in `THIRD-PARTY-NOTICES.md`.

use anyhow::{bail, Result};
use std::sync::OnceLock;

use misaki_rs::fallback::{Fallback, FallbackError};
use misaki_rs::{Language, G2P};

/// ARPAbet → IPA, in the flavour espeak-ng emits and Kokoro was trained on.
///
/// Taken from `piper-plus-g2p`'s table, which states it reproduces espeak's
/// output. Getting this wrong is not an accent: Kokoro's tokenizer drops
/// symbols it does not know, so a wrong alphabet does not fail loudly, it
/// quietly deletes sounds until the reply slurs.
fn arpabet_to_ipa(base: &str) -> Option<&'static str> {
    Some(match base {
        "AA" => "ɑ",
        "AE" => "æ",
        "AH" => "ʌ", // stressed; the unstressed case is a schwa, handled below
        "AO" => "ɔː",
        "AW" => "aʊ",
        "AY" => "aɪ",
        "B" => "b",
        "CH" => "tʃ",
        "D" => "d",
        "DH" => "ð",
        "EH" => "ɛ",
        "ER" => "ɚ", // unstressed; stressed is ɜː, handled below
        "EY" => "eɪ",
        "F" => "f",
        "G" => "ɡ",
        "HH" => "h",
        "IH" => "ɪ",
        "IY" => "iː",
        "JH" => "dʒ",
        "K" => "k",
        "L" => "l",
        "M" => "m",
        "N" => "n",
        "NG" => "ŋ",
        "OW" => "oʊ",
        "OY" => "ɔɪ",
        "P" => "p",
        "R" => "ɹ",
        "S" => "s",
        "SH" => "ʃ",
        "T" => "t",
        "TH" => "θ",
        "UH" => "ʊ",
        "UW" => "uː",
        "V" => "v",
        "W" => "w",
        "Y" => "j",
        "Z" => "z",
        "ZH" => "ʒ",
        _ => return None,
    })
}

/// `"AH0"` → `("AH", 0)`. ARPAbet marks stress as a trailing digit on vowels;
/// consonants carry none, which is `-1` here rather than `0` so "unstressed
/// vowel" and "not a vowel" stay distinguishable — the schwa rule needs that.
fn split_stress(token: &str) -> (&str, i32) {
    match token.as_bytes().last() {
        Some(c @ b'0'..=b'2') => (&token[..token.len() - 1], (c - b'0') as i32),
        _ => (token, -1),
    }
}

/// A word's ARPAbet tokens → one IPA string, stress marks included.
///
/// Three context rules, copied from the reference implementation because the
/// vowels they cover are common enough that skipping them is audible:
/// `AA`+`R` merge, stressed `ER` darkens, unstressed `AH` reduces to schwa.
fn word_to_ipa(tokens: &[&str]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < tokens.len() {
        let (base, stress) = split_stress(tokens[i]);

        // AA + R → ɑːɹ, but only when the R is a bare consonant.
        if base == "AA" && i + 1 < tokens.len() && split_stress(tokens[i + 1]) == ("R", -1) {
            push_stress(&mut out, stress);
            out.push_str("ɑːɹ");
            i += 2;
            continue;
        }

        let ipa = if base == "ER" && stress == 1 {
            Some("ɜː")
        } else if base == "AH" && stress == 0 {
            Some("ə")
        } else {
            arpabet_to_ipa(base)
        };

        // An ARPAbet symbol we do not know is skipped rather than fatal: the
        // reference implementations do the same, and one missing sound beats
        // refusing to speak the sentence.
        if let Some(ipa) = ipa {
            push_stress(&mut out, stress);
            out.push_str(ipa);
        }
        i += 1;
    }
    out
}

/// IPA puts the stress mark before the syllable it applies to.
fn push_stress(out: &mut String, stress: i32) {
    match stress {
        1 => out.push('ˈ'),
        2 => out.push('ˌ'),
        _ => {}
    }
}

/// `"assertBudget"` → `["assert", "Budget"]`, `"TypeScript"` → `["Type", "Script"]`.
///
/// The break is where a lowercase letter is followed by an uppercase one. This
/// is what makes the difference between `T AY1 P S K R IH1 P T` and the garbage
/// the predictor produces for the whole token, and it matters here more than in
/// most products: this agent talks about code, so camelCase identifiers are
/// ordinary vocabulary rather than an edge case.
///
/// An all-caps run is left whole, so `API` stays one token and is spelled out as
/// letters — which is how a person reads it too.
pub(crate) fn split_camel(word: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for ch in word.chars() {
        if ch.is_uppercase() && prev_lower && !cur.is_empty() {
            parts.push(std::mem::take(&mut cur));
        }
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
        cur.push(ch);
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts
}

/// Brand and product names the predictor gets wrong, in ARPAbet.
///
/// Deliberately tiny. It exists because the predictor reads `GitHub` with a soft
/// g (`JH IH1 T`, "jit-hub"), and because a product that mispronounces its own
/// name sounds broken in the first sentence a stranger hears. Anything that can
/// be fixed by splitting the word does not belong here.
fn override_arpabet(word: &str) -> Option<&'static [&'static str]> {
    Some(match word.to_ascii_lowercase().as_str() {
        "git" => &["G", "IH1", "T"],
        "cinderpaw" => &["S", "IH1", "N", "D", "ER0", "P", "AO2"],
        _ => return None,
    })
}

/// The OOV half of the pipeline, handed to misaki through its `Fallback` trait.
///
/// misaki's own fallback is espeak. The trait is the seam that lets us hand it
/// something else instead — which is the entire reason Kokoro can be cleaned up
/// with one call site while Piper cannot: `piper-rs` calls espeak directly from
/// inside the crate, with no seam to reach.
struct PredictFallback {
    model: grapheme_to_phoneme::Model,
}

impl Fallback for PredictFallback {
    fn phonemize(&self, word: &str) -> Result<String, FallbackError> {
        let mut ipa = String::new();
        for part in split_camel(word) {
            let lower = part.to_ascii_lowercase();
            if let Some(arpa) = override_arpabet(&lower) {
                ipa.push_str(&word_to_ipa(arpa));
                continue;
            }
            match self.model.predict_phonemes_strs(&lower) {
                Ok(tokens) => ipa.push_str(&word_to_ipa(&tokens)),
                // One unpronounceable fragment must not lose the whole word.
                Err(_) => continue,
            }
        }
        if ipa.is_empty() {
            return Err(FallbackError::NoPhonemes { word: word.to_string() });
        }
        Ok(ipa)
    }
}

/// Kokoro voice id → the only two languages this pipeline can speak.
///
/// Kokoro ships voices for eight languages; the dictionary and the predictor
/// behind this module are English-only. A Spanish voice fed English phonemes
/// does not fail, it speaks Spanish words with an American mouth — so an
/// unsupported voice is an error here rather than a silent accent.
fn language_for(voice: &str) -> Result<Language> {
    match voice.as_bytes().first() {
        Some(b'b') => Ok(Language::EnglishGB),
        Some(b'a') | None => Ok(Language::EnglishUS),
        Some(_) => bail!(
            "the Kokoro voice {voice:?} is not English, and this build phonemises English only. \
             Pick an American (a…) or British (b…) voice, or a hosted engine."
        ),
    }
}

/// One engine per language, built once. Construction loads a dictionary and a
/// prediction model; doing that per utterance would put tens of milliseconds in
/// front of every reply.
///
/// Two slots rather than a map because `misaki_rs::Language` is not `Hash` and
/// there are exactly two of them. A `HashMap` here would be a wrapper around a
/// two-way branch.
fn engine(lang: Language) -> Result<&'static G2P> {
    static US: OnceLock<Option<G2P>> = OnceLock::new();
    static GB: OnceLock<Option<G2P>> = OnceLock::new();

    let build = || -> Option<G2P> {
        let model = grapheme_to_phoneme::Model::load_in_memory().ok()?;
        let fb: Box<dyn Fallback> = Box::new(PredictFallback { model });
        Some(G2P::with_fallback(lang, Some(fb)))
    };
    let slot = match lang {
        Language::EnglishGB => &GB,
        Language::EnglishUS => &US,
    };
    slot.get_or_init(build)
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("the pronunciation model failed to load"))
}

/// Whether this build can phonemise for that voice at all.
///
/// The picker calls this so a voice it cannot speak is never offered. The
/// alternative is a control that can only fail, which is the shape this codebase
/// already refuses elsewhere: the STT card lists "local" on builds where
/// `transcribe_audio` always returns `voice-unavailable`.
pub fn can_speak(voice: &str) -> bool {
    language_for(voice).is_ok()
}

/// Text → the IPA string Kokoro's tokenizer expects. The espeak replacement.
pub fn phonemise(voice: &str, text: &str) -> Result<String> {
    let lang = language_for(voice)?;
    let (phonemes, _tokens) = engine(lang)?
        .g2p(text)
        .map_err(|e| anyhow::anyhow!("could not phonemise the reply: {e}"))?;
    Ok(phonemes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_case_is_split_where_a_lowercase_meets_an_uppercase() {
        assert_eq!(split_camel("assertBudget"), ["assert", "Budget"]);
        assert_eq!(split_camel("TypeScript"), ["Type", "Script"]);
        assert_eq!(split_camel("contractDepsFrom"), ["contract", "Deps", "From"]);
        // An acronym stays whole; letter-by-letter is the right reading for it.
        assert_eq!(split_camel("API"), ["API"]);
        assert_eq!(split_camel("hello"), ["hello"]);
    }

    #[test]
    fn stress_digits_are_read_off_the_vowel_and_consonants_have_none() {
        assert_eq!(split_stress("AH0"), ("AH", 0));
        assert_eq!(split_stress("ER1"), ("ER", 1));
        assert_eq!(split_stress("K"), ("K", -1));
    }

    /// The three context rules, each with the word that made it necessary.
    #[test]
    fn the_context_rules_fire() {
        // AA + R merge: "cargo" → kˈɑːɹɡoʊ, not kˈɑɹɡoʊ.
        assert_eq!(word_to_ipa(&["K", "AA1", "R", "G", "OW0"]), "kˈɑːɹɡoʊ");
        // Stressed ER darkens: "assert" → ɐsˈɜːt.
        assert!(word_to_ipa(&["AH0", "S", "ER1", "T"]).contains("ɜː"));
        // Unstressed AH is a schwa, not a full ʌ.
        assert_eq!(word_to_ipa(&["AH0"]), "ə");
        assert_eq!(word_to_ipa(&["AH1"]), "ˈʌ");
    }

    #[test]
    fn an_unknown_arpabet_symbol_is_skipped_rather_than_fatal() {
        assert_eq!(word_to_ipa(&["K", "QQ9", "T"]), "kt");
    }

    /// A non-English voice must be refused, not spoken with an English mouth.
    ///
    /// Silently phonemising Spanish as American English is the failure the TTS
    /// catalog already refuses elsewhere: speaking through something other than
    /// what was configured is worse than saying nothing.
    #[test]
    fn a_non_english_voice_is_refused_with_a_reason() {
        assert!(language_for("af_heart").is_ok());
        assert!(language_for("bm_george").is_ok());
        let err = language_for("ef_dora").unwrap_err().to_string();
        assert!(err.contains("English only"), "{err}");
        assert!(err.contains("hosted engine"), "{err}");
    }

    /// The whole point, end to end: the product's own name and the identifiers
    /// it talks about come out as words, not as spelled letters.
    #[test]
    fn names_and_identifiers_are_pronounced_not_spelled() {
        let out = phonemise("af_heart", "Cinderpaw runs assertBudget in TypeScript.")
            .expect("English voice phonemises");

        // The measured output, asserted rather than described:
        //   sˈɪndɚpˌɔː  ɹˈʌnz  əsˈɜːtbˈʌdʒɪt  ɪn  tˈaɪpskɹˈɪpt
        //   SIN-der-paw    runs   assert-budget      in   TYPE-script
        assert!(out.contains("sˈɪndɚpˌɔː"), "the product's own name: {out}");
        assert!(out.contains("tˈaɪpskɹˈɪpt"), "a split camelCase word: {out}");

        // "dˈʌbəljˌuː" is how a spelled-out W reads. Its presence would mean the
        // fallback had gone back to spelling names one letter at a time.
        assert!(
            !out.contains("dˈʌbəljˌuː"),
            "a name was spelled letter by letter: {out}"
        );
    }
}
