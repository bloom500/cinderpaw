## Description: <br>
Work with Obsidian vaults (plain Markdown notes) and automate via obsidian-cli. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[steipete](https://clawhub.ai/user/steipete) <br>

### License/Terms of Use: <br>


## Use Case: <br>
Developers, agents, and Obsidian users use this skill to locate vaults, search notes, create notes, and perform note refactors with obsidian-cli while preserving plain Markdown workflows. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The skill can guide an agent to read Obsidian vault configuration and user-directed note contents. <br>
Mitigation: Use it only for vaults and notes the user has intentionally selected, and avoid exposing sensitive note content outside the local task context. <br>
Risk: Move and delete commands can make real changes to important vault contents. <br>
Mitigation: Confirm vault names and note paths before running mutation commands, and keep backups or version control for important vaults. <br>
Risk: The skill depends on obsidian-cli from the yakitrak Homebrew tap. <br>
Mitigation: Install it only when the user trusts that tap and accepts the third-party CLI dependency. <br>


## Reference(s): <br>
- [Obsidian Help](https://help.obsidian.md) <br>
- [ClawHub Skill Page](https://clawhub.ai/steipete/obsidian) <br>


## Skill Output: <br>
**Output Type(s):** [guidance, shell commands, configuration, markdown] <br>
**Output Format:** [Markdown with inline shell commands] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May reference local Obsidian vault paths and user-directed note contents.] <br>

## Skill Version(s): <br>
1.0.0 (source: server release evidence) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
