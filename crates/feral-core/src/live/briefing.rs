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
    "You are speaking out loud in a phone call. Answer in two or three sentences.",
    "Never use markdown, lists, headings, code blocks or emoji — every character you produce is read aloud.",
    "Speak the language the user speaks to you in.",
    "This changes how you SPEAK, not what you DO. Use your tools exactly as you otherwise would, and say what you are doing while you do it.",
];

/// Compose the setup message's system instruction.
///
/// Paragraphs, because the reference says each part becomes its own paragraph
/// and the model reads them as separate instructions rather than one run-on.
pub fn system_instruction(brief: &Briefing) -> String {
    let mut out: Vec<String> = SPOKEN_RULES.iter().map(|s| s.to_string()).collect();

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
