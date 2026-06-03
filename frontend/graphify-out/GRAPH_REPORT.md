# Graph Report - D:/FeralLocalAI/frontend  (2026-05-24)

## Corpus Check
- Corpus is ~2,646 words - fits in a single context window. You may not need a graph.

## Summary
- 69 nodes · 69 edges · 18 communities (11 shown, 7 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 30,161 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Data Types  Shared Types|Data Types / Shared Types]]
- [[_COMMUNITY_Tauri Bridge  IPC Layer|Tauri Bridge / IPC Layer]]
- [[_COMMUNITY_UI Components|UI Components]]
- [[_COMMUNITY_Agents Page|Agents Page]]
- [[_COMMUNITY_Models Page|Models Page]]
- [[_COMMUNITY_Tauri Bridge Module|Tauri Bridge Module]]
- [[_COMMUNITY_Agents Module|Agents Module]]
- [[_COMMUNITY_Standalone Functions|Standalone Functions]]
- [[_COMMUNITY_Standalone Functions|Standalone Functions]]
- [[_COMMUNITY_Standalone Functions|Standalone Functions]]
- [[_COMMUNITY_HTML Entry Point|HTML Entry Point]]
- [[_COMMUNITY_Pages Module|Pages Module]]

## God Nodes (most connected - your core abstractions)
1. `invoke Function` - 7 edges
2. `AgentsPage Component` - 7 edges
3. `invoke_unit Function` - 6 edges
4. `App Router Component` - 5 edges
5. `ModelsPage Component` - 5 edges
6. `ChatPage Component` - 5 edges
7. `SettingsPage Component` - 4 edges
8. `InferParams Struct` - 4 edges
9. `ToolType Enum` - 4 edges
10. `AgentConfig Struct` - 4 edges

## Surprising Connections (you probably didn't know these)
- `refresh Function (Models)` --calls--> `invoke Function`  [EXTRACTED]
  src/pages/models.rs → src/tauri_bridge.rs
- `App Router Component` --calls--> `ModelsPage Component`  [EXTRACTED]
  src/main.rs → src/pages/models.rs
- `App Router Component` --calls--> `AgentsPage Component`  [EXTRACTED]
  src/main.rs → src/pages/agents.rs
- `App Router Component` --calls--> `SettingsPage Component`  [EXTRACTED]
  src/main.rs → src/pages/settings.rs
- `do_load Function` --calls--> `invoke Function`  [EXTRACTED]
  src/pages/models.rs → src/tauri_bridge.rs

## Hyperedges (group relationships)
- **LLM Inference Flow** — chat_page, send_function, streaming_event_pattern, infer_params_struct, loaded_model_struct [EXTRACTED 1.00]
- **Model Management Flow** — models_page, refresh_function_models, do_load_function, do_unload_function, do_delete_function, do_download_function, model_info_struct [EXTRACTED 1.00]
- **Agent Execution Flow** — agents_page, agent_editor_component, do_run, invoke_function, agent_config_struct, tool_type_enum [EXTRACTED 1.00]

## Communities (18 total, 7 thin omitted)

### Community 0 - "Data Types / Shared Types"
Cohesion: 0.15
Nodes (8): AgentConfig, InferParams, LoadedModel, Message, ModelInfo, Settings, SystemInfo, ToolType

### Community 1 - "Tauri Bridge / IPC Layer"
Cohesion: 0.20
Nodes (11): do_delete Function, do_download Function, do_load Function, do_unload Function, invoke Function, invoke_json Function, invoke_unit Function, listen Function (+3 more)

### Community 2 - "UI Components"
Cohesion: 0.29
Nodes (8): App Router Component, ChatPage Component, InferParams Struct, Message Struct, NavItem Component, send Function, Sidebar Navigation Component, Tauri Channel Streaming Pattern

### Community 3 - "Agents Page"
Cohesion: 0.70
Nodes (5): AgentConfig Struct, AgentEditor Component, AgentsPage Component, human_bytes Function, ToolType Enum

### Community 4 - "Models Page"
Cohesion: 0.50
Nodes (5): LoadedModel Struct, ModelInfo Struct, ModelsPage Component, refresh Function (Models), SystemInfo Struct

## Knowledge Gaps
- **22 isolated node(s):** `ModelInfo`, `LoadedModel`, `SystemInfo`, `Message`, `AgentConfig` (+17 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AgentsPage Component` connect `Agents Page` to `Tauri Bridge / IPC Layer`, `UI Components`, `Models Page`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `invoke Function` connect `Tauri Bridge / IPC Layer` to `UI Components`, `Agents Page`, `Models Page`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Why does `App Router Component` connect `UI Components` to `Tauri Bridge / IPC Layer`, `Agents Page`, `Models Page`?**
  _High betweenness centrality (0.043) - this node is a cross-community bridge._
- **What connects `ModelInfo`, `LoadedModel`, `SystemInfo` to the rest of the system?**
  _23 weakly-connected nodes found - possible documentation gaps or missing edges._