// IPC façade
//
// Tauri returns T directly on success and throws a string on Err.
// Domain groups keep components to ~5 imports each.

import { invoke } from '@tauri-apps/api/core';
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
  saveAgent:             (cfg: object) => invoke<void>('save_agent', { cfg }),
  getAgents:             ()    => invoke<object[]>('get_agents'),
  deleteAgent:           (id: string) => invoke<void>('delete_agent', { id }),
  getAgentPresets:       ()    => invoke<object[]>('get_agent_presets'),
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
};

export { events } from './events';
