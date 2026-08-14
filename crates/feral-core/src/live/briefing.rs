//! What the model is told before it says a word.
//!
//! In a speech-to-speech call the conversational brain is Gemini, not the agent
//! loop — so everything the loop would normally establish per turn has to be
//! said once, here, in the setup message. That makes this file the whole of the
//! model's standing context, and the session is stateful, so it is said once and
//! not re-sent.
//!
//! Deliberately a pure function over data the caller already has. The webview
//! already asks the sidecar for the resume row to draw its "welcome back"
//! banner; making Rust open a second request path to the same table would be
//! more code for the same answer.

/// What the user was doing before they pressed call.
///
/// Every field optional because on a fresh install every field is null, and a
/// briefing that claims otherwise invents a task the user never had.
#[derive(Debug, Clone, Default)]
pub struct Briefing {
    /// From the sidecar's `resume_get`: the thing being worked on.
    pub current_task: Option<String>,
    pub workspace: Option<String>,
    /// Anything else worth knowing — recalled memory, notebook lines. Passed
    /// through verbatim; this module does not decide what is relevant.
    pub context: Option<String>,
}

/// Written once and read aloud, so the rules are about speech.
///
/// The line about tools is not filler and must not be trimmed. The same brief
/// on the text side, without it, made the agent stop calling tools altogether —
/// it read "keep answers to two sentences" as "do less" and quietly dropped the
/// work, which took the memory system and self-improvement out of the call with
/// it. Saying what the instruction does NOT change is what keeps that from
/// happening.
const SPOKEN_RULES: &[&str] = &[
    // Identity, first, because without it the model answers "I am a virtual
    // assistant" — which it did, when asked what application it was in. Nothing
    // else in this brief implies it is anywhere at all, and a voice that does not
    // know whose voice it is cannot be the product's voice.
    //
    // The second half is the part that makes the door get used. Told only that a
    // tool exists, the model treats it as available; told that its memory and its
    // hands are BEHIND that tool, it reaches for it — including for "what did we
    // talk about", which it would otherwise answer from an empty context by
    // saying it does not remember.
    "You are Feral: a local AI agent running on this user's own computer, speaking to them through the desktop app's voice call.",
    "Your memory of every earlier conversation, your files, the web, and everything you can DO all live behind one tool: ask_feral. You have no other way to reach them, and no recollection of your own — so when the user refers to anything past, anything on this machine, or anything you would have to look up, call ask_feral rather than saying you do not know or do not remember.",
    "You are speaking out loud in a phone call. Answer in two or three sentences.",
    "Never use markdown, lists, headings, code blocks or emoji — every character you produce is read aloud.",
    "Speak the language the user speaks to you in.",
    "This changes how you SPEAK, not what you DO. Use your tools exactly as you otherwise would, and say what you are doing while you do it.",
    // Measured on the first working call: `ask_feral` took 100 seconds, and the
    // model stayed silent for all of it. It was NOT blocked — asked "are you
    // still searching?" it answered immediately and correctly — so the session
    // was alive the whole time and simply had nothing to say. A caller cannot
    // tell that apart from a dead line, and a hundred seconds of it reads as
    // broken. Speaking is therefore made an instruction rather than left to
    // judgement: during the wait, because a hundred seconds is far too long for
    // one "one moment".
    //
    // The announcement is BOUND to the call, and that binding is the whole
    // point of this rule's shape. It used to read "before you call ask_feral,
    // say out loud that you are looking it up, then make the call" — which asks
    // for two things and gets the cheap one. Measured 2026-08-15: asked whether
    // it could search the web, the model said it was searching and never called
    // the tool. Nothing ran, no widget appeared, and the caller was told work
    // was happening that was not. An instruction that can be half-obeyed will
    // be, and the half that survives is the half that costs nothing.
    // Both halves, and both are needed. The prohibition alone made it worse:
    // forbidden to NARRATE a search and not pushed to MAKE one, the model simply
    // answered from memory and searched nothing. Measured 2026-08-15 — "search
    // the web for ways to promote Feral" produced an answer and no tool call,
    // and ask_feral was reached only when the user named it out loud.
    "When the user asks you to search, look something up, check, find out or read anything, that is an INSTRUCTION TO CALL ask_feral — not a topic to discuss. Do not answer it from what you already know: you cannot see the internet, and what you remember about it may be years out of date. Make the call first, then answer from what comes back.",
    "Saying you are looking something up and calling ask_feral are ONE action, never two: say the sentence only as you make the call, in the same breath. If you are genuinely answering from your own knowledge, say that instead — never describe searching, checking, looking up or 'letting me find out' unless the call is going out with it, because the user is watching a panel that shows what actually ran and an empty panel next to those words is a lie they can see.",
    "While you wait for ask_feral, keep the line warm: say something every ten or fifteen seconds, and answer anything the user says in the meantime. Never let the call go quiet for more than about fifteen seconds.",
];

