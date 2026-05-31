## Description: <br>
Query Polymarket prediction markets. Check odds, find trending markets, search events, track price movements. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[joelchance](https://clawhub.ai/user/joelchance) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
External users and developers use this skill to inspect Polymarket prediction-market data, monitor watchlists and alerts, review market momentum, and track local paper-trading positions without real trades. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Local watchlists and paper-trading state can persist under ~/.polymarket after use. <br>
Mitigation: Review and remove ~/.polymarket files when the skill is no longer needed. <br>
Risk: Suggested cron usage can run market checks repeatedly if configured by the user. <br>
Mitigation: Review cron entries before enabling them and remove those entries to stop recurring execution. <br>
Risk: External Polymarket guides and market data can be mistaken for financial advice. <br>
Mitigation: Treat the skill as a read-only market-data and local paper-trading helper, not as vetted financial guidance. <br>


## Reference(s): <br>
- [ClawHub Skill Page](https://clawhub.ai/joelchance/polymarket-trade) <br>
- [Polymarket](https://polymarket.com) <br>
- [Polymarket API Documentation](https://docs.polymarket.com) <br>
- [Polymarket Gamma API](https://gamma-api.polymarket.com) <br>
- [Step-by-Step Guide](https://telegra.ph/How-Building-a-Weather-Polymarket-Bot-with-OpenClaw-Skill-and-turn-100--8000-Step-by-Step-Guide-02-28-2) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown and terminal text from Python CLI commands] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May write local watchlist and paper-portfolio JSON state under ~/.polymarket.] <br>

## Skill Version(s): <br>
1.0.6 (source: server-resolved release evidence) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
