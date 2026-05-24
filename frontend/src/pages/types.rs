use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub quant: Option<String>,
    pub ctx_len: Option<u32>,
    pub loaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedModel {
    pub path: String,
    pub name: String,
    pub ctx_len: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os: String,
    pub cpu: String,
    pub cores: usize,
    pub ram_total_mb: u64,
    pub ram_used_mb: u64,
    pub gpu_name: String,
    pub vram_total_mb: u64,
    pub vram_used_mb: u64,
    pub supports_vulkan: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferParams {
    pub temperature: f32,
    pub top_p: f32,
    pub repeat_penalty: f32,
    pub max_tokens: u32,
    pub system_prompt: Option<String>,
}

impl Default for InferParams {
    fn default() -> Self {
        Self {
            temperature: 0.8,
            top_p: 0.95,
            repeat_penalty: 1.1,
            max_tokens: 1024,
            system_prompt: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolType {
    WebSearch,
    FileRead,
    FileWrite,
    CodeExecute,
    HttpRequest,
}

impl ToolType {
    pub fn all() -> &'static [ToolType] {
        &[
            ToolType::WebSearch,
            ToolType::FileRead,
            ToolType::FileWrite,
            ToolType::CodeExecute,
            ToolType::HttpRequest,
        ]
    }
    pub fn label(&self) -> &'static str {
        match self {
            ToolType::WebSearch => "web_search",
            ToolType::FileRead => "file_read",
            ToolType::FileWrite => "file_write",
            ToolType::CodeExecute => "code_execute",
            ToolType::HttpRequest => "http_request",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
    pub model_id: String,
    pub tools: Vec<ToolType>,
    #[serde(default)]
    pub params: Option<InferParams>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub models_dir: String,
    pub default_gpu_layers: i32,
    pub api_server_enabled: bool,
    pub api_port: u16,
    pub version: String,
}

pub fn human_bytes(b: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut size = b as f64;
    let mut i = 0;
    while size >= 1024.0 && i < units.len() - 1 { size /= 1024.0; i += 1; }
    format!("{:.1} {}", size, units[i])
}
