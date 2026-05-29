// IPC façade — three usage patterns:
//
//   tauri.chat.stream(...)       → throws on error (default; idiomatic React)
//   tauri.raw.chatStream(...)    → returns Result<T, string> unchanged
//
// Use tauri.raw.* when errors are EXPECTED UX (e.g., model-path validation,
// "does this file exist" probes). Use the unwrapping API everywhere else.
//
// Domain groups exist so components see ~5 functions per domain rather than
// 29 flat names.

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

// ── Types (mirrors Rust IPC structs, generated via tauri-specta) ─────────────
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

export interface HfModelSummary {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  lastModified: string;
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
  lastModified: string;
  tags: string[];
  ggufFiles: HfFile[];
  readme: string | null;
}

export interface HfSearchPage {
  models: HfModelSummary[];
  nextCursor: string | null;
}

export interface Settings {
  models_dir: string;
  default_gpu_layers: number;
  api_server_enabled: boolean;
  api_port: number;
  version: string;
}
export interface PersistedMessage  { role: string; content: string }
export interface ConversationSummary { id: string; title: string; updated_at: string }
export interface Conversation {
  id: string; title: string;
  created_at: string; updated_at: string;
  messages: PersistedMessage[];
}

// ── Result type (tauri-specta wraps returns in this) ─────────────────────────
type Result<T, E> = { status: 'ok'; data: T } | { status: 'error'; error: E };

function unwrap<T>(r: Result<T, string>): T {
  if (r.status === 'error') throw new Error(r.error);
  return r.data;
}

// ── Raw invoke helpers (mirrors specta-generated commands object) ─────────────
// These are the same as tauri.raw.* — typed thin wrappers over invoke().
const raw = {
  getModels:             ()    => invoke<Result<ModelInfo[], string>>('get_models'),
  getLoadedModel:        ()    => invoke<LoadedModel | null>('get_loaded_model'),
  loadModel:             (path: string) => invoke<Result<LoadedModel, string>>('load_model', { path }),
  startModelLoad:        (path: string) => invoke<Result<LoadedModel, string>>('start_model_load', { path }),
  unloadModel:           ()    => invoke<void>('unload_model'),
  deleteModel:           (path: string) => invoke<Result<void, string>>('delete_model', { path }),
  chatStream:            (messages: Message[], params: InferParams, sessionId: string) =>
    invoke<Result<void, string>>('chat_stream', { messages, params, session_id: sessionId }),
  stopGeneration:        ()    => invoke<void>('stop_generation'),
  downloadModel:         (repoId: string, filename: string) =>
    invoke<Result<string, string>>('download_model', { repo_id: repoId, filename }),
  cancelDownload:        (modelId: string) =>
    invoke<Result<void, string>>('cancel_download', { model_id: modelId }),
  getModelSizeInfo:      (repoId: string, filename: string) =>
    invoke<Result<number, string>>('get_model_size_info', { repo_id: repoId, filename }),
  getSystemInfo:         ()    => invoke<SystemInfo>('get_system_info'),
  saveAgent:             (cfg: object) => invoke<Result<void, string>>('save_agent', { cfg }),
  getAgents:             ()    => invoke<Result<object[], string>>('get_agents'),
  deleteAgent:           (id: string) => invoke<Result<void, string>>('delete_agent', { id }),
  getAgentPresets:       ()    => invoke<object[]>('get_agent_presets'),
  saveConversation:      (id: string, title: string, messages: PersistedMessage[]) =>
    invoke<Result<void, string>>('save_conversation', { id, title, messages }),
  loadConversations:     ()    => invoke<Result<ConversationSummary[], string>>('load_conversations'),
  loadConversation:      (id: string) => invoke<Result<Conversation, string>>('load_conversation', { id }),
  deleteConversation:    (id: string) => invoke<Result<void, string>>('delete_conversation', { id }),
  clearAllConversations: ()    => invoke<Result<void, string>>('clear_all_conversations'),
  getSettings:           ()    => invoke<Settings>('get_settings'),
  saveSettings:          (settings: Settings) => invoke<Result<void, string>>('save_settings', { settings }),
  searchHfModels:        (query: string, cursor?: string | null) =>
    invoke<Result<HfSearchPage, string>>('search_hf_models', { query, cursor }),
  getHfModelDetail:      (repoId: string) => invoke<Result<HfModelDetail, string>>('get_hf_model_detail', { repo_id: repoId }),
  getByokSettings:       ()    => invoke<object[]>('get_byok_settings'),
  saveByokProvider:      (providerId: string, enabled: boolean, apiKey: string, baseUrl?: string | null, defaultModel?: string | null) =>
    invoke<Result<void, string>>('save_byok_provider', { provider_id: providerId, enabled, api_key: apiKey, base_url: baseUrl, default_model: defaultModel }),
  testByokProvider:      (providerId: string, apiKey: string, baseUrl?: string | null) =>
    invoke<Result<object, string>>('test_byok_provider', { provider_id: providerId, api_key: apiKey, base_url: baseUrl }),
};

// ── Public façade ─────────────────────────────────────────────────────────────
export const tauri = {
  raw,

  chat: {
    stream: async (messages: Message[], params: InferParams, sessionId: string) =>
      unwrap(await raw.chatStream(messages, params, sessionId)),
    stop: async () => raw.stopGeneration(),
  },

  conversations: {
    list:     async () => unwrap(await raw.loadConversations()),
    load:     async (id: string) => unwrap(await raw.loadConversation(id)),
    save:     async (id: string, title: string, msgs: PersistedMessage[]) =>
      unwrap(await raw.saveConversation(id, title, msgs)),
    delete:   async (id: string) => unwrap(await raw.deleteConversation(id)),
    clearAll: async () => unwrap(await raw.clearAllConversations()),
  },

  models: {
    list:      async () => unwrap(await raw.getModels()),
    loaded:    async () => raw.getLoadedModel(),
    load:      async (path: string) => unwrap(await raw.loadModel(path)),
    startLoad: async (path: string) => unwrap(await raw.startModelLoad(path)),
    unload:    async () => raw.unloadModel(),
    delete:    async (path: string) => unwrap(await raw.deleteModel(path)),
  },

  settings: {
    get:  async () => raw.getSettings(),
    save: async (s: Settings) => unwrap(await raw.saveSettings(s)),
  },

  hf: {
    search:        async (query: string, cursor?: string | null) =>
      unwrap(await raw.searchHfModels(query, cursor)),
    detail:        async (repoId: string) =>
      unwrap(await raw.getHfModelDetail(repoId)),
    modelSizeInfo: async (repoId: string, filename: string) =>
      unwrap(await raw.getModelSizeInfo(repoId, filename)),
  },

  download: {
    start:  async (repoId: string, filename: string) =>
      unwrap(await raw.downloadModel(repoId, filename)),
    cancel: async (modelId: string) =>
      unwrap(await raw.cancelDownload(modelId)),
  },

  system: {
    info: async () => raw.getSystemInfo(),
  },
};

export { events } from './events';
