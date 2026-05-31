## Description: <br>
Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[steipete](https://clawhub.ai/user/steipete) <br>

### License/Terms of Use: <br>


## Use Case: <br>
Developers and engineers use this skill to have an agent operate GitHub through the local `gh` CLI for pull requests, issues, workflow runs, and advanced GitHub API queries. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The skill can guide an agent to use the local GitHub CLI with the permissions of the current `gh` login. <br>
Mitigation: Check `gh auth status`, use least-privileged GitHub access, and review commands that post, edit, merge, delete, or call `gh api` beyond simple read-only queries. <br>
Risk: Running GitHub commands without an explicit repository can target the wrong repository outside a git working directory. <br>
Mitigation: Specify `--repo owner/repo` when not in the intended git directory, or use explicit GitHub URLs. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/steipete/github) <br>
- [Publisher profile](https://clawhub.ai/user/steipete) <br>


## Skill Output: <br>
**Output Type(s):** [Shell commands, API Calls, Markdown, Guidance] <br>
**Output Format:** [Markdown with inline bash code blocks] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Commands rely on the user's local GitHub CLI authentication and repository access.] <br>

## Skill Version(s): <br>
1.0.0 (source: ClawHub release metadata) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
