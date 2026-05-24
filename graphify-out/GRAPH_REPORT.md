# Graph Report - .  (2026-05-24)

## Corpus Check
- Corpus is ~13,579 words - fits in a single context window. You may not need a graph.

## Summary
- 246 nodes · 302 edges · 34 communities (23 shown, 11 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.89)
- Token cost: 4,200 input · 1,800 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Agent Execution & API Types|Agent Execution & API Types]]
- [[_COMMUNITY_Ollama-Compatible HTTP API|Ollama-Compatible HTTP API]]
- [[_COMMUNITY_Tauri IPC Commands|Tauri IPC Commands]]
- [[_COMMUNITY_App Config & Window Settings|App Config & Window Settings]]
- [[_COMMUNITY_Inference Engine & GPU|Inference Engine & GPU]]
- [[_COMMUNITY_Frontend Shared Types|Frontend Shared Types]]
- [[_COMMUNITY_Tool Execution (webfilecode)|Tool Execution (web/file/code)]]
- [[_COMMUNITY_Agent Loop & Parsing|Agent Loop & Parsing]]
- [[_COMMUNITY_Tool Types & Dispatch|Tool Types & Dispatch]]
- [[_COMMUNITY_Model Download & Modelfile|Model Download & Modelfile]]
- [[_COMMUNITY_Cargo Workspace & Build|Cargo Workspace & Build]]
- [[_COMMUNITY_Capabilities & Permissions|Capabilities & Permissions]]
- [[_COMMUNITY_Directory Paths|Directory Paths]]
- [[_COMMUNITY_Settings Persistence|Settings Persistence]]
- [[_COMMUNITY_Models Page UI|Models Page UI]]
- [[_COMMUNITY_Chat Page UI|Chat Page UI]]
- [[_COMMUNITY_Agents Page UI|Agents Page UI]]
- [[_COMMUNITY_Settings Page UI|Settings Page UI]]
- [[_COMMUNITY_Tauri Bridge (WASM↔IPC)|Tauri Bridge (WASM↔IPC)]]
- [[_COMMUNITY_OpenAI Compatibility|OpenAI Compatibility]]
- [[_COMMUNITY_Trunk Build Config|Trunk Build Config]]
- [[_COMMUNITY_CSS Design System|CSS Design System]]
- [[_COMMUNITY_Icon Assets|Icon Assets]]
- [[_COMMUNITY_JSON Schema Defs|JSON Schema Defs]]
- [[_COMMUNITY_Stub Inference Mode|Stub Inference Mode]]
- [[_COMMUNITY_Error Handling|Error Handling]]

## God Nodes (most connected - your core abstractions)
1. `Backend Lib (Tauri Command Handler)` - 24 edges
2. `Models Page Component` - 13 edges
3. `Agents Page Component` - 11 edges
4. `Agent Engine (Backend)` - 11 edges
5. `ModelManager` - 9 edges
6. `Model File Manager` - 8 edges
7. `execute()` - 7 edges
8. `Frontend Main (Leptos App Entry)` - 7 edges
9. `Tauri Bridge (WASM IPC Layer)` - 7 edges
10. `Chat Page Component` - 7 edges

## Surprising Connections (you probably didn't know these)
- `InferParams Struct` --semantically_similar_to--> `Inference Engine (ModelManager)`  [INFERRED] [semantically similar]
  frontend/src/pages/types.rs → src-tauri/src/inference.rs
- `Message Struct` --semantically_similar_to--> `Inference Engine (ModelManager)`  [INFERRED] [semantically similar]
  frontend/src/pages/types.rs → src-tauri/src/inference.rs
- `ModelInfo Struct` --semantically_similar_to--> `ModelInfo Struct (Backend)`  [INFERRED] [semantically similar]
  frontend/src/pages/types.rs → src-tauri/src/models.rs
- `AgentConfig Struct` --semantically_similar_to--> `AgentConfig Struct (Backend)`  [INFERRED] [semantically similar]
  frontend/src/pages/types.rs → src-tauri/src/agents.rs
- `Tauri App Configuration` --references--> `Frontend Main (Leptos App Entry)`  [INFERRED]
  src-tauri/tauri.conf.json → frontend/src/main.rs

