## Description: <br>
Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[steipete](https://clawhub.ai/user/steipete) <br>

### License/Terms of Use: <br>


## Use Case: <br>
Developers and operators use this skill to set up and run gog commands for Gmail, Calendar, Drive, Contacts, Sheets, and Docs workflows from an agent session. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: OAuth credentials and Google Workspace account access can expose sensitive mail, calendar, drive, contact, sheet, or document data. <br>
Mitigation: Store client_secret.json outside shared repositories, use the narrowest OAuth scopes and account needed, and install only when the gog CLI is trusted. <br>
Risk: Commands may send email, create events, modify Sheets or Drive data, or expose account data through logs. <br>
Mitigation: Review commands before executing changes, prefer non-interactive JSON output for scripts, and avoid exposing --json output or GOG_ACCOUNT values in logs. <br>


## Reference(s): <br>
- [Gog homepage](https://gogcli.sh) <br>
- [ClawHub skill page](https://clawhub.ai/steipete/gog) <br>


## Skill Output: <br>
**Output Type(s):** [guidance, shell commands, configuration] <br>
**Output Format:** [Markdown with inline shell commands] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Includes OAuth setup notes and examples for command-line use.] <br>

## Skill Version(s): <br>
1.0.0 (source: server release metadata) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
