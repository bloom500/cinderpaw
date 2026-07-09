//! MCP (Model Context Protocol) — "Extensions" backend: config + catalog +
//! sidecar proxy.
//!
//! R5 (docs/2026-07-09-v1-architecture-hardening-spec.md): live MCP
//! connections are owned by the Bun sidecar (`FeralAgent/src/sandbox/
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

#[derive(Debug, Default, Serialize, Deserialize)]
struct McpConfigFile {
    servers: Vec<McpServerConfig>,
}

fn config_path() -> PathBuf {
    paths::feral_dir().join("mcp.json")
}

fn load_config() -> McpConfigFile {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => McpConfigFile::default(),
    }
}

fn save_config(cfg: &McpConfigFile) -> Result<(), String> {
    let path = config_path();
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw)
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
}

struct CatalogDef {
    entry: McpCatalogEntry,
    /// (command, args). `{key}` placeholders are replaced with field values.
    command: &'static str,
    args: &'static [&'static str],
    /// Field keys that become env vars instead of args.
    env_keys: &'static [&'static str],
}

fn catalog() -> Vec<CatalogDef> {
    let f = |key: &str, label: &str, secret: bool, optional: bool| McpConfigField {
        key: key.into(),
        label: label.into(),
        secret,
        optional,
    };
    let logo = |url: &'static str| -> Option<String> { Some(url.into()) };
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
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-filesystem", "{FOLDER}"],
            env_keys: &[],
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
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-memory"],
            env_keys: &[],
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
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-sequential-thinking"],
            env_keys: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "calcom".into(),
                name: "Cal.com".into(),
                description: "Manage your Cal.com calendar, bookings, and availability.".into(),
                category: "Productivity".into(),
                icon: "📅".into(),
                logo_url: logo("https://cal.com/logo.svg"),
                fields: vec![f("CAL_API_KEY", "Cal.com API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@calcom/mcp-server"],
            env_keys: &["CAL_API_KEY"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "mindmeister".into(),
                name: "MindMeister".into(),
                description: "Create and manage mind maps in MindMeister.".into(),
                category: "Productivity".into(),
                icon: "🗺️".into(),
                logo_url: logo("https://www.mindmeister.com/favicon.ico"),
                fields: vec![f("MINDMEISTER_API_KEY", "MindMeister API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@meisterlabs/mindmeister-mcp"],
            env_keys: &["MINDMEISTER_API_KEY"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "meistertask".into(),
                name: "MeisterTask".into(),
                description: "Manage tasks and projects in MeisterTask.".into(),
                category: "Productivity".into(),
                icon: "✅".into(),
                logo_url: logo("https://www.meistertask.com/favicon.ico"),
                fields: vec![f("MEISTERTASK_API_KEY", "MeisterTask API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@meisterlabs/meistertask-mcp"],
            env_keys: &["MEISTERTASK_API_KEY"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "superlist".into(),
                name: "Superlist".into(),
                description: "Manage your Superlist tasks and lists.".into(),
                category: "Productivity".into(),
                icon: "📋".into(),
                logo_url: logo("https://superlist.com/favicon.ico"),
                fields: vec![f("SUPERLIST_API_KEY", "Superlist API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@superlistapp/mcp-server"],
            env_keys: &["SUPERLIST_API_KEY"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "todoist".into(),
                name: "Todoist".into(),
                description: "Manage your Todoist tasks, projects, and reminders.".into(),
                category: "Productivity".into(),
                icon: "🔴".into(),
                logo_url: logo("https://todoist.com/favicon.ico"),
                fields: vec![f("TODOIST_API_TOKEN", "Todoist API token", true, false)],
            },
            command: "npx",
            args: &["-y", "@doist/todoist-mcp-server"],
            env_keys: &["TODOIST_API_TOKEN"],
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
            },
            command: "npx",
            args: &["-y", "@notionhq/notion-mcp-server"],
            env_keys: &["NOTION_API_TOKEN"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "linear".into(),
                name: "Linear".into(),
                description: "Manage Linear issues, cycles, and projects.".into(),
                category: "Productivity".into(),
                icon: "📐".into(),
                logo_url: logo("https://linear.app/favicon.ico"),
                fields: vec![f("LINEAR_API_KEY", "Linear API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@linear/mcp-server"],
            env_keys: &["LINEAR_API_KEY"],
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
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-github"],
            env_keys: &["GITHUB_PERSONAL_ACCESS_TOKEN"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "supabase".into(),
                name: "Supabase".into(),
                description: "Query and manage your Supabase database and storage.".into(),
                category: "Developer".into(),
                icon: "⚡".into(),
                logo_url: logo("https://supabase.com/favicon/favicon-32x32.png"),
                fields: vec![
                    f("SUPABASE_URL", "Supabase project URL", false, false),
                    f("SUPABASE_SERVICE_ROLE_KEY", "Service role key", true, false),
                ],
            },
            command: "npx",
            args: &["-y", "@supabase/mcp-server-supabase@0.8.2", "--supabase-url", "{SUPABASE_URL}", "--supabase-key", "{SUPABASE_SERVICE_ROLE_KEY}"],
            env_keys: &[],
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
            },
            command: "npx",
            args: &["-y", "@cloudflare/mcp-server-cloudflare"],
            env_keys: &["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
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
            },
            command: "npx",
            args: &["-y", "@cameroncooke/xcodebuildmcp"],
            env_keys: &[],
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
            },
            command: "npx",
            args: &["-y", "chrome-devtools-mcp"],
            env_keys: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "sqlite".into(),
                name: "SQLite".into(),
                description: "Run queries and explore tables in a local SQLite database.".into(),
                category: "Developer".into(),
                icon: "🗄️".into(),
                logo_url: None,
                fields: vec![f("DB_PATH", "Path to the .db file", false, false)],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-sqlite", "{DB_PATH}"],
            env_keys: &[],
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
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-postgres", "{POSTGRES_URL}"],
            env_keys: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "karea".into(),
                name: "Karea".into(),
                description: "Connect to the Karea developer platform.".into(),
                category: "Developer".into(),
                icon: "🎯".into(),
                logo_url: None,
                fields: vec![f("KAREA_API_KEY", "Karea API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@starecz/karea-mcp"],
            env_keys: &["KAREA_API_KEY"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "vercel".into(),
                name: "Vercel".into(),
                description: "Manage Vercel deployments, projects, and domains.".into(),
                category: "Developer".into(),
                icon: "▲".into(),
                logo_url: logo("https://vercel.com/favicon.ico"),
                fields: vec![f("VERCEL_TOKEN", "Vercel API token", true, false)],
            },
            command: "npx",
            args: &["-y", "@vercel/mcp-adapter"],
            env_keys: &["VERCEL_TOKEN"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "jira".into(),
                name: "Jira".into(),
                description: "Manage Jira issues, projects, and sprints from the assistant.".into(),
                category: "Developer".into(),
                icon: "🔵".into(),
                logo_url: logo("https://www.atlassian.com/favicon.ico"),
                fields: vec![
                    f("ATLASSIAN_API_TOKEN", "Atlassian API token", true, false),
                    f("ATLASSIAN_URL", "Atlassian workspace URL", false, false),
                ],
            },
            command: "npx",
            args: &["-y", "@atlassian/mcp-atlassian"],
            env_keys: &["ATLASSIAN_API_TOKEN", "ATLASSIAN_URL"],
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
            },
            command: "npx",
            args: &["-y", "@playwright/mcp@0.0.76"],
            env_keys: &[],
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
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-brave-search"],
            env_keys: &["BRAVE_API_KEY"],
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
            },
            command: "npx",
            args: &["-y", "firecrawl-mcp"],
            env_keys: &["FIRECRAWL_API_KEY"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "fetch".into(),
                name: "Web Fetch".into(),
                description: "Fetch and read content from any public URL.".into(),
                category: "Internet".into(),
                icon: "📡".into(),
                logo_url: None,
                fields: vec![],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-fetch"],
            env_keys: &[],
        },
        // Communication channels (Discord, Slack, Telegram, WhatsApp) live in
        // the dedicated Connectors section now — not here. See connectors.rs.
        // ── CRM & Sales ───────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "hubspot".into(),
                name: "HubSpot".into(),
                description: "Manage HubSpot contacts, deals, and CRM pipelines.".into(),
                category: "CRM & Sales".into(),
                icon: "🧡".into(),
                logo_url: logo("https://www.hubspot.com/favicon.ico"),
                fields: vec![f("HUBSPOT_ACCESS_TOKEN", "HubSpot private app access token", true, false)],
            },
            command: "npx",
            args: &["-y", "@baryhuang/mcp-hubspot"],
            env_keys: &["HUBSPOT_ACCESS_TOKEN"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "gohighlevel".into(),
                name: "GoHighLevel".into(),
                description: "Manage GoHighLevel CRM contacts, pipelines, and automations.".into(),
                category: "CRM & Sales".into(),
                icon: "📈".into(),
                logo_url: logo("https://www.gohighlevel.com/favicon.ico"),
                fields: vec![f("GHL_API_KEY", "GoHighLevel API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@busybee/go-high-level-mcp"],
            env_keys: &["GHL_API_KEY"],
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
            },
            command: "npx",
            args: &["-y", "@stripe/agent-toolkit"],
            env_keys: &["STRIPE_SECRET_KEY"],
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
                    f("SF_USERNAME", "Salesforce username", false, false),
                    f("SF_PASSWORD", "Salesforce password", true, false),
                    f("SF_SECURITY_TOKEN", "Security token", true, false),
                ],
            },
            command: "npx",
            args: &["-y", "@tsmztech/mcp-server-salesforce"],
            env_keys: &["SF_USERNAME", "SF_PASSWORD", "SF_SECURITY_TOKEN"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "intercom".into(),
                name: "Intercom".into(),
                description: "Manage Intercom conversations, contacts, and support tickets.".into(),
                category: "CRM & Sales".into(),
                icon: "💬".into(),
                logo_url: logo("https://www.intercom.com/favicon.ico"),
                fields: vec![f("INTERCOM_ACCESS_TOKEN", "Intercom access token", true, false)],
            },
            command: "npx",
            args: &["-y", "@intercom/mcp-server"],
            env_keys: &["INTERCOM_ACCESS_TOKEN"],
        },
        // ── Analytics ─────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "clamp-analytics".into(),
                name: "Clamp Analytics".into(),
                description: "Query your Clamp Analytics data and reports.".into(),
                category: "Analytics".into(),
                icon: "📊".into(),
                logo_url: None,
                fields: vec![f("CLAMP_API_KEY", "Clamp API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@clamp-sh/mcp"],
            env_keys: &["CLAMP_API_KEY"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "google-analytics".into(),
                name: "Google Analytics".into(),
                description: "Query Google Analytics GA4 reports and metrics.".into(),
                category: "Analytics".into(),
                icon: "📉".into(),
                logo_url: logo("https://www.google.com/favicon.ico"),
                fields: vec![
                    f("GA_PROPERTY_ID", "GA4 Property ID", false, false),
                    f("GOOGLE_APPLICATION_CREDENTIALS", "Path to service account JSON", false, false),
                ],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-google-analytics"],
            env_keys: &["GA_PROPERTY_ID", "GOOGLE_APPLICATION_CREDENTIALS"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "mixpanel".into(),
                name: "Mixpanel".into(),
                description: "Query Mixpanel events, funnels, and retention reports.".into(),
                category: "Analytics".into(),
                icon: "📊".into(),
                logo_url: logo("https://mixpanel.com/favicon.ico"),
                fields: vec![f("MIXPANEL_TOKEN", "Mixpanel project token", true, false)],
            },
            command: "npx",
            args: &["-y", "@mixpanel/mcp-server"],
            env_keys: &["MIXPANEL_TOKEN"],
        },
        // ── Google ────────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "google-drive".into(),
                name: "Google Drive".into(),
                description: "Read and manage files in your Google Drive.".into(),
                category: "Google".into(),
                icon: "📂".into(),
                logo_url: logo("https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png"),
                fields: vec![f("GDRIVE_CREDENTIALS_FILE", "Path to OAuth credentials JSON", false, false)],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-gdrive"],
            env_keys: &["GDRIVE_CREDENTIALS_FILE"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "google-calendar".into(),
                name: "Google Calendar".into(),
                description: "Read and create events in your Google Calendar.".into(),
                category: "Google".into(),
                icon: "📆".into(),
                logo_url: logo("https://calendar.google.com/googlecalendar/images/favicon_v2018_256.png"),
                fields: vec![f("GCAL_CREDENTIALS_FILE", "Path to OAuth credentials JSON", false, false)],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-google-calendar"],
            env_keys: &["GCAL_CREDENTIALS_FILE"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "gmail".into(),
                name: "Gmail".into(),
                description: "Read and send emails via your Gmail account.".into(),
                category: "Google".into(),
                icon: "📧".into(),
                logo_url: logo("https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico"),
                fields: vec![f("GMAIL_CREDENTIALS_FILE", "Path to OAuth credentials JSON", false, false)],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-gmail"],
            env_keys: &["GMAIL_CREDENTIALS_FILE"],
        },
        // ── AI & Media ────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "higgsfield".into(),
                name: "Higgsfield AI".into(),
                description: "Generate cinematic AI videos with Higgsfield.".into(),
                category: "AI & Media".into(),
                icon: "🎬".into(),
                logo_url: logo("https://higgsfield.ai/favicon.ico"),
                fields: vec![f("HIGGSFIELD_API_KEY", "Higgsfield API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@higgsfield/mcp-server"],
            env_keys: &["HIGGSFIELD_API_KEY"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "replicate".into(),
                name: "Replicate".into(),
                description: "Run AI models for images, video, audio, and more via Replicate.".into(),
                category: "AI & Media".into(),
                icon: "🖼️".into(),
                logo_url: logo("https://replicate.com/favicon.ico"),
                fields: vec![f("REPLICATE_API_TOKEN", "Replicate API token", true, false)],
            },
            command: "npx",
            args: &["-y", "@replicate/mcp-server"],
            env_keys: &["REPLICATE_API_TOKEN"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "elevenlabs".into(),
                name: "ElevenLabs".into(),
                description: "Generate realistic speech and audio with ElevenLabs.".into(),
                category: "AI & Media".into(),
                icon: "🔊".into(),
                logo_url: logo("https://elevenlabs.io/favicon.ico"),
                fields: vec![f("ELEVENLABS_API_KEY", "ElevenLabs API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@elevenlabs/mcp"],
            env_keys: &["ELEVENLABS_API_KEY"],
        },
        // ── Monetization ──────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "chipp".into(),
                name: "Chipp".into(),
                description: "Monetize your AI tools and agents with Chipp.".into(),
                category: "Monetization".into(),
                icon: "💰".into(),
                logo_url: logo("https://chipp.ai/favicon.ico"),
                fields: vec![f("CHIPP_API_KEY", "Chipp API key", true, false)],
            },
            command: "npx",
            args: &["-y", "@chipp/mcp-server"],
            env_keys: &["CHIPP_API_KEY"],
        },
        // ── Crypto & Web3 ─────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "chain-signer".into(),
                name: "Chain Signer".into(),
                description: "Sign and broadcast transactions on EVM-compatible blockchains.".into(),
                category: "Crypto & Web3".into(),
                icon: "⛓️".into(),
                logo_url: None,
                fields: vec![],
            },
            command: "npx",
            args: &["-y", "@kevthetech143/chain-signer"],
            env_keys: &[],
        },
        // ── Infrastructure ────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "homelab".into(),
                name: "HomeLab Monitor".into(),
                description: "Monitor and manage your self-hosted homelab services.".into(),
                category: "Infrastructure".into(),
                icon: "🏠".into(),
                logo_url: None,
                fields: vec![f("HOMELAB_API_URL", "HomeLab Monitor API URL", false, false)],
            },
            command: "npx",
            args: &["-y", "@sikamikanikobg/homelab-monitor"],
            env_keys: &["HOMELAB_API_URL"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "docker".into(),
                name: "Docker".into(),
                description: "Manage Docker containers, images, and volumes.".into(),
                category: "Infrastructure".into(),
                icon: "🐳".into(),
                logo_url: logo("https://www.docker.com/favicon.ico"),
                fields: vec![],
            },
            command: "npx",
            args: &["-y", "@docker/mcp-server"],
            env_keys: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "aws".into(),
                name: "AWS".into(),
                description: "Manage AWS services, S3, Lambda, and more.".into(),
                category: "Infrastructure".into(),
                icon: "☁️".into(),
                logo_url: logo("https://aws.amazon.com/favicon.ico"),
                fields: vec![
                    f("AWS_ACCESS_KEY_ID", "AWS access key ID", true, false),
                    f("AWS_SECRET_ACCESS_KEY", "AWS secret access key", true, false),
                    f("AWS_REGION", "AWS region (e.g. us-east-1)", false, true),
                ],
            },
            command: "npx",
            args: &["-y", "@aws-sdk/mcp-server"],
            env_keys: &["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "kubernetes".into(),
                name: "Kubernetes".into(),
                description: "Manage Kubernetes clusters, pods, and deployments.".into(),
                category: "Infrastructure".into(),
                icon: "☸️".into(),
                logo_url: logo("https://kubernetes.io/images/favicon.png"),
                fields: vec![],
            },
            command: "npx",
            args: &["-y", "@kubernetes-mcp/server"],
            env_keys: &[],
        },
        // ── Data ──────────────────────────────────────────────────────────────
        CatalogDef {
            entry: McpCatalogEntry {
                id: "excel".into(),
                name: "Excel / CSV".into(),
                description: "Read and analyze Excel spreadsheets and CSV files.".into(),
                category: "Data".into(),
                icon: "📊".into(),
                logo_url: logo("https://www.microsoft.com/favicon.ico"),
                fields: vec![f("FILE_PATH", "Path to the spreadsheet or CSV", false, false)],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-excel-csv", "{FILE_PATH}"],
            env_keys: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "pdf".into(),
                name: "PDF Reader".into(),
                description: "Extract and search text from PDF documents.".into(),
                category: "Data".into(),
                icon: "📄".into(),
                logo_url: None,
                fields: vec![f("PDF_DIR", "Folder containing your PDFs", false, false)],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-pdf", "{PDF_DIR}"],
            env_keys: &[],
        },
        CatalogDef {
            entry: McpCatalogEntry {
                id: "airtable".into(),
                name: "Airtable".into(),
                description: "Read and write records in your Airtable bases.".into(),
                category: "Data".into(),
                icon: "🟡".into(),
                logo_url: logo("https://airtable.com/favicon.ico"),
                fields: vec![f("AIRTABLE_API_KEY", "Airtable personal access token", true, false)],
            },
            command: "npx",
            args: &["-y", "@modelcontextprotocol/server-airtable"],
            env_keys: &["AIRTABLE_API_KEY"],
        },
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
/// (`FeralAgent/src/sandbox/mcp-manager.ts` `hasWindowsMetachars`) —
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
/// `feral-core/src/api.rs`: subscribe the runtime event bus FIRST, then
/// send, then filter `feral://agent-output` lines for our reply. The
/// desktop bus is fed by `TauriEvents` (lib.rs), which fans every host
/// event onto `runtime.events_tx`.
async fn sidecar_roundtrip(
    state: &crate::AppState,
    mut payload: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let tx = {
        let guard = state.feral_agent_tx.lock();
        guard.as_ref().cloned()
    }
    .ok_or_else(|| "Feral is still starting up — try again in a moment.".to_string())?;

    let msg_id = uuid::Uuid::new_v4().to_string();
    payload["id"] = serde_json::Value::String(msg_id.clone());
    let mut rx = state.runtime.events_tx.subscribe();
    tx.send(payload.to_string())
        .await
        .map_err(|_| "Feral is still starting up — try again in a moment.".to_string())?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(humanize("timed out"));
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) => {
                if ev.event != "feral://agent-output" {
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

/// Reload timeout: first connect of an npx-based server may cold-download
/// the package; the sidecar's per-server init timeout is 10 s, so 30 s
/// covers a couple of servers connecting sequentially.
const RELOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Translate transport/protocol errors into messages a non-technical user
/// can act on. The raw error is logged for diagnostics, never displayed.
fn humanize(raw: &str) -> String {
    tracing::warn!("MCP error: {raw}");
    let lower = raw.to_lowercase();
    if lower.contains("program not found") || lower.contains("no such file") || lower.contains("spawn failed") {
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
    let env = def
        .env_keys
        .iter()
        .filter_map(|k| values.get(*k).map(|v| ((*k).to_string(), v.clone())))
        .collect::<HashMap<_, _>>();

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

    let mut cfg = load_config();
    cfg.servers.retain(|s| s.id != server.id);
    cfg.servers.push(server.clone());
    save_config(&cfg)?;

    let status = reload_and_status(&state, RELOAD_TIMEOUT).await?;
    match status.get(&server.id) {
        Some((true, _)) => Ok(view_of(&server, true)),
        Some((false, err)) => Err(humanize(err.as_deref().unwrap_or("closed"))),
        None => Err(humanize("closed")),
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
    let mut cfg = load_config();
    let server = cfg
        .servers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| "This extension is not installed.".to_string())?;
    server.enabled = enabled;
    let snapshot = server.clone();
    save_config(&cfg)?;

    let status = reload_and_status(&state, RELOAD_TIMEOUT).await?;
    let (running, err) = status
        .get(&id)
        .cloned()
        .unwrap_or((false, None));
    if enabled && !running {
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
// (FeralAgent/src/sandbox/mcp-manager.ts, hasWindowsMetachars + its tests);
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
}