/// Compose the setup message's system instruction.
///
/// Paragraphs, because the reference says each part becomes its own paragraph
/// and the model reads them as separate instructions rather than one run-on.
/// SOUL.md, handed over by the sidecar on its `hello` line.
///
/// Process-wide because there is one sidecar and one persona; threading it
/// through the call command would touch every signature between here and the
/// host for a value that is set once at startup.
static PERSONA: std::sync::OnceLock<parking_lot::RwLock<Option<String>>> =
    std::sync::OnceLock::new();

fn persona_cell() -> &'static parking_lot::RwLock<Option<String>> {
    PERSONA.get_or_init(|| parking_lot::RwLock::new(None))
}

/// Called by the sidecar reader. `None` clears it (an older sidecar sends no
/// persona, and a call briefed with a stale one is worse than one briefed
/// without).
pub fn set_persona(text: Option<String>) {
    *persona_cell().write() = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
}

fn persona() -> Option<String> {
    persona_cell().read().clone()
}

/// Reconciles the two documents when they disagree, which they do.
///
/// SOUL.md is written for a text surface and says emoji are fine when they earn
/// their place; every character here is spoken aloud, so they are not. Left to
/// infer it, the model picks one of two documents at random per turn. Stating
/// which layer wins costs a sentence and removes the coin flip.
const PERSONA_APPLIES_TO_SPEECH: &str =
    "Everything above describes WHO you are, and it holds on this call: the warmth, the register, the short declarative sentences, the refusal to perform the character. Where it describes how text is FORMATTED — markdown, emoji, layout — it does not apply here, because everything you produce is read aloud. Be the same character, spoken.";

pub fn system_instruction(brief: &Briefing) -> String {
    let mut out: Vec<String> = Vec::new();

    // Character first, mechanics after. The rules that follow are prohibitions
    // — no markdown, no emoji, two sentences — and a brief that opens with a
    // list of things not to do produces exactly what it describes: correct,
    // brief, and nobody in particular.
    if let Some(soul) = persona() {
        out.push(soul);
        out.push(PERSONA_APPLIES_TO_SPEECH.to_string());
    }

    out.extend(SPOKEN_RULES.iter().map(|s| s.to_string()));

    // Only state what is actually known. "The user is working on: nothing" is
    // worse than silence — the model will try to make it mean something.
    if let Some(task) = non_empty(&brief.current_task) {
        out.push(format!("The user was last working on: {task}"));
    }
    if let Some(workspace) = non_empty(&brief.workspace) {
        out.push(format!("Their current workspace is: {workspace}"));
    }
    if let Some(context) = non_empty(&brief.context) {
        out.push(context.to_string());
    }
    out.join("\n\n")
}

