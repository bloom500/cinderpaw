// IPC façade
//
// Tauri returns T directly on success and throws a string on Err.
// Domain groups keep components to ~5 imports each.

import { invoke, Channel } from '@tauri-apps/api/core';
export { Channel };
import type {
  TokenEvent,
  StreamDoneEvent,
  StreamErrorEvent,
  StreamTruncatedEvent,
  DownloadProgressEvent,
  DownloadCompleteEvent,
  DownloadErrorEvent,
  ModelLoadProgressEvent,
} from './events';

// ── Types (mirrors Rust structs exactly — snake_case, no rename_all) ──────────
export type { TokenEvent, StreamDoneEvent, StreamErrorEvent, StreamTruncatedEvent };
export type { DownloadProgressEvent, DownloadCompleteEvent, DownloadErrorEvent };
export type { ModelLoadProgressEvent };

export interface Message       { role: string; content: string; images?: string[] }
export interface InferParams   {
  temperature: number;
  top_p: number;
  repeat_penalty: number;
  max_tokens: number;
  system_prompt?: string | null;
  tools?: string[] | null;
}
export interface LoadedModel   { path: string; name: string; ctx_len: number }
export interface ModelInfo     {
  id: string; name: string; path: string; size_bytes: number;
  quant?: string | null; ctx_len?: number | null; loaded: boolean;
}
export interface SystemInfo {
  os: string;
  cpu: string;
  cores: number;
  ram_total_mb: number;
  ram_used_mb: number;
  gpu_name: string;
  vram_total_mb: number;
  vram_used_mb: number;
  supports_vulkan: boolean;
}

// At-rest encryption posture for the host disk (H-1). `state` is "on" | "off"
// | "unknown"; `detail` is a human-readable note for the UI.
export interface DiskEncryptionStatus {
  state: 'on' | 'off' | 'unknown';
  detail: string;
}

// MCP "Extensions" — display-safe views only (no transports, paths, or keys)
export interface McpConfigField {
  key: string;
  label: string;
  secret: boolean;
  optional: boolean;
}
export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  logo_url?: string;
  fields: McpConfigField[];
}
export interface McpServerView {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  logo_url?: string;
  enabled: boolean;
  running: boolean;
}
export interface McpToolView { name: string; description: string }

// Connectors — inbound messaging surfaces over the local agent. Field names
// match Rust snake_case serialization exactly.
export interface ConnectorField { key: string; label: string; secret: boolean }
export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  logo_url?: string;
  fields: ConnectorField[];
  auth_kind: string; // "token" | "qr"
  coming_soon: boolean;
}
export interface ConnectorView {
  id: string;
  name: string;
  description: string;
  icon: string;
  logo_url?: string;
  fields: ConnectorField[];
  auth_kind: string;
  coming_soon: boolean;
  enabled: boolean;
  filled: string[];   // field keys that hold a value (never the values)
  linked: boolean;    // QR connectors: session established
  allowlist: string[];
  channels: string[];
  mode: string;            // "owner" | "public" (WhatsApp)
  knowledgeBase: string;   // inline KB text for public mode
}

// HF types — field names match Rust snake_case serialization exactly
export interface HfModelSummary {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  last_modified: string;
  tags: string[];
}

export interface HfFile {
  rfilename: string;
  size: number | null;
}

export interface HfModelDetail {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  last_modified: string;
  tags: string[];
  gguf_files: HfFile[];
  readme: string | null;
}

export interface HfSearchPage {
  models: HfModelSummary[];
  next_cursor: string | null;
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  license: string;
  tags: string[];
  source_provider: string;
  source_url: string | null;
  content_url: string | null;
  install_status: string; // "installed" | "not_installed"
  trust_label: string;    // "local" | "community" | "unknown" | etc.
  last_updated: string | null;
}

export interface SkillPreview {
  meta: SkillMeta;
  content: string;
}