## Hyperedges (group relationships)
- **Tauri IPC Boundary (Frontend invokes Backend Commands)** — frontend_tauri_bridge, ipc_chat_stream, ipc_run_agent, ipc_download_model, ipc_get_models, ipc_load_model, ipc_unload_model, ipc_delete_model, ipc_get_agents, ipc_save_agent, ipc_delete_agent, ipc_get_agent_presets, ipc_get_settings, ipc_save_settings, ipc_get_loaded_model, ipc_get_system_info [EXTRACTED 1.00]
- **Frontend Page Components** — pages_agents, pages_chat, pages_models, pages_settings [EXTRACTED 1.00]
- **Shared Frontend Data Types** — types_ModelInfo, types_LoadedModel, types_InferParams, types_Message, types_AgentConfig, types_ToolType, types_Settings, types_SystemInfo [EXTRACTED 1.00]
- **Backend Model Management Subsystem** — backend_models, backend_inference, backend_ModelManager, backend_paths, ipc_load_model, ipc_unload_model, ipc_get_models, ipc_delete_model, ipc_download_model [INFERRED 0.90]
- **Agent Execution Subsystem** — backend_agents, backend_AgentConfig, backend_AgentEvent, ipc_run_agent, ipc_get_agents, ipc_save_agent, ipc_delete_agent, ipc_get_agent_presets, pages_agents [INFERRED 0.90]
- **Backend Settings Load/Save Pipeline** — settings_rs_Settings, settings_rs_load, settings_rs_save, paths_module [EXTRACTED 1.00]
- **Tool Execution Dispatch Pipeline** — tools_rs_execute, tools_rs_ToolType, tools_rs_ToolCall, tools_rs_ToolResult, tools_rs_web_search, tools_rs_file_read, tools_rs_file_write, tools_rs_code_execute, tools_rs_http_request [EXTRACTED 1.00]
- **Frontend Shared Data Types** — types_rs_ModelInfo, types_rs_LoadedModel, types_rs_SystemInfo_frontend, types_rs_Message, types_rs_InferParams, types_rs_ToolType_frontend, types_rs_AgentConfig, types_rs_Settings_frontend [EXTRACTED 1.00]
- **Backend/Frontend Mirrored Data Structures** — settings_rs_Settings, types_rs_Settings_frontend, sysinfo_mod_rs_SystemInfo, types_rs_SystemInfo_frontend, tools_rs_ToolType, types_rs_ToolType_frontend [INFERRED 0.95]
- **Cargo Workspace Build System** — cargo_toml_workspace, frontend_cargo_toml, src_tauri_cargo_toml, frontend_trunk_toml, frontend_index_html [EXTRACTED 1.00]
- **System Info Collection Pipeline** — sysinfo_mod_rs_collect, sysinfo_mod_rs_SystemInfo, inference_module [EXTRACTED 1.00]

## Communities (34 total, 11 thin omitted)

### Community 0 - "Agent Execution & API Types"
Cohesion: 0.09
Nodes (48): AgentConfig Struct (Backend), AgentEvent Enum, ApiState, AppState (Tauri Managed State), ModelInfo Struct (Backend), ModelManager, Modelfile Struct, Agent Engine (Backend) (+40 more)

### Community 1 - "Ollama-Compatible HTTP API"
Cohesion: 0.15
Nodes (15): delete(), api_chat(), api_generate(), ApiState, ChatReq, collect_chat(), DeleteReq, GenerateReq (+7 more)

### Community 2 - "Tauri IPC Commands"
Cohesion: 0.11
Nodes (4): AppState, DownloadProgress, run(), run_agent()

### Community 3 - "App Config & Window Settings"
Cohesion: 0.11
Nodes (17): app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+9 more)

### Community 4 - "Inference Engine & GPU"
Cohesion: 0.15
Nodes (7): GpuInfo, InferParams, load(), LoadedModel, Message, ModelManager, unload()

### Community 5 - "Frontend Shared Types"
Cohesion: 0.15
Nodes (8): AgentConfig, InferParams, LoadedModel, Message, ModelInfo, Settings, SystemInfo, ToolType

### Community 6 - "Tool Execution (web/file/code)"
Cohesion: 0.23
Nodes (9): code_execute(), execute(), file_read(), file_write(), http_request(), ToolCall, ToolResult, ToolType (+1 more)

### Community 7 - "Agent Loop & Parsing"
Cohesion: 0.20
Nodes (6): AgentConfig, AgentEvent, extract_final(), extract_tool_call(), ParsedCall, run()

### Community 8 - "Tool Types & Dispatch"
Cohesion: 0.22
Nodes (11): ToolResult Struct, ToolType Enum (backend), tools::code_execute (Python/Shell), tools::execute Async Function, tools::file_read Function, tools::file_write Function, tools::http_request Function, tools::web_search (DuckDuckGo) (+3 more)

### Community 9 - "Model Download & Modelfile"
Cohesion: 0.32
Nodes (5): load_modelfile(), Modelfile, ModelInfo, parse_quant(), scan_models_dir()

### Community 10 - "Cargo Workspace & Build"
Cohesion: 0.29
Nodes (7): Cargo Workspace Root, Frontend Cargo.toml (feral-frontend), inference Module (backend), Backend Cargo.toml (feral), SystemInfo Struct (backend), sysinfo_mod::collect Function, SystemInfo Struct (frontend)

### Community 11 - "Capabilities & Permissions"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 12 - "Directory Paths"
Cohesion: 0.67
Nodes (5): agents_dir(), ensure_dirs(), feral_dir(), models_dir(), settings_path()

### Community 14 - "Settings Persistence"
Cohesion: 0.60
Nodes (5): paths Module (backend), Settings Struct (backend), settings::load Function, settings::save Function, Settings Struct (frontend)

### Community 18 - "Settings Page UI"
Cohesion: 0.67
Nodes (3): Frontend Entry HTML, Frontend Styles CSS, Frontend Trunk Build Config

## Knowledge Gaps
- **63 isolated node(s):** `ModelInfo`, `LoadedModel`, `SystemInfo`, `Message`, `AgentConfig` (+58 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `delete()` connect `Ollama-Compatible HTTP API` to `Agent Loop & Parsing`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **What connects `ModelInfo`, `LoadedModel`, `SystemInfo` to the rest of the system?**
  _63 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Agent Execution & API Types` be split into smaller, more focused modules?**
  _Cohesion score 0.08865248226950355 - nodes in this community are weakly interconnected._
- **Should `Tauri IPC Commands` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._
- **Should `App Config & Window Settings` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._