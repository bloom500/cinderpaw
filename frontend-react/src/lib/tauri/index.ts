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
  DownloadProgressEvent,
  DownloadCompleteEvent,
  DownloadErrorEvent,
  ModelLoadProgressEvent,
} from './events';

// ── Types (mirrors Rust structs exactly — snake_case, no rename_all) ──────────
export type { TokenEvent, StreamDoneEvent, StreamErrorEvent };
export type { DownloadProgressEvent, DownloadCompleteEvent, DownloadErrorEvent };
export type { ModelLoadProgressEvent };

export interface Message       { role: string; content: string }
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

export interface PersistedMessage    { role: string; content: string }
export interface ConversationSummary { id: string; title: string; updated_at: string }
export interface Conversation {
  id: string; title: string;
  created_at: string; updated_at: string;
  messages: PersistedMessage[];
}
export interface Project { id: string; name: string; conversation_ids: string[] }

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
  | { type: 'done';        id: string; content: string }
  | { type: 'tool_start';  tool: string; args: Record<string, unknown> }
  | { type: 'tool_done';   tool: string; result: unknown }
  | { type: 'proactive';   content: string }
  | { type: 'model_set';   provider: string; model: string }
  | { type: 'model_error'; message: string }
  | { type: 'pong' }
  | { type: 'error';       id?: string; message: string };

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
  saveAgent:             (cfg: AgentConfig) => invoke<AgentConfig>('save_agent', { cfg }),
  getAgents:             ()    => invoke<AgentConfig[]>('get_agents'),
  deleteAgent:           (id: string) => invoke<void>('delete_agent', { id }),
  getAgentPresets:       ()    => invoke<AgentConfig[]>('get_agent_presets'),
  runAgent:              (agentId: string, prompt: string, sessionId: string) =>
    invoke<void>('run_agent', { agentId, prompt, sessionId }),
  saveConversation:      (id: string, title: string, messages: PersistedMessage[]) =>
    invoke<void>('save_conversation', { id, title, messages }),
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
  searchHfModels:        (query: string, cursor?: string | null) =>
    invoke<HfSearchPage>('search_hf_models', { query, cursor }),
  getHfModelDetail:      (repoId: string) =>
    invoke<HfModelDetail>('get_hf_model_detail', { repoId }),
  getByokSettings:       ()    => invoke<ByokProvider[]>('get_byok_settings'),
  saveByokProvider:      (providerId: string, enabled: boolean, apiKey: string, baseUrl?: string | null, defaultModel?: string | null) =>
    invoke<void>('save_byok_provider', { providerId, enabled, apiKey, baseUrl, defaultModel }),
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
  feralSendMessage:         (content: string, sessionId: string) =>
    invoke<string>('feral_send_message', { content, sessionId }),
  feralAgentStatus:         () => invoke<boolean>('feral_agent_status'),
  feralSetModel: (
    source: string,
    model: string,
    providerId?: string | null,
    baseUrl?: string | null,
  ) => invoke<void>('feral_set_model', { source, model, providerId, baseUrl }),
  feralGetModelConfig:      () => invoke<FeralModelConfigView | null>('feral_get_model_config'),
  listOllamaModels:         (baseUrl: string) => invoke<string[]>('list_ollama_models', { baseUrl }),
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
    save:     async (id: string, title: string, msgs: PersistedMessage[]) =>
      raw.saveConversation(id, title, msgs),
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

  system: {
    info: async () => raw.getSystemInfo(),
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

  feralAgent: {
    sendMessage: async (content: string, sessionId: string) =>
      raw.feralSendMessage(content, sessionId),
    status:      async () => raw.feralAgentStatus(),
  },

  agents: {
    getPresets: async () => raw.getAgentPresets(),
    save:       async (cfg: AgentConfig) => raw.saveAgent(cfg),
    getAll:     async () => raw.getAgents(),
    delete:     async (id: string) => raw.deleteAgent(id),
    run:        async (agentId: string, prompt: string, sessionId: string) =>
      raw.runAgent(agentId, prompt, sessionId),
  },
};

export { events } from './events';