export interface Settings {
  models_dir: string;
  default_gpu_layers: number;
  api_server_enabled: boolean;
  api_port: number;
  version: string;
  /** Opt-in for OS-level desktop control (the `control_app` tool). Off by default. */
  desktop_control_enabled: boolean;
  /** YOLO mode: skip the per-action confirmation prompt for desktop control. Off = Safe mode. */
  desktop_control_yolo: boolean;
  /** Per-conversation token budget. null = unlimited (Infinity); number = hard cap in tokens. */
  token_budget_conversation: number | null;
}

export interface ByokProvider {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  has_api_key: boolean;
  base_url?: string | null;
  default_model?: string | null;
}

/** Mirrors Rust `conversations::VoiceMeta` (snake_case, no rename_all). */
export interface VoiceMeta { audio_path: string; duration_ms: number; transcript: string; peaks: number[] }
export interface PersistedMessage    { role: string; content: string; thinking?: string; voice?: VoiceMeta | null }
export interface ConversationSummary {
  id: string; title: string; updated_at: string;
  /** Set when this conversation belongs to an agent (Agents tab); null for chat. */
  agent_id?: string | null;
}
export interface Conversation {
  id: string; title: string;
  created_at: string; updated_at: string;
  messages: PersistedMessage[];
  agent_id?: string | null;
}
export interface Project { id: string; name: string; conversation_ids: string[] }

// ── Memory Graph ─────────────────────────────────────────────────────────────
export interface MemoryGraphNodeView {
  id: string;
  label: string;
  type: string;
  touched_at: number;
}

export interface MemoryGraphEdgeView {
  from: string;
  to: string;
  relation: string;
}

export interface MemoryGraphSnapshot {
  nodes: MemoryGraphNodeView[];
  edges: MemoryGraphEdgeView[];
}

/** One extracted fact triple written to the shared knowledge graph. */
export interface MemoryFactInput {
  subject: string;
  predicate: string;
  object: string;
}

// ── Agents ───────────────────────────────────────────────────────────────────
/** Mirrors Rust AgentEvent — `#[serde(tag = "kind", rename_all = "snake_case")]` */
export type AgentEvent =
  | { kind: 'token';       text: string }
  | { kind: 'tool_call';   name: string; args: unknown }
  | { kind: 'tool_result'; name: string; ok: boolean; output: string }
  | { kind: 'final';       text: string }
  | { kind: 'error';       message: string };

export interface AgentConfig {
  /** Omit when creating a new agent — the backend assigns a UUID. */
  id?: string;
  name: string;
  system_prompt: string;
  model_id: string;
  /** Serialised as Rust enum variant names: "WebSearch" | "FileRead" | "FileWrite" | "CodeExecute" | "HttpRequest" */
  tools: string[];
  params?: Record<string, unknown> | null;
}

// ── Feral Agent ─────────────────────────────────────────────────────────────

