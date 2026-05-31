## Description: <br>
PollyReach gives every AI agent a phone number and the ability to get things done over the phone, including finding contacts, making calls, and completing tasks. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[pollyreach](https://clawhub.ai/user/pollyreach) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
External users and their agents use PollyReach to place outbound calls for bookings, inquiries, complaints, confirmations, and similar phone tasks, and to retrieve or manage incoming call summaries. The skill is also used to activate a PollyReach phone number, check account balance, and update how incoming calls are answered. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The skill can give an agent real-world calling and call-answering authority. <br>
Mitigation: Require explicit user approval before each outbound call, scheduled polling setup, or inbound answering prompt change. <br>
Risk: Phone tasks can expose phone numbers, caller details, transcripts, recordings, and inbound messages. <br>
Mitigation: Use the skill only when the user trusts PollyReach with this data, and avoid regulated or sensitive conversations unless consent and recording requirements are understood. <br>
Risk: Stored credentials allow access to the user's PollyReach account and phone capabilities. <br>
Mitigation: Store the token only in the configured credentials file with restricted permissions, remove it when access should be revoked, and know how to disable the phone number. <br>


## Reference(s): <br>
- [ClawHub PollyReach skill page](https://clawhub.ai/pollyreach/pollyreach) <br>
- [PollyReach homepage](https://pollyreach.ai) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown guidance with shell command invocations and JSON API responses] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Uses PollyReach API calls and a local credentials file to activate service, send call tasks, poll call results, check balance, retrieve inbound messages, and update inbound prompts.] <br>

## Skill Version(s): <br>
1.0.3 (source: server evidence and frontmatter) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
