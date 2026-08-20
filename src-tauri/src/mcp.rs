//! MCP (Model Context Protocol) — "Extensions" backend: config + catalog +
//! sidecar proxy.
//!
//! R5 (docs/2026-07-09-v1-architecture-hardening-spec.md): live MCP
//! connections are owned by the Bun sidecar (`CinderpawAgent/src/sandbox/
//! mcp-manager.ts`) so the AGENT can call MCP tools and no server is ever
//! double-spawned by two clients. This module keeps what is genuinely the
//! desktop host's job:
//!   - the curated catalog and install flow (command lines are built HERE,
//!     never by the frontend),
//!   - persistence of `~/.feral/mcp.json` (secrets stay in the backend),
//!   - proxying the Extensions page's live queries to the sidecar over the
//!     stdin protocol (`mcp_reload` / `mcp_status` / `mcp_list_tools` /
//!     `mcp_call_tool` → one id-correlated `mcp_result` line back).
//!
//! Design rules unchanged (non-technical-first, see docs/32):
//!   - The frontend NEVER sees transports, JSON-RPC, raw `serde_json::Value`
//!     results, internal paths, or secrets. Only display-safe view structs.
//!   - Errors are humanized before they cross the IPC boundary.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::paths;

// ---------------------------------------------------------------------------
// Persisted config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    /// Executable + args. Built by the backend from the catalog entry —
    /// never edited by the frontend directly (Developer level may set a
    /// custom command via `mcp_install_custom`).
    pub command: String,
    pub args: Vec<String>,
    /// Env vars (API keys etc.). Stay in the backend; never sent to React.
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub enabled: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct McpConfigFile {
    servers: Vec<McpServerConfig>,
}

fn config_path() -> PathBuf {
    paths::feral_dir().join("mcp.json")
}

fn load_config() -> McpConfigFile {
    let path = config_path();
    cinderpaw_core::atomic_file::read_json_or_report(&path, "your installed extensions")
}

fn save_config(cfg: &McpConfigFile) -> Result<(), String> {
    let path = config_path();
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    // Secret: an MCP server's config carries the API keys it was installed
    // with. Atomic so a crash cannot leave an unparseable file that takes every
    // installed extension down with it on the next boot.
    cinderpaw_core::atomic_file::write_secret_atomic(&path, raw.as_bytes())
        .map_err(|e| format!("Couldn't save extension settings: {e}"))
}

// ---------------------------------------------------------------------------
// Curated catalog
// ---------------------------------------------------------------------------

/// A config value the user must (or may) provide at install time.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct McpConfigField {
    pub key: String,
    /// Human label, e.g. "GitHub personal access token".
    pub label: String,
    /// True for API keys/tokens — rendered as a password field.
    pub secret: bool,
    /// True when install can proceed without it.
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct McpCatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    /// Emoji used as the card icon.
    pub icon: String,
    /// URL to an official brand logo. When set, the UI shows this image instead of the emoji.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub fields: Vec<McpConfigField>,
    /// True when connecting opens a browser for the user to sign in.
    ///
    /// These extensions have no API key to paste: the publisher hosts the
    /// service and authorises Cinderpaw through the browser instead. The UI has to
    /// say so BEFORE the install starts — an unexplained browser window
    /// appearing is indistinguishable from something going wrong, and the user
    /// has to know to go and finish the login or the install just times out.
    pub browser_login: bool,
}

struct CatalogDef {
    entry: McpCatalogEntry,
    /// (command, args). `{key}` placeholders are replaced with field values.
    command: &'static str,
    args: &'static [&'static str],
    /// Field keys that become env vars instead of args.
    env_keys: &'static [&'static str],
    /// Fixed env vars the server needs that the user is never asked about
    /// (mode flags and the like). Never secrets — those go through `env_keys`.
    static_env: &'static [(&'static str, &'static str)],
}