/** Parsed output event from the Feral Agent sidecar. */
export type FeralAgentEvent =
  | { type: 'chunk';       id: string; content: string }
  | { type: 'done';        id: string; content: string; stopped: boolean }
  | { type: 'tool_start';  id: string; callId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_done';   id: string; callId: string; tool: string; result: unknown }
  // #18: live progress/retry notes from long-running tools (sidecar emits
  // these with a sessionId, not a message id).
  | { type: 'tool_progress'; sessionId: string; tool: string; stage: string; progress: number | null; message: string }
  | { type: 'proactive';   content: string }
  | { type: 'model_set';   provider: string; model: string }
  | { type: 'model_error'; message: string }
  | { type: 'pong' }
  | { type: 'error';       id?: string; message: string }
  | { type: 'ask_user';    id: string; sessionId: string; questions: import('@/stores/askUser').AskUserQuestion[] }
  | { type: 'ask_user_cancelled'; id: string; sessionId: string; reason: string }
  | { type: 'spawning'; id: string; count: number }
  // Real token usage per completion — drives the live context ring in agent mode.
  | { type: 'usage'; id: string; sessionId: string; promptTokens: number; completionTokens: number }
  // X3: scheduled-job results and failures, surfaced as toasts.
  | { type: 'cron_fired'; jobId: string; jobName: string; sessionId: string; content: string }
  | { type: 'cron_error'; jobId: string; jobName: string; message: string };

/** Display-safe snapshot of the Feral Agent's active LLM — no API keys. */
export interface FeralModelConfigView {
  provider: string;
  model: string;
  base_url: string;
  display_name: string;
}

/** What React sends to Rust when changing the Feral model. */
export type FeralModelSelection =
  | { source: 'ollama';            model: string; baseUrl: string }
  | { source: 'byok';              providerId: string; model: string }
  | { source: 'openai_compatible'; baseUrl: string; model: string; providerId: string };

// ── Raw invoke helpers ────────────────────────────────────────────────────────
// Tauri returns T directly on Ok; throws a string on Err.
// No Result wrapper needed — errors propagate as thrown exceptions.
const raw = {
  getModels:             ()    => invoke<ModelInfo[]>('get_models'),
  getLoadedModel:        ()    => invoke<LoadedModel | null>('get_loaded_model'),
  loadModel:             (path: string) => invoke<LoadedModel>('load_model', { path }),
  startModelLoad:        (path: string) => invoke<LoadedModel>('start_model_load', { path }),
  unloadModel:           ()    => invoke<void>('unload_model'),
  deleteModel:           (path: string) => invoke<void>('delete_model', { path }),
  chatStream:            (messages: Message[], params: InferParams, sessionId: string) =>
    invoke<void>('chat_stream', { messages, params, sessionId }),
  stopGeneration:        ()    => invoke<void>('stop_generation'),
  downloadModel:         (repoId: string, filename: string) =>
    invoke<string>('download_model', { repoId, filename }),
  cancelDownload:        (modelId: string) =>
    invoke<void>('cancel_download', { modelId }),
  getModelSizeInfo:      (repoId: string, filename: string) =>
    invoke<number>('get_model_size_info', { repoId, filename }),
  getSystemInfo:         ()    => invoke<SystemInfo>('get_system_info'),
  diskEncryptionStatus:  ()    => invoke<DiskEncryptionStatus>('disk_encryption_status'),
  saveAgent:             (cfg: AgentConfig) => invoke<AgentConfig>('save_agent', { cfg }),
  getAgents:             ()    => invoke<AgentConfig[]>('get_agents'),
  deleteAgent:           (id: string) => invoke<void>('delete_agent', { id }),
  getAgentPresets:       ()    => invoke<AgentConfig[]>('get_agent_presets'),
  runAgent:              (agentId: string, prompt: string, sessionId: string) =>
    invoke<void>('run_agent', { agentId, prompt, sessionId }),
  saveConversation:      (id: string, title: string, messages: PersistedMessage[], agentId?: string | null) =>
    invoke<void>('save_conversation', { id, title, messages, agentId: agentId ?? null }),
  loadConversations:     ()    => invoke<ConversationSummary[]>('load_conversations'),
  loadConversation:      (id: string) => invoke<Conversation>('load_conversation', { id }),
  deleteConversation:    (id: string) => invoke<void>('delete_conversation', { id }),
  clearAllConversations: ()    => invoke<void>('clear_all_conversations'),
  loadProjects:          ()    => invoke<Project[]>('load_projects'),
  saveProject:           (id: string, name: string, conversationIds: string[]) =>
    invoke<void>('save_project', { id, name, conversationIds }),
  deleteProject:         (id: string) => invoke<void>('delete_project', { id }),
  getSettings:           ()    => invoke<Settings>('get_settings'),
  saveSettings:          (settings: Settings) => invoke<void>('save_settings', { settings }),
  setDesktopControlEnabled: (enabled: boolean) =>
    invoke<void>('set_desktop_control_enabled', { enabled }),
  setDesktopControlYolo: (enabled: boolean) =>
    invoke<void>('set_desktop_control_yolo', { enabled }),
  setTokenBudgetConversation: (budget: number | null) =>
    invoke<void>('set_token_budget_conversation', { budget }),
  searchHfModels:        (query: string, cursor?: string | null) =>
    invoke<HfSearchPage>('search_hf_models', { query, cursor }),
  getHfModelDetail:      (repoId: string) =>
    invoke<HfModelDetail>('get_hf_model_detail', { repoId }),
  getByokSettings:       ()    => invoke<ByokProvider[]>('get_byok_settings'),
  saveByokProvider:      (providerId: string, enabled: boolean, apiKey: string, baseUrl?: string | null, defaultModel?: string | null) =>
    invoke<void>('save_byok_provider', { providerId, enabled, apiKey, baseUrl, defaultModel }),
  removeByokProvider:    (providerId: string) =>
    invoke<void>('remove_byok_provider', { providerId }),
  testByokProvider:      (providerId: string, apiKey: string, baseUrl?: string | null) =>
    invoke<object>('test_byok_provider', { providerId, apiKey, baseUrl }),
  chatCloudStream:       (providerId: string, model: string, messages: Message[], params: InferParams, sessionId: string) =>
    invoke<void>('chat_cloud_stream', { providerId, model, messages, params, sessionId }),
  readFileAsText:        (path: string) => invoke<string>('read_file_as_text', { path }),
  listInstalledSkills:      () => invoke<SkillMeta[]>('list_installed_skills'),
  getInstalledSkillContent: (id: string) => invoke<string>('get_installed_skill_content', { id }),
  fetchRemoteSkills:        () => invoke<SkillMeta[]>('fetch_remote_skills'),
  fetchCommunitySkills:     () => invoke<SkillMeta[]>('fetch_community_skills'),
  previewRemoteSkill:       (url: string) => invoke<SkillPreview>('preview_remote_skill', { url }),
  previewLocalSkill:        (path: string) => invoke<SkillPreview>('preview_local_skill', { path }),
  skillExistsCmd:           (id: string) => invoke<boolean>('skill_exists_cmd', { id }),
  installSkill:             (meta: SkillMeta, content: string, overwrite: boolean) =>
    invoke<void>('install_skill', { meta, content, overwrite }),
  removeSkill:              (id: string) => invoke<void>('remove_skill', { id }),
  feralSendMessage:         (content: string, sessionId: string, images?: string[], inferParams?: { temperature?: number; max_tokens?: number }) =>
    invoke<string>('feral_send_message', { content, sessionId, images: images ?? null, inferParams: inferParams ?? null }),
  feralAgentStatus:         () => invoke<boolean>('feral_agent_status'),
  feralStopGeneration:      (sessionId?: string | null) =>
    invoke<void>('feral_stop_generation', { sessionId: sessionId ?? null }),
  feralSetModel: (
    source: string,
    model: string,
    providerId?: string | null,
    baseUrl?: string | null,
  ) => invoke<void>('feral_set_model', { source, model, providerId, baseUrl }),
  feralGetModelConfig:      () => invoke<FeralModelConfigView | null>('feral_get_model_config'),
  mcpCatalog:               () => invoke<McpCatalogEntry[]>('mcp_catalog'),
  mcpList:                  () => invoke<McpServerView[]>('mcp_list'),
  mcpInstall:               (id: string, values: Record<string, string>) =>
    invoke<McpServerView>('mcp_install', { id, values }),
  mcpSetEnabled:            (id: string, enabled: boolean) =>
    invoke<McpServerView>('mcp_set_enabled', { id, enabled }),
  mcpRemove:                (id: string) => invoke<void>('mcp_remove', { id }),
  mcpListTools:             (id: string) => invoke<McpToolView[]>('mcp_list_tools', { id }),
  mcpCallTool:              (id: string, tool: string, argsJson: string) =>
    invoke<string>('mcp_call_tool', { id, tool, argsJson }),
  connectorsCatalog:        () => invoke<ConnectorCatalogEntry[]>('connectors_catalog'),
  connectorsList:           () => invoke<ConnectorView[]>('connectors_list'),
  connectorsSave:           (id: string, secrets: Record<string, string>, allowlist: string[], channels: string[], mode?: string, knowledgeBase?: string) =>
    invoke<ConnectorView>('connectors_save', { id, secrets, allowlist, channels, mode, knowledgeBase }),
  connectorsSetEnabled:     (id: string, enabled: boolean) =>
    invoke<ConnectorView>('connectors_set_enabled', { id, enabled }),
  connectorsRemove:         (id: string) => invoke<void>('connectors_remove', { id }),
  getLocalApiToken:         () => invoke<string>('get_local_api_token'),
  listOllamaModels:         (baseUrl: string) => invoke<string[]>('list_ollama_models', { baseUrl }),
  getMemoryGraph:           () => invoke<MemoryGraphSnapshot>('get_memory_graph'),
  addMemoryFacts:           (facts: MemoryFactInput[]) =>
    invoke<number>('add_memory_facts', { facts }),
  chatCompleteLocal:        (messages: Message[], params: InferParams) =>
    invoke<string>('chat_complete_local', { messages, params }),
  chatCloudComplete:        (providerId: string, model: string, messages: Message[], params: InferParams) =>
    invoke<string>('chat_cloud_complete', { providerId, model, messages, params }),
  saveVoiceBlob:            (bytes: number[], ext: string) =>
    invoke<string>('save_voice_blob', { bytes, ext }),
  whisperModelPresent:      (modelSize: string) =>
    invoke<boolean>('whisper_model_present', { modelSize }),
  transcribeAudio:          (pcm: number[], modelSize: string) =>
    invoke<string>('transcribe_audio', { pcm, modelSize }),
};

// ── Public façade ─────────────────────────────────────────────────────────────
export const tauri = {
  raw,

  chat: {
    stream:      async (messages: Message[], params: InferParams, sessionId: string) =>
      raw.chatStream(messages, params, sessionId),
    cloudStream: async (providerId: string, model: string, messages: Message[], params: InferParams, sessionId: string) =>
      raw.chatCloudStream(providerId, model, messages, params, sessionId),
    stop: async () => raw.stopGeneration(),
  },

  conversations: {
    list:     async () => raw.loadConversations(),
    load:     async (id: string) => raw.loadConversation(id),
    save:     async (id: string, title: string, msgs: PersistedMessage[], agentId?: string | null) =>
      raw.saveConversation(id, title, msgs, agentId),
    delete:   async (id: string) => raw.deleteConversation(id),
    clearAll: async () => raw.clearAllConversations(),
  },

  projects: {
    list:   async () => raw.loadProjects(),
    save:   async (id: string, name: string, ids: string[]) =>
      raw.saveProject(id, name, ids),
    delete: async (id: string) => raw.deleteProject(id),
  },

  models: {
    list:      async () => raw.getModels(),
    loaded:    async () => raw.getLoadedModel(),
    load:      async (path: string) => raw.loadModel(path),
    startLoad: async (path: string) => raw.startModelLoad(path),
    unload:    async () => raw.unloadModel(),
    delete:    async (path: string) => raw.deleteModel(path),
  },

  settings: {
    get:  async () => raw.getSettings(),
    save: async (s: Settings) => raw.saveSettings(s),
    setDesktopControl: async (enabled: boolean) => raw.setDesktopControlEnabled(enabled),
    setDesktopControlYolo: async (enabled: boolean) => raw.setDesktopControlYolo(enabled),
    setTokenBudget: async (budget: number | null) => raw.setTokenBudgetConversation(budget),
  },

  hf: {
    search:        async (query: string, cursor?: string | null) =>
      raw.searchHfModels(query, cursor),
    detail:        async (repoId: string) =>
      raw.getHfModelDetail(repoId),
    modelSizeInfo: async (repoId: string, filename: string) =>
      raw.getModelSizeInfo(repoId, filename),
  },

  download: {
    start:  async (repoId: string, filename: string) =>
      raw.downloadModel(repoId, filename),
    cancel: async (modelId: string) =>
      raw.cancelDownload(modelId),
  },

  voice: {
    saveBlob:      async (bytes: number[], ext: string) => raw.saveVoiceBlob(bytes, ext),
    modelPresent:  async (modelSize: string) => raw.whisperModelPresent(modelSize),
    transcribe:    async (pcm: number[], modelSize: string) => raw.transcribeAudio(pcm, modelSize),
  },

  system: {
    info: async () => raw.getSystemInfo(),
    diskEncryption: async () => raw.diskEncryptionStatus(),
  },

  files: {
    readAsText: async (path: string) => raw.readFileAsText(path),
  },

  skills: {
    listInstalled:      async () => raw.listInstalledSkills(),
    getContent:         async (id: string) => raw.getInstalledSkillContent(id),
    fetchRemote:        async () => raw.fetchRemoteSkills(),
    fetchCommunity:     async () => raw.fetchCommunitySkills(),
    previewRemote:      async (url: string) => raw.previewRemoteSkill(url),
    previewLocal:       async (path: string) => raw.previewLocalSkill(path),
    exists:             async (id: string) => raw.skillExistsCmd(id),
    install:            async (meta: SkillMeta, content: string, overwrite: boolean) =>
      raw.installSkill(meta, content, overwrite),
    remove:             async (id: string) => raw.removeSkill(id),
  },

  mcp: {
    catalog:    async () => raw.mcpCatalog(),
    list:       async () => raw.mcpList(),
    install:    async (id: string, values: Record<string, string>) => raw.mcpInstall(id, values),
    setEnabled: async (id: string, enabled: boolean) => raw.mcpSetEnabled(id, enabled),
    remove:     async (id: string) => raw.mcpRemove(id),
    listTools:  async (id: string) => raw.mcpListTools(id),
    callTool:   async (id: string, tool: string, argsJson: string) => raw.mcpCallTool(id, tool, argsJson),
  },

  connectors: {
    catalog:    async () => raw.connectorsCatalog(),
    list:       async () => raw.connectorsList(),
    save:       async (id: string, secrets: Record<string, string>, allowlist: string[], channels: string[], mode?: string, knowledgeBase?: string) => raw.connectorsSave(id, secrets, allowlist, channels, mode, knowledgeBase),
    setEnabled: async (id: string, enabled: boolean) => raw.connectorsSetEnabled(id, enabled),
    remove:     async (id: string) => raw.connectorsRemove(id),
  },

  feralAgent: {
    sendMessage: async (content: string, sessionId: string, images?: string[], inferParams?: { temperature?: number; max_tokens?: number }) =>
      raw.feralSendMessage(content, sessionId, images, inferParams),
    status:      async () => raw.feralAgentStatus(),
    stop:        async (sessionId?: string) => raw.feralStopGeneration(sessionId ?? null),
  },

  agents: {
    getPresets: async () => raw.getAgentPresets(),
    save:       async (cfg: AgentConfig) => raw.saveAgent(cfg),
    getAll:     async () => raw.getAgents(),
    delete:     async (id: string) => raw.deleteAgent(id),
    run:        async (agentId: string, prompt: string, sessionId: string) =>
      raw.runAgent(agentId, prompt, sessionId),
  },

  memory: {
    getGraph: (): Promise<MemoryGraphSnapshot> => raw.getMemoryGraph(),
    addFacts: (facts: MemoryFactInput[]): Promise<number> => raw.addMemoryFacts(facts),
  },
};

export { events } from './events';