fn non_empty(field: &Option<String>) -> Option<&str> {
    field.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_is_told_who_and_where_it_is() {
        // Asked "what app are you in?", a call without these two lines answered
        // "I am a virtual assistant". Nothing else in the brief implies it is
        // anywhere, and the fields below are all optional and usually absent.
        let text = system_instruction(&Briefing::default());
        assert!(text.contains("You are Feral"), "the identity line was dropped");
        assert!(
            text.contains("no recollection of your own"),
            "the model is no longer told its memory is behind ask_feral",
        );
    }

    /// The bug these pin: a call was briefed with an identity line, tool rules
    /// and a list of formatting prohibitions, and nothing about character. It
    /// answered correctly and sounded, in the user's words, like a fridge —
    /// because that is exactly what it was told to be. SOUL.md existed the whole
    /// time and had no route into a speech-to-speech session.
    /// One test rather than three, because the persona is process-wide state
    /// and `cargo test` runs threads in parallel — three tests setting and
    /// clearing one global race each other, and the failure looks like the
    /// feature is broken rather than the test.
    #[test]
    fn the_persona_reaches_a_call_before_the_rules_do() {
        set_persona(Some("Short declarative sentences. Never baby talk.".into()));
        let text = system_instruction(&Briefing::default());

        assert!(text.contains("Never baby talk"), "SOUL.md did not reach the call");
        // Order is the point, not presence. Character first, mechanics after:
        // a brief that opens with what NOT to do produces what it describes.
        let soul_at = text.find("Short declarative").expect("persona present");
        let rules_at = text.find("You are Feral").expect("rules present");
        assert!(soul_at < rules_at, "the prohibitions came before the character");
        // SOUL.md is written for text and allows emoji that earn their place;
        // every character here is spoken. Left to infer it, the model picks one
        // of the two documents per turn at random.
        assert!(text.contains("read aloud"), "nothing reconciles the two documents");

        // An older sidecar sends no persona at all. That must be a call without
        // one, not a blank paragraph the model tries to make mean something.
        set_persona(None);
        let bare = system_instruction(&Briefing::default());
        assert!(bare.starts_with("You are Feral"), "an empty persona left a gap");
    }

    #[test]
    fn the_call_is_told_not_to_go_quiet() {
        // A hundred seconds of measured silence is what put this line in. The
        // session was alive throughout — it answered when spoken to — so nothing
        // in the protocol will bring this back if the instruction is trimmed.
        let text = system_instruction(&Briefing::default());
        assert!(text.contains("ask_feral"), "the model is no longer told to announce the lookup");
        assert!(text.contains("quiet"), "the keep-talking instruction was dropped");
    }

    #[test]
    fn a_request_to_search_is_told_to_be_a_tool_call() {
        // Measured 2026-08-15: "search the web for ways to promote Feral" got an
        // answer from memory and no tool call. Forbidding the NARRATION of a
        // search without also demanding the CALL made it quieter, not more
        // honest — both halves ship together or this comes back.
        let text = system_instruction(&Briefing::default());
        assert!(
            text.contains("INSTRUCTION TO CALL ask_feral"),
            "nothing turns 'search this' into a tool call",
        );
        assert!(
            text.contains("Make the call first"),
            "the model is no longer told to look before it answers",
        );
    }

    #[test]
    fn announcing_a_lookup_is_bound_to_making_it() {
        // Measured 2026-08-15: asked whether it could search the web, the model
        // said it was searching and never called the tool — because the rule
        // asked for two things ("say it, then call") and it did the free one.
        // The user watched an empty tool panel while being told work was
        // happening. The two must read as ONE action or this comes back.
        let text = system_instruction(&Briefing::default());
        assert!(
            text.contains("ONE action, never two"),
            "the announcement is no longer bound to the call — it will be made alone",
        );
        assert!(
            text.contains("never describe searching"),
            "nothing forbids narrating a search that is not happening",
        );
    }

    #[test]
    fn the_tools_line_is_always_there() {
        // The regression this file exists to prevent. If this assertion is ever
        // "fixed" by deleting it, read the doc comment on SPOKEN_RULES first.
        for brief in [Briefing::default(), Briefing { current_task: Some("x".into()), ..Default::default() }] {
            let text = system_instruction(&brief);
            assert!(text.contains("not what you DO"), "the tools warning was dropped");
        }
    }

    #[test]
    fn a_fresh_install_gets_rules_and_no_invented_history() {
        let text = system_instruction(&Briefing::default());
        assert!(text.contains("two or three sentences"));
        // Nothing is known, so nothing is claimed.
        assert!(!text.contains("last working on"));
        assert!(!text.contains("workspace is"));
    }

    #[test]
    fn known_state_is_stated_and_blank_state_is_not() {
        let text = system_instruction(&Briefing {
            current_task: Some("  the landing page  ".into()),
            // Present but empty, which is what a null column round-trips to.
            workspace: Some("   ".into()),
            context: None,
        });
        assert!(text.contains("last working on: the landing page"));
        assert!(!text.contains("workspace is"));
    }

    #[test]
    fn parts_are_separated_so_they_read_as_separate_instructions() {
        let text = system_instruction(&Briefing {
            context: Some("They prefer Romanian.".into()),
            ..Default::default()
        });
        assert!(text.contains("\n\n"));
        assert!(text.ends_with("They prefer Romanian."));
        // Passed through verbatim — this module does not editorialise context.
        assert!(!text.contains("context:"));
    }
}