/// The curated store.
///
/// Every entry here has been launched and has completed a real MCP
/// `initialize` handshake — not merely looked up on a registry. That bar
/// exists because the catalog previously shipped 29 entries whose packages
/// had never existed at all, plus several whose package existed but whose
/// command line was wrong (`server-pdf` defaults to an HTTP listener and
/// needs `--stdio`; `xcodebuildmcp` needs an `mcp` subcommand;
/// `mcp-server-cloudflare` needs `run <account>`; Salesforce reads
/// `SALESFORCE_*` and we were setting `SF_*`). Every one of those failed
/// identically from the user's side — install, spinner, "something went
/// wrong" — so no amount of care in the UI could have told them apart.
///
/// Rules for adding an entry, learned the expensive way:
///   - Pin an exact version. `npx -y pkg` without one re-resolves against the
///     registry on every spawn, so what runs is whatever the publisher pushed
///     last, not what was reviewed here. `every_npx_catalog_entry_pins_an_exact_version`
///     enforces it.
///   - Prefer the publisher's own package. A third-party republish of someone
///     else's server is a supply-chain risk we would be handing to people who
///     cannot evaluate it.
///   - Ask only for things the user can paste from the service's own settings
///     page. "Path to OAuth credentials JSON" means "go create a Google Cloud
///     project", which is not a field, it is a project.
///     `catalog_never_asks_the_user_for_a_credentials_file` enforces it.
///   - Run `node scripts/check-mcp-catalog.mjs --spawn` before shipping a
///     change here. It is the only check that catches a package which exists
///     and still cannot start.
fn catalog() -> Vec<CatalogDef> {
    let f = |key: &str, label: &str, secret: bool, optional: bool| McpConfigField {
        key: key.into(),
        label: label.into(),
        secret,
        optional,
    };
    let logo = |url: &'static str| -> Option<String> { Some(url.into()) };

    // Services whose publisher no longer ships an installable server and
    // hosts one instead. `mcp-remote` bridges their HTTP endpoint onto the
    // stdio transport the sidecar speaks, and runs the browser sign-in.
    //
    // Vercel is deliberately absent despite hosting one: their MCP only
    // accepts AI clients Vercel has reviewed and approved, and Cinderpaw is not
    // on that list, so the card would fail for every user at the consent
    // screen. The rest use open Dynamic Client Registration.
    //
    // The bridge version is written out at each entry rather than hoisted into
    // a constant: these specs are the thing that gets audited, and an auditor
    // (human or `scripts/check-mcp-catalog.mjs`) should not have to resolve a
    // binding to find out what actually runs.

    vec![
        // ── Files ─────────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "filesystem".into(),
                name: "File Access".into(),
                description: "Let the assistant read and organize files in a folder you choose.".into(),
                category: "Files".into(),
                icon: "📁".into(),
                logo_url: None,
                fields: vec![f("FOLDER", "Folder the assistant may access", false, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-filesystem@2026.7.10", "{FOLDER}"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "pdf".into(),
                name: "PDF Reader".into(),
                description: "Extract and search text from PDF documents.".into(),
                category: "Files".into(),
                icon: "📄".into(),
                logo_url: None,
                fields: vec![f("PDF_DIR", "Folder containing your PDFs", false, false)],
                browser_login: false,
            },
            command: "npx",
            // `--stdio` is not optional: without it this server starts an HTTP
            // listener, prints "Ready" to stderr and never answers the
            // handshake — which reads as a hang, not as a misconfiguration.
            args: &["-y", "@modelcontextprotocol/server-pdf@1.7.5", "--stdio", "{PDF_DIR}"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "excel".into(),
                name: "Excel / CSV".into(),
                description: "Read and analyze Excel spreadsheets and CSV files.".into(),
                category: "Files".into(),
                icon: "📊".into(),
                logo_url: logo("https://www.microsoft.com/favicon.ico"),
                // Takes the file path per request, so there is nothing to set up.
                fields: vec![],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@negokaz/excel-mcp-server@0.12.0"],
            env_keys: &[],
            static_env: &[],
        },
        // ── Productivity ──────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "memory".into(),
                name: "Long-term Memory".into(),
                description: "A knowledge notebook the assistant can use to remember things between chats.".into(),
                category: "Productivity".into(),
                icon: "🧠".into(),
                logo_url: None,
                fields: vec![],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-memory@2026.7.4"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "sequential-thinking".into(),
                name: "Deep Reasoning".into(),
                description: "Helps the assistant think through hard problems step by step.".into(),
                category: "Productivity".into(),
                icon: "🪜".into(),
                logo_url: None,
                fields: vec![],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "todoist".into(),
                name: "Todoist".into(),
                description: "Manage your Todoist tasks, projects, and reminders.".into(),
                category: "Productivity".into(),
                icon: "🔴".into(),
                logo_url: logo("https://todoist.com/favicon.ico"),
                fields: vec![f("TODOIST_API_KEY", "Todoist API token", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@doist/todoist-mcp@12.5.7"],
            env_keys: &["TODOIST_API_KEY"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "notion".into(),
                name: "Notion".into(),
                description: "Read and write pages, databases, and content in Notion.".into(),
                category: "Productivity".into(),
                icon: "📓".into(),
                logo_url: logo("https://www.notion.so/favicon.ico"),
                fields: vec![f("NOTION_API_TOKEN", "Notion API token", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@notionhq/notion-mcp-server@2.5.1"],
            env_keys: &["NOTION_API_TOKEN"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "linear".into(),
                name: "Linear".into(),
                description: "Manage Linear issues, cycles, and projects.".into(),
                category: "Productivity".into(),
                icon: "📐".into(),
                logo_url: logo("https://linear.app/favicon.ico"),
                fields: vec![],
                browser_login: true,
            },
            command: "npx",
            args: &["-y", "mcp-remote@0.1.38", "https://mcp.linear.app/mcp"],
            env_keys: &[],
            static_env: &[],
        },
        // ── Developer ─────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "github".into(),
                name: "GitHub".into(),
                description: "Work with your GitHub repositories: issues, pull requests, code search.".into(),
                category: "Developer".into(),
                icon: "🐙".into(),
                logo_url: logo("https://github.com/favicon.ico"),
                fields: vec![f(
                    "GITHUB_PERSONAL_ACCESS_TOKEN",
                    "GitHub personal access token",
                    true,
                    false,
                )],
                browser_login: false,
            },
            command: "npx",
            // Marked deprecated upstream, but it starts, it works, and it takes
            // a token the user can paste. GitHub's replacement is a hosted
            // server behind a browser sign-in; swap to that when we have a
            // reason to, not because npm prints a warning.
            args: &["-y", "@modelcontextprotocol/server-github@2025.4.8"],
            env_keys: &["GITHUB_PERSONAL_ACCESS_TOKEN"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "supabase".into(),
                name: "Supabase".into(),
                description: "Query and manage your Supabase database and storage.".into(),
                category: "Developer".into(),
                icon: "⚡".into(),
                logo_url: logo("https://supabase.com/favicon/favicon-32x32.png"),
                fields: vec![f("SUPABASE_ACCESS_TOKEN", "Supabase personal access token", true, false)],
                browser_login: false,
            },
            command: "npx",
            // The key travels in the environment, never in the arguments: a
            // command line is readable by every process on the machine.
            args: &["-y", "@supabase/mcp-server-supabase@0.10.0"],
            env_keys: &["SUPABASE_ACCESS_TOKEN"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "cloudflare".into(),
                name: "Cloudflare".into(),
                description: "Manage Cloudflare Workers, DNS, and KV storage.".into(),
                category: "Developer".into(),
                icon: "☁️".into(),
                logo_url: logo("https://www.cloudflare.com/favicon.ico"),
                fields: vec![
                    f("CLOUDFLARE_API_TOKEN", "Cloudflare API token", true, false),
                    f("CLOUDFLARE_ACCOUNT_ID", "Account ID", false, false),
                ],
                browser_login: false,
            },
            command: "npx",
            // `run <account>` — without the subcommand this exits immediately
            // with "Unknown command: undefined".
            args: &["-y", "@cloudflare/mcp-server-cloudflare@0.2.0", "run", "{CLOUDFLARE_ACCOUNT_ID}"],
            env_keys: &["CLOUDFLARE_API_TOKEN"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "chrome-devtools".into(),
                name: "Chrome DevTools".into(),
                description: "Inspect, debug, and profile Chrome tabs from the assistant.".into(),
                category: "Developer".into(),
                icon: "🔧".into(),
                logo_url: logo("https://www.google.com/chrome/static/images/chrome-logo.svg"),
                fields: vec![],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "chrome-devtools-mcp@1.7.0"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "xcodebuild".into(),
                name: "Xcode Build".into(),
                description: "Build, test, and manage Xcode projects from the assistant.".into(),
                category: "Developer".into(),
                icon: "🔨".into(),
                logo_url: logo("https://developer.apple.com/favicon.ico"),
                fields: vec![],
                browser_login: false,
            },
            command: "npx",
            // The bare command prints usage and exits; `mcp` is the server.
            args: &["-y", "xcodebuildmcp@2.7.0", "mcp"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "postgres".into(),
                name: "PostgreSQL".into(),
                description: "Query and manage a PostgreSQL database.".into(),
                category: "Developer".into(),
                icon: "🐘".into(),
                logo_url: logo("https://www.postgresql.org/favicon.ico"),
                fields: vec![f("POSTGRES_URL", "PostgreSQL connection URL", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@henkey/postgres-mcp-server@1.0.7", "--connection-string", "{POSTGRES_URL}"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "kubernetes".into(),
                name: "Kubernetes".into(),
                description: "Manage Kubernetes clusters, pods, and deployments.".into(),
                category: "Developer".into(),
                icon: "☸️".into(),
                logo_url: logo("https://kubernetes.io/images/favicon.png"),
                // Reads the kubeconfig already on the machine.
                fields: vec![],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "mcp-server-kubernetes@4.1.4"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "jira".into(),
                name: "Jira & Confluence".into(),
                description: "Manage Jira issues, projects, and Confluence pages.".into(),
                category: "Developer".into(),
                icon: "🔵".into(),
                logo_url: logo("https://www.atlassian.com/favicon.ico"),
                fields: vec![],
                browser_login: true,
            },
            command: "npx",
            args: &["-y", "mcp-remote@0.1.38", "https://mcp.atlassian.com/v1/sse"],
            env_keys: &[],
            static_env: &[],
        },
        // ── Internet ──────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "playwright".into(),
                name: "Web Browser".into(),
                description: "Let the assistant open web pages, click around, and take screenshots.".into(),
                category: "Internet".into(),
                icon: "🌐".into(),
                logo_url: logo("https://playwright.dev/img/playwright-logo.svg"),
                fields: vec![],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@playwright/mcp@0.0.79"],
            env_keys: &[],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "brave-search".into(),
                name: "Web Search (Brave)".into(),
                description: "Search the internet with Brave Search.".into(),
                category: "Internet".into(),
                icon: "🔎".into(),
                logo_url: logo("https://brave.com/static-assets/images/brave-favicon.png"),
                fields: vec![f("BRAVE_API_KEY", "Brave Search API key", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@brave/brave-search-mcp-server@2.1.0"],
            env_keys: &["BRAVE_API_KEY"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "firecrawl".into(),
                name: "Firecrawl".into(),
                description: "Crawl and extract content from any website.".into(),
                category: "Internet".into(),
                icon: "🔥".into(),
                logo_url: logo("https://www.firecrawl.dev/favicon.ico"),
                fields: vec![f("FIRECRAWL_API_KEY", "Firecrawl API key", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "firecrawl-mcp@3.24.0"],
            env_keys: &["FIRECRAWL_API_KEY"],
            static_env: &[],
        },
        // ── CRM & Sales ───────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "hubspot".into(),
                name: "HubSpot".into(),
                description: "Manage HubSpot contacts, deals, and CRM pipelines.".into(),
                category: "CRM & Sales".into(),
                icon: "🧡".into(),
                logo_url: logo("https://www.hubspot.com/favicon.ico"),
                fields: vec![f("PRIVATE_APP_ACCESS_TOKEN", "HubSpot private app access token", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@hubspot/mcp-server@0.4.0"],
            env_keys: &["PRIVATE_APP_ACCESS_TOKEN"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "stripe".into(),
                name: "Stripe".into(),
                description: "Manage Stripe payments, customers, and subscriptions.".into(),
                category: "CRM & Sales".into(),
                icon: "💳".into(),
                logo_url: logo("https://stripe.com/favicon.ico"),
                fields: vec![f("STRIPE_SECRET_KEY", "Stripe secret key", true, false)],
                browser_login: false,
            },
            command: "npx",
            // 0.2.x is the local server. 0.3.x is a thin proxy to Stripe's
            // hosted MCP that cannot even start without a live key, so it
            // fails the install for anyone typing a key with a typo in it.
            args: &["-y", "@stripe/mcp@0.2.3", "--tools=all"],
            env_keys: &["STRIPE_SECRET_KEY"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "salesforce".into(),
                name: "Salesforce".into(),
                description: "Query and update Salesforce CRM records.".into(),
                category: "CRM & Sales".into(),
                icon: "☁️".into(),
                logo_url: logo("https://www.salesforce.com/favicon.ico"),
                fields: vec![
                    f("SALESFORCE_USERNAME", "Salesforce username", false, false),
                    f("SALESFORCE_PASSWORD", "Salesforce password", true, false),
                    f("SALESFORCE_TOKEN", "Security token", true, false),
                ],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "@tsmztech/mcp-server-salesforce@0.0.7"],
            env_keys: &["SALESFORCE_USERNAME", "SALESFORCE_PASSWORD", "SALESFORCE_TOKEN"],
            // Without this the server picks a different auth strategy and the
            // username/password it was just given are never used.
            static_env: &[("SALESFORCE_CONNECTION_TYPE", "User_Password")],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "intercom".into(),
                name: "Intercom".into(),
                description: "Manage Intercom conversations, contacts, and support tickets.".into(),
                category: "CRM & Sales".into(),
                icon: "💬".into(),
                logo_url: logo("https://www.intercom.com/favicon.ico"),
                fields: vec![],
                browser_login: true,
            },
            command: "npx",
            args: &["-y", "mcp-remote@0.1.38", "https://mcp.intercom.com/mcp"],
            env_keys: &[],
            static_env: &[],
        },
        // ── Data ──────────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "airtable".into(),
                name: "Airtable".into(),
                description: "Read and write records in your Airtable bases.".into(),
                category: "Data".into(),
                icon: "🟡".into(),
                logo_url: logo("https://airtable.com/favicon.ico"),
                fields: vec![f("AIRTABLE_API_KEY", "Airtable personal access token", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "airtable-mcp-server@1.14.0"],
            env_keys: &["AIRTABLE_API_KEY"],
            static_env: &[],
        },
        // ── AI & Media ────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "replicate".into(),
                name: "Replicate".into(),
                description: "Run AI models for images, video, audio, and more via Replicate.".into(),
                category: "AI & Media".into(),
                icon: "🖼️".into(),
                logo_url: logo("https://replicate.com/favicon.ico"),
                fields: vec![f("REPLICATE_API_TOKEN", "Replicate API token", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "replicate-mcp@0.9.0"],
            env_keys: &["REPLICATE_API_TOKEN"],
            static_env: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "higgsfield".into(),
                name: "Higgsfield AI".into(),
                description: "Generate cinematic AI videos with Higgsfield.".into(),
                category: "AI & Media".into(),
                icon: "🎬".into(),
                logo_url: logo("https://higgsfield.ai/favicon.ico"),
                fields: vec![f("HIGGSFIELD_API_KEY", "Higgsfield API key", true, false)],
                browser_login: false,
            },
            command: "npx",
            args: &["-y", "higgsfield-mcp@0.2.0"],
            env_keys: &["HIGGSFIELD_API_KEY"],
            static_env: &[],
        },
        // Communication channels (Discord, Slack, Telegram, WhatsApp) live in
        // the dedicated Connectors section — not here. See connectors.rs.
        //
        // Deliberately absent, and why, so nobody re-adds them from memory:
        //   - Google Drive / Calendar / Gmail: every npm server for these wants
        //     an OAuth client-credentials JSON, i.e. a Google Cloud project.
        //     There is no key to paste, so there is no honest card to show.
        //   - Vercel: hosted MCP, but restricted to AI clients Vercel has
        //     approved. Cinderpaw is not one, so it would fail at the consent screen.
        //   - AWS, Docker, ElevenLabs, Google Analytics: no maintained Node
        //     server exists. The official ones are Python (uvx) or a desktop
        //     plugin, neither of which this install flow can offer.
        //   - Clamp Analytics: the package is real and does work, but it verifies
        //     its API key against Clamp's servers before it will start, so
        //     `check-mcp-catalog.mjs --spawn` can never clear it without a live
        //     account. An entry nobody can re-verify is an entry that rots quietly.
        //   - MindMeister, MeisterTask, Superlist, Chipp, Karea, Chain Signer,
        //     HomeLab Monitor, Cal.com, SQLite, Mixpanel, GoHighLevel: no
        //     package exists at all, or only an abandoned third-party one with
        //     double-digit weekly downloads. They were listed here for months
        //     and could never have worked.
    ]
}

// ---------------------------------------------------------------------------
// Display-safe views (what the frontend is allowed to see)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct McpServerView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    pub enabled: bool,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct McpToolView {
    pub name: String,
    pub description: String,
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/// Reject command/args carrying cmd.exe metacharacters BEFORE they are ever
/// persisted to `mcp.json`. The sidecar spawns servers via `cmd /c` on
/// Windows (npx/node are `.cmd` shims), and cmd.exe re-parses its command
/// line, so a config carrying `&`, `|`, `<`, `>`, `^`, `%` or newlines could
/// chain arbitrary commands — a BatBadBut-style hole (CVE-2024-24576).
/// Legitimate stdio MCP servers use plain tokens (package names, flags,
/// paths), so this never trips on real configs. `(`/`)` are deliberately NOT
/// blocked — they appear in legitimate Windows paths
/// (`C:\Program Files (x86)\…`).
///
/// Enforced on every platform at install time (configs travel with user
/// profiles), and enforced AGAIN at spawn time in the sidecar
/// (`CinderpawAgent/src/sandbox/mcp-manager.ts` `hasWindowsMetachars`) —
/// defense-in-depth; neither layer may be relaxed without a security review.
fn validate_config_tokens(command: &str, args: &[String]) -> Result<(), String> {
    let bad = |s: &str| {
        s.chars().any(|c| {
            matches!(c, '&' | '|' | '<' | '>' | '^' | '%' | '\n' | '\r' | '\0')
        })
    };
    if bad(command) || args.iter().any(|a| bad(a)) {
        return Err(
            "This extension's command contains characters that aren't allowed for security reasons."
                .to_string(),
        );
    }
    Ok(())
}

/// Send one MCP op to the sidecar and wait for its id-correlated
/// `mcp_result` line. Same discipline as `governance_roundtrip` in
/// `cinderpaw-core/src/api.rs`: subscribe the runtime event bus FIRST, then
/// send, then filter `cinderpaw://agent-output` lines for our reply. The
/// desktop bus is fed by `TauriEvents` (lib.rs), which fans every host
/// event onto `runtime.events_tx`.
async fn sidecar_roundtrip(
    state: &crate::AppState,
    mut payload: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let tx = {
        let guard = state.cinderpaw_agent_tx.lock();
        guard.as_ref().cloned()
    }
    .ok_or_else(|| "Cinderpaw is still starting up — try again in a moment.".to_string())?;

    let msg_id = uuid::Uuid::new_v4().to_string();
    payload["id"] = serde_json::Value::String(msg_id.clone());
    let mut rx = state.runtime.events_tx.subscribe();
    tx.send(payload.to_string())
        .await
        .map_err(|_| "Cinderpaw is still starting up — try again in a moment.".to_string())?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(humanize("timed out"));
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) => {
                if ev.event != "cinderpaw://agent-output" {
                    continue;
                }
                let Some(line) = ev.payload.get("data").and_then(|s| s.as_str()) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                if v.get("type").and_then(|t| t.as_str()) == Some("mcp_result")
                    && v.get("id").and_then(|i| i.as_str()) == Some(msg_id.as_str())
                {
                    return Ok(v);
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return Err(humanize("closed")),
            Err(_) => return Err(humanize("timed out")),
        }
    }
}

/// Ask the sidecar to re-reconcile `mcp.json` and return the per-server
/// status rows from its reply (`running` / `toolCount` / `error` by id).
async fn reload_and_status(
    state: &crate::AppState,
    timeout: std::time::Duration,
) -> Result<HashMap<String, (bool, Option<String>)>, String> {
    let v = sidecar_roundtrip(state, serde_json::json!({ "type": "mcp_reload" }), timeout).await?;
    let mut out = HashMap::new();
    if let Some(rows) = v.get("servers").and_then(|s| s.as_array()) {
        for row in rows {
            let Some(id) = row.get("id").and_then(|i| i.as_str()) else {
                continue;
            };
            let running = row.get("running").and_then(|r| r.as_bool()).unwrap_or(false);
            let error = row
                .get("error")
                .and_then(|e| e.as_str())
                .map(|s| s.to_string());
            out.insert(id.to_string(), (running, error));
        }
    }
    Ok(out)
}

/// Reload timeout: the first connect of an npx-based extension cold-downloads
/// the package from npm before the server prints a single byte, which on a
/// fresh machine over an ordinary connection takes tens of seconds — and the
/// sidecar reconciles servers sequentially. The sidecar's per-server init
/// budget is 90 s (`mcp-client.ts` initTimeoutMs); this must exceed it, or
/// the desktop gives up first and reports a timeout for an extension that
/// was still downloading and would have worked.
const RELOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(150);

/// Reload timeout for an extension whose sign-in happens in a browser.
///
/// The clock is not measuring software here, it is measuring a person: find
/// the window the bridge just opened, sign in, possibly do two-factor, pick a
/// workspace, press Approve. Two and a half minutes is nowhere near enough for
/// that, and running out means the install fails for someone who did nothing
/// wrong and was, in fact, halfway through doing it right.
const BROWSER_LOGIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Translate transport/protocol errors into messages a non-technical user
/// can act on. The raw error is logged for diagnostics, never displayed.
fn humanize(raw: &str) -> String {
    tracing::warn!("MCP error: {raw}");
    let lower = raw.to_lowercase();
    // Now that the sidecar forwards the server's own stderr, npm's real
    // complaint is readable here. A package that 404s will NEVER start, so
    // "try again in a minute" would be a lie — say it's gone instead.
    if lower.contains("404") || lower.contains("is not in this registry") || lower.contains("e404") {
        return "This extension is no longer available from its publisher. Please remove it.".into();
    }
    if lower.contains("program not found") || lower.contains("no such file") || lower.contains("spawn failed")
        || lower.contains("not recognized as an internal") || lower.contains("command not found")
    {
        return "This extension needs Node.js installed. Install it from nodejs.org and try again.".into();
    }
    if lower.contains("closed") || lower.contains("eof") || lower.contains("broken pipe") {
        return "The extension stopped unexpectedly. Try turning it off and on again.".into();
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "The extension took too long to respond. It may still be downloading — try again in a minute.".into();
    }
    if lower.contains("401") || lower.contains("unauthorized") || lower.contains("invalid api key") {
        return "The access key for this extension doesn't work. Check it in Configure.".into();
    }
    "Something went wrong with this extension. Turning it off and on again usually helps.".into()
}

/// Put `previous` back and re-reconcile, so a change that failed to come up
/// leaves no trace in `mcp.json`.
///
/// Without this, `mcp_install` / `mcp_set_enabled` committed the config
/// BEFORE the server was proven to start: the user got an error toast *and*
/// a permanent "Installed", enabled card for something that never ran, and
/// every boot re-attempted the dead server forever. On a fresh machine that
/// is the first thing a mistyped key or an unavailable extension does.
/// Best-effort by design — restoring the file is what matters; the sidecar
/// poke is a courtesy (it reconciles from the file at next boot anyway).
async fn rollback(state: &crate::AppState, previous: &McpConfigFile) {
    let _ = save_config(previous);
    let _ = reload_and_status(state, QUERY_TIMEOUT).await;
}

fn view_of(cfg: &McpServerConfig, running: bool) -> McpServerView {
    // Resolve icon and logo_url from the catalog so configs don't need to store them.
    let catalog_entry = catalog().into_iter().find(|d| d.entry.id == cfg.id);
    let icon = catalog_entry.as_ref()
        .map(|d| d.entry.icon.clone())
        .unwrap_or_else(|| "🧩".to_string());
    let logo_url = catalog_entry.and_then(|d| d.entry.logo_url.clone());
    McpServerView {
        id: cfg.id.clone(),
        name: cfg.name.clone(),
        description: cfg.description.clone(),
        category: cfg.category.clone(),
        icon,
        logo_url,
        enabled: cfg.enabled,
        running,
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// The curated "store" the user can install from.
#[tauri::command]
#[specta::specta]
pub fn mcp_catalog() -> Vec<McpCatalogEntry> {
    catalog().into_iter().map(|d| d.entry).collect()
}

/// Installed servers with live status (running state queried from the
/// sidecar; sidecar unavailable → everything shows as not running, which
/// is the truth: no sidecar, no connections).
#[tauri::command]
#[specta::specta]
pub async fn mcp_list(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<McpServerView>, String> {
    let cfg = load_config();
    let running_by_id: HashMap<String, bool> = match sidecar_roundtrip(
        &state,
        serde_json::json!({ "type": "mcp_status" }),
        QUERY_TIMEOUT,
    )
    .await
    {
        Ok(v) => v
            .get("servers")
            .and_then(|s| s.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        Some((
                            row.get("id")?.as_str()?.to_string(),
                            row.get("running").and_then(|r| r.as_bool()).unwrap_or(false),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => HashMap::new(),
    };
    Ok(cfg
        .servers
        .iter()
        .map(|s| view_of(s, running_by_id.get(&s.id).copied().unwrap_or(false)))
        .collect())
}

/// One-click install from the catalog. `values` carries the user's answers
/// for the entry's config fields (keys match `McpConfigField.key`).
#[tauri::command]
#[specta::specta]
pub async fn mcp_install(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    values: HashMap<String, String>,
) -> Result<McpServerView, String> {
    let def = catalog()
        .into_iter()
        .find(|d| d.entry.id == id)
        .ok_or_else(|| "Unknown extension.".to_string())?;

    for field in &def.entry.fields {
        if !field.optional && values.get(&field.key).map(|v| v.trim().is_empty()).unwrap_or(true) {
            return Err(format!("Please fill in: {}", field.label));
        }
    }

    let args = def
        .args
        .iter()
        .map(|a| {
            let mut s = (*a).to_string();
            for (k, v) in &values {
                s = s.replace(&format!("{{{k}}}"), v);
            }
            s
        })
        .collect::<Vec<_>>();
    let mut env = def
        .env_keys
        .iter()
        .filter_map(|k| values.get(*k).map(|v| ((*k).to_string(), v.clone())))
        .collect::<HashMap<_, _>>();
    for (k, v) in def.static_env {
        env.insert((*k).to_string(), (*v).to_string());
    }

    let server = McpServerConfig {
        id: def.entry.id.clone(),
        name: def.entry.name.clone(),
        description: def.entry.description.clone(),
        category: def.entry.category.clone(),
        command: def.command.to_string(),
        args,
        env,
        enabled: true,
    };
    validate_config_tokens(&server.command, &server.args)?;

    let previous = load_config();
    let mut cfg = previous.clone();
    cfg.servers.retain(|s| s.id != server.id);
    cfg.servers.push(server.clone());
    save_config(&cfg)?;

    // An install that doesn't come up is NOT an install: undo the file so the
    // user is left exactly where they started instead of with a dead card.
    let budget = if def.entry.browser_login {
        BROWSER_LOGIN_TIMEOUT
    } else {
        RELOAD_TIMEOUT
    };
    let status = match reload_and_status(&state, budget).await {
        Ok(s) => s,
        Err(e) => {
            rollback(&state, &previous).await;
            return Err(e);
        }
    };
    match status.get(&server.id) {
        Some((true, _)) => Ok(view_of(&server, true)),
        other => {
            let raw = other.and_then(|(_, err)| err.clone());
            rollback(&state, &previous).await;
            Err(humanize(raw.as_deref().unwrap_or("closed")))
        }
    }
}

/// Toggle an installed extension on/off (connect / disconnect).
#[tauri::command]
#[specta::specta]
pub async fn mcp_set_enabled(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    enabled: bool,
) -> Result<McpServerView, String> {
    let previous = load_config();
    let mut cfg = previous.clone();
    let server = cfg
        .servers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| "This extension is not installed.".to_string())?;
    server.enabled = enabled;
    let snapshot = server.clone();
    save_config(&cfg)?;

    // Same rule as install: a switch that didn't actually turn the extension
    // on goes back to off, so the card matches reality and the next boot
    // doesn't keep re-launching a server that can't start.
    //
    // Browser-login extensions get the same long budget here as at install:
    // a cached token can expire, and then flipping the switch back on means
    // signing in again, at human speed.
    let budget = match catalog().into_iter().find(|d| d.entry.id == id) {
        Some(def) if def.entry.browser_login => BROWSER_LOGIN_TIMEOUT,
        _ => RELOAD_TIMEOUT,
    };
    let status = match reload_and_status(&state, budget).await {
        Ok(s) => s,
        Err(e) => {
            rollback(&state, &previous).await;
            return Err(e);
        }
    };
    let (running, err) = status
        .get(&id)
        .cloned()
        .unwrap_or((false, None));
    if enabled && !running {
        rollback(&state, &previous).await;
        return Err(humanize(err.as_deref().unwrap_or("closed")));
    }
    Ok(view_of(&snapshot, running))
}

/// Uninstall: disconnect and forget the config (including stored keys).
#[tauri::command]
#[specta::specta]
pub async fn mcp_remove(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.servers.retain(|s| s.id != id);
    save_config(&cfg)?;
    // Best-effort teardown poke — removal must succeed even with the
    // sidecar down (it reconciles from the file at next boot anyway).
    let _ = reload_and_status(&state, QUERY_TIMEOUT).await;
    Ok(())
}

/// What an enabled extension can do — names + descriptions only.
#[tauri::command]
#[specta::specta]
pub async fn mcp_list_tools(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<Vec<McpToolView>, String> {
    let v = sidecar_roundtrip(
        &state,
        serde_json::json!({ "type": "mcp_list_tools", "serverId": id }),
        QUERY_TIMEOUT,
    )
    .await?;
    if v.get("ok").and_then(|o| o.as_bool()) != Some(true) {
        let raw = v.get("error").and_then(|e| e.as_str()).unwrap_or("closed");
        if raw.contains("not running") {
            return Err("This extension is turned off. Turn it on first.".to_string());
        }
        return Err(humanize(raw));
    }
    Ok(v.get("tools")
        .and_then(|t| t.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(McpToolView {
                        name: row.get("name")?.as_str()?.to_string(),
                        description: row
                            .get("description")
                            .and_then(|d| d.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Call a tool on an enabled extension. `args_json` is a JSON object string;
/// the result is flattened to readable text (never a raw JSON value).
#[tauri::command]
#[specta::specta]
pub async fn mcp_call_tool(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    tool: String,
    args_json: String,
) -> Result<String, String> {
    let arguments = if args_json.trim().is_empty() {
        None
    } else {
        Some(
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&args_json)
                .map_err(|_| "The tool arguments are not valid.".to_string())?,
        )
    };

    let v = sidecar_roundtrip(
        &state,
        serde_json::json!({
            "type": "mcp_call_tool",
            "serverId": id,
            "tool": tool,
            "args": arguments.map(serde_json::Value::Object).unwrap_or_else(|| serde_json::json!({})),
        }),
        CALL_TIMEOUT,
    )
    .await?;
    if v.get("ok").and_then(|o| o.as_bool()) != Some(true) {
        let raw = v.get("error").and_then(|e| e.as_str()).unwrap_or("closed");
        if raw.contains("not running") {
            return Err("This extension is turned off. Turn it on first.".to_string());
        }
        return Err(humanize(raw));
    }
    // The sidecar already flattens MCP content blocks to plain text
    // (MCPClient.callTool) — never surface raw JSON to the user.
    let text = v
        .get("result")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    Ok(if text.is_empty() { "Done.".to_string() } else { text })
}

// ---------------------------------------------------------------------------
// Tests — pin the install-time metachar denylist (`validate_config_tokens`).
// ---------------------------------------------------------------------------
//
// The denylist is the defense-in-depth layer on top of the Rust 1.77.2+ std
// BatBadBut arg-quoting fix (CVE-2024-24576). Spawn moved to the sidecar
// (R5), which enforces the SAME set at spawn time
// (CinderpawAgent/src/sandbox/mcp-manager.ts, hasWindowsMetachars + its tests);
// this layer rejects bad tokens before they are ever persisted. Any
// character that survives this assertion would be a chain-into-arbitrary-
// command hole on Windows — these tests must NEVER be relaxed without a
// security review.

#[cfg(test)]
mod cmd_denylist_tests {
    use super::*;

    /// The exact set of rejected chars. Adding or removing one is a contract
    /// change; pinning the set here means a refactor of the validator (or its
    /// removal) fails the test instead of silently regressing.
    const DENIED: &[char] = &[
        '&', '|', '<', '>', '^', '%', '\n', '\r', '\0',
    ];

    #[test]
    fn denylist_rejects_each_metachar_in_command() {
        for &ch in DENIED {
            let s = ch.to_string();
            assert!(
                validate_config_tokens(&s, &[]).is_err(),
                "command {:?} must be rejected by the denylist",
                ch
            );
        }
    }

    #[test]
    fn denylist_rejects_each_metachar_in_args() {
        for &ch in DENIED {
            let arg = format!("pkg{}name", ch);
            assert!(
                validate_config_tokens("npx", &[arg]).is_err(),
                "arg containing {:?} must be rejected by the denylist",
                ch
            );
        }
    }

    /// Legitimate tokens must pass: package names, flags, Windows paths with
    /// parens/brackets. A "be safe, deny everything" shortcut fails here.
    #[test]
    fn denylist_allows_legitimate_tokens() {
        for (cmd, args) in [
            ("npx", vec!["-y".to_string(), "@modelcontextprotocol/server-pdf".to_string()]),
            ("node", vec!["C:\\Program Files (x86)\\thing\\server.js".to_string()]),
            ("uvx", vec!["mcp-server-git".to_string(), "--repository=.".to_string()]),
        ] {
            assert!(
                validate_config_tokens(cmd, &args).is_ok(),
                "legitimate command {:?} {:?} must not be rejected",
                cmd,
                args
            );
        }
    }

    /// Pin the DENIED set size + chars that MUST stay allowed (paths, flags,
    /// brackets).
    #[test]
    fn denylist_set_is_exactly_these_nine_chars() {
        assert_eq!(DENIED.len(), 9, "DENIED set size changed — update this test");
        for allowed in ['/', '\\', '.', '-', '_', '=', ':', ' ', '(', ')', '[', ']', ',', '@', '#', '?', '*'] {
            assert!(
                !DENIED.contains(&allowed),
                "{:?} appears in DENIED but shouldn't be",
                allowed
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests — pin catalog supply-chain (A1).
//
// Catalog entries run `npx -y <pkg>`, which on every spawn hits npm and
// downloads whatever the publisher's "latest" tag currently points at.
// Pinning every entry to an exact `@x.y.z` freezes the supply chain at
// review time: a malicious publisher push, an account takeover, or a yanked
// release can't silently change what runs on the user's machine. These
// tests are a hard guard against re-introducing `@latest` / floating tags.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod catalog_pin_tests {
    use super::*;

    /// A spec with an explicit floating dist-tag (`@latest`, `@next`, …) is
/// a supply-chain hole: those tags resolve at install time to whatever
/// the publisher's registry says is current — a publisher push, account
/// takeover, or yanked release silently changes what runs on the user's
/// machine. Pinning to an exact semver `@x.y.z` freezes the supply chain
/// at review time.
///
/// This test is the surgical regression guard for the *explicit* floating
/// tag class. Bare specs like `@scope/pkg` (no `@x.y.z`) are a separate
/// audit and are intentionally out of scope here.
    #[test]
    fn no_npx_catalog_entry_uses_an_explicit_floating_dist_tag() {
        let mut violations: Vec<String> = Vec::new();
        // npm dist-tags that float at install time. `@latest` is the one
        // we shipped with; the rest are listed so the next reviewer doesn't
        // introduce them either. `@` followed by an exact semver (`1.2.3`)
        // is fine and explicitly allowed.
        let floating_tags = [
            "@latest", "@next", "@beta", "@canary", "@nightly", "@dev", "@alpha", "@rc",
        ];
        for def in catalog() {
            if def.command != "npx" {
                continue;
            }
            for arg in def.args.iter() {
                if arg.starts_with('-') {
                    continue;
                }
                // Skip args that are user-supplied substitutions (the catalog
                // author already escaped them via `{...}`); we only police
                // literal package specs.
                if arg.contains('{') {
                    continue;
                }
                for tag in floating_tags {
                    if arg.ends_with(tag) {
                        violations.push(format!(
                            "catalog entry {:?} uses floating tag {:?} in spec {:?}",
                            def.entry.id, tag, arg
                        ));
                    }
                }
            }
        }
        assert!(
            violations.is_empty(),
            "MCP catalog supply-chain violations:\n  - {}",
            violations.join("\n  - ")
        );
    }

    /// Every npx package spec must carry an exact `@x.y.z`.
    ///
    /// A BARE spec (`@scope/pkg`, no version) is the same supply-chain hole
    /// as `@latest` wearing different clothes: `npx -y` resolves it against
    /// the registry on every single spawn, so what runs on the user's
    /// machine is whatever the publisher pushed most recently — never what
    /// was reviewed here. The floating-dist-tag test above deliberately
    /// scoped bare specs out as "a separate audit"; this is that audit,
    /// closed. It is also the guard that would have caught the 29 catalog
    /// entries that pointed at packages which had never existed at all:
    /// you cannot pin a version to a package you never looked up.
    ///
    /// Existence and startup are checked by `scripts/check-mcp-catalog.mjs`,
    /// which needs the network and so cannot live in a unit test.
    #[test]
    fn every_npx_catalog_entry_pins_an_exact_version() {
        let mut unpinned: Vec<String> = Vec::new();
        for def in catalog() {
            if def.command != "npx" {
                continue;
            }
            let Some(spec) = def
                .args
                .iter()
                .find(|a| !a.starts_with('-') && !a.contains('{'))
            else {
                continue;
            };
            // `@scope/name@1.2.3` → the version is after the LAST `@`, which
            // must exist beyond position 0 and start with a digit.
            let pinned = match spec.rfind('@') {
                Some(at) if at > 0 => spec[at + 1..].starts_with(|c: char| c.is_ascii_digit()),
                _ => false,
            };
            if !pinned {
                unpinned.push(format!("{} → {:?}", def.entry.id, spec));
            }
        }
        assert!(
            unpinned.is_empty(),
            "MCP catalog entries must pin an exact version (@x.y.z):\n  - {}",
            unpinned.join("\n  - ")
        );
    }

    /// Every config field the user is asked for must be answerable by
    /// pasting one value from the service's own settings page.
    ///
    /// The catalog is a store for people who do not know what MCP is. A
    /// field asking for "path to OAuth credentials JSON" is not a field
    /// they can fill — it asks them to create a Google Cloud project — so
    /// the extension is unusable no matter how healthy its npm package is.
    #[test]
    fn catalog_never_asks_the_user_for_a_credentials_file() {
        let mut offenders: Vec<String> = Vec::new();
        for def in catalog() {
            for field in &def.entry.fields {
                let l = field.label.to_lowercase();
                if l.contains("credentials json")
                    || l.contains("service account")
                    || l.contains("oauth")
                {
                    offenders.push(format!("{} → {:?}", def.entry.id, field.label));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "these entries ask for something a non-technical user cannot produce:\n  - {}",
            offenders.join("\n  - ")
        );
    }
}
