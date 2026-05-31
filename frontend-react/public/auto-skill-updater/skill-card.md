## Description: <br>
Automatically update Clawdbot and all installed skills once daily. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[maximeprades](https://clawhub.ai/user/maximeprades) <br>

### License/Terms of Use: <br>


## Use Case: <br>
Developers and Clawdbot users use this skill to configure unattended daily checks that update Clawdbot and installed skills, then report what changed or failed. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Unattended daily updates can change Clawdbot and all installed skills without per-update approval. <br>
Mitigation: Enable the skill only when automatic updates are intended; consider dry-run or notification-only operation and pin critical skills. <br>
Risk: A failed or incompatible update can interrupt the user's Clawdbot or skill workflow. <br>
Mitigation: Review the delivered update summary, keep the documented cron removal command available, and run manual repair commands when the summary reports errors. <br>


## Reference(s): <br>
- [Agent Implementation Guide](references/agent-guide.md) <br>
- [Update Summary Examples](references/summary-examples.md) <br>
- [Clawdbot Updating Guide](https://docs.clawd.bot/install/updating) <br>
- [ClawdHub CLI](https://docs.clawd.bot/tools/clawdhub) <br>
- [Cron Jobs](https://docs.clawd.bot/cron) <br>


## Skill Output: <br>
**Output Type(s):** [Markdown, Shell commands, Configuration, Guidance] <br>
**Output Format:** [Markdown with inline bash and JSON code blocks] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May include cron schedules, update commands, version summaries, and error-handling guidance.] <br>

## Skill Version(s): <br>
1.0.0 (source: server evidence and SKILL.md metadata) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
