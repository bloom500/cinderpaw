## Description: <br>
Captures learnings, errors, feature requests, and corrections so agents can preserve useful context and improve recurring workflows across sessions. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[pskoett](https://clawhub.ai/user/pskoett) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
Developers and agent operators use this skill to record corrections, command failures, feature requests, and durable lessons in local markdown files for later review and promotion into agent memory. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Persistent learning logs may accidentally capture secrets, raw transcripts, or overly broad command output. <br>
Mitigation: Record short summaries or redacted excerpts, avoid secrets and private keys, and review entries before promoting them into agent memory files. <br>
Risk: Optional hooks can inject reminders or inspect command output when enabled. <br>
Mitigation: Prefer project-scoped hook configuration, enable command-output detection only in trusted workspaces, and inspect or pin the source before manual installation. <br>
Risk: Cross-session sharing can expose sensitive context if used casually. <br>
Mitigation: Use cross-session tools only in trusted environments and only when explicitly needed; share sanitized summaries and relevant paths instead of raw transcripts. <br>


## Reference(s): <br>
- [OpenClaw Integration](references/openclaw-integration.md) <br>
- [Hooks Setup](references/hooks-setup.md) <br>
- [Self-Improvement Examples](references/examples.md) <br>
- [ClawHub skill page](https://clawhub.ai/pskoett/self-improving-agent) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown log entries with optional shell commands and configuration snippets] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Creates or appends local .learnings entries; optional hooks inject reminder text.] <br>

## Skill Version(s): <br>
3.0.21 (source: evidence.release.version) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
