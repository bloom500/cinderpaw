## Description: <br>
Multi search engine integration with 16 engines (7 CN + 9 Global). Supports advanced search operators, time filters, site search, privacy engines, and WolframAlpha knowledge queries. No API keys required. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[gpyangyoujun](https://clawhub.ai/user/gpyangyoujun) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
Developers and agents use this skill to route Chinese and international search queries across multiple public search engines, apply common search operators and time filters, and aggregate results into a concise search report. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Search terms, IP/request metadata, and any in-memory session cookies may be sent to selected third-party search engines. <br>
Mitigation: Avoid secrets, credentials, confidential business topics, regulated data, and highly sensitive personal searches unless provider routing and privacy expectations are reviewed. <br>
Risk: The server security review says the privacy wording understates that user queries are sent to third-party search engines. <br>
Mitigation: Make third-party query sharing clear to users and restrict use to searches appropriate for the selected providers' terms and privacy practices. <br>


## Reference(s): <br>
- [Domestic Search Guide](references/advanced-search.md) <br>
- [International Search Guide](references/international-search.md) <br>
- [ClawHub Skill Page](https://clawhub.ai/gpyangyoujun/multi-search-engine) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, code, guidance] <br>
**Output Format:** [Markdown with inline web_fetch examples and summarized search results] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Routes queries to selected third-party search engines and may use short-lived in-memory session cookies when access is denied.] <br>

## Skill Version(s): <br>
2.1.3 (source: server release metadata) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
