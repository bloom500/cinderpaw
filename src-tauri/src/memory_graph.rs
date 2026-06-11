use std::collections::HashMap;

#[derive(serde::Serialize, specta::Type)]
pub struct MemoryGraphSnapshot {
    pub nodes: Vec<MemoryGraphNodeView>,
    pub edges: Vec<MemoryGraphEdgeView>,
}

#[derive(serde::Serialize, specta::Type)]
pub struct MemoryGraphNodeView {
    pub id: String,
    pub label: String,
    pub r#type: String,
    #[specta(type = specta_typescript::Number)]
    pub touched_at: u64,
}

#[derive(serde::Serialize, specta::Type)]
pub struct MemoryGraphEdgeView {
    pub from: String,
    pub to: String,
    pub relation: String,
}

#[tauri::command]
#[specta::specta]
pub fn get_memory_graph() -> MemoryGraphSnapshot {
    let path = crate::paths::feral_dir().join("memory-graph.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_default();

    #[derive(serde::Deserialize)]
    struct RawNode {
        id: String,
        label: String,
        #[serde(rename = "type")]
        node_type: String,
        #[serde(rename = "touchedAt")]
        touched_at: u64,
    }
    #[derive(serde::Deserialize)]
    struct RawEdge {
        from: String,
        to: String,
        relation: String,
    }
    #[derive(serde::Deserialize)]
    struct RawGraph {
        #[serde(default)]
        nodes: HashMap<String, RawNode>,
        #[serde(default)]
        edges: Vec<RawEdge>,
    }

    let g: RawGraph = serde_json::from_str(&raw).unwrap_or_else(|_| RawGraph {
        nodes: HashMap::new(),
        edges: vec![],
    });

    MemoryGraphSnapshot {
        nodes: g
            .nodes
            .into_values()
            .map(|n| MemoryGraphNodeView {
                id: n.id,
                label: n.label,
                r#type: n.node_type,
                touched_at: n.touched_at,
            })
            .collect(),
        edges: g
            .edges
            .into_iter()
            .map(|e| MemoryGraphEdgeView {
                from: e.from,
                to: e.to,
                relation: e.relation,
            })
            .collect(),
    }
}
