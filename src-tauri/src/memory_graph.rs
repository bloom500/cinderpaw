use std::collections::HashMap;
use serde_json::{json, Value};

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

#[derive(serde::Deserialize, specta::Type)]
pub struct MemoryFactInput {
    pub subject: String,
    pub predicate: String,
    pub object: String,
}

/// Merge extracted facts into `~/.feral/memory-graph.json` using the exact
/// node/edge schema the agent sidecar's MemoryGraph writes, so both the
/// sidecar and the Chat tab feed one shared knowledge graph. Returns the
/// number of facts written. The whole read-modify-write is held under an
/// exclusive advisory lockfile shared with the TS sidecar; no concurrent
/// writer can interleave.
#[tauri::command]
#[specta::specta]
pub fn add_memory_facts(facts: Vec<MemoryFactInput>) -> Result<u32, String> {
    if facts.is_empty() {
        return Ok(0);
    }
    let dir = crate::paths::feral_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("memory-graph.json");

    // ponytail: whole read-modify-write is wrapped under an exclusive lockfile so the TS sidecar (MemoryGraph) and this command never write concurrently.
    with_file_lock(&path, || -> Result<u32, String> {
    let mut graph: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({ "nodes": {}, "edges": [], "version": 1 }));

    if !graph.get("nodes").map(Value::is_object).unwrap_or(false) {
        graph["nodes"] = json!({});
    }
    if !graph.get("edges").map(Value::is_array).unwrap_or(false) {
        graph["edges"] = json!([]);
    }

    let now = chrono_now_ms();
    let mut written = 0u32;

    for fact in &facts {
        let subject = fact.subject.trim();
        let object = fact.object.trim();
        let predicate = fact.predicate.trim();
        if subject.is_empty() || object.is_empty() || predicate.is_empty() {
            continue;
        }
        if subject.len() > 120 || object.len() > 300 || predicate.len() > 60 {
            continue;
        }
        let s_id = normalize_id(subject);
        let o_id = normalize_id(object);

        upsert_node(&mut graph["nodes"], &s_id, subject, "entity", now);
        upsert_node(&mut graph["nodes"], &o_id, object, "concept", now);

        let edges = graph["edges"].as_array_mut().expect("edges is array");
        let exists = edges.iter().any(|e| {
            e.get("from").and_then(Value::as_str) == Some(s_id.as_str())
                && e.get("to").and_then(Value::as_str) == Some(o_id.as_str())
                && e.get("relation").and_then(Value::as_str) == Some(predicate)
        });
        if !exists {
            edges.push(json!({
                "from": s_id,
                "to": o_id,
                "relation": predicate,
                "weight": 1,
                "createdAt": now,
            }));
        }
        written += 1;
    }

    if written > 0 {
        let serialized = serde_json::to_string_pretty(&graph).map_err(|e| e.to_string())?;
        atomic_write(&path, &serialized)?;
    }
    Ok(written)
    })
}

fn normalize_id(label: &str) -> String {
    label.to_lowercase().split_whitespace().collect::<Vec<_>>().join("_")
}

fn upsert_node(nodes: &mut Value, id: &str, label: &str, node_type: &str, now: u64) {
    let map = nodes.as_object_mut().expect("nodes is object");
    match map.get_mut(id) {
        Some(existing) => {
            existing["touchedAt"] = json!(now);
        }
        None => {
            map.insert(
                id.to_string(),
                json!({
                    "id": id,
                    "label": label,
                    "type": node_type,
                    "createdAt": now,
                    "touchedAt": now,
                    "properties": {},
                }),
            );
        }
    }
}

fn chrono_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

// ponytail: hand-rolled advisory file lock; cross-process via O_EXCL lockfile.
// Mirrors FeralAgent/src/memory/graph.ts withFileLock contract — both sides share the same
// `.lock` file so TS and Rust never write the memory graph concurrently.
// 30s stale-lock ceiling assumes no legitimate write holds longer than that.
fn lock_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".lock");
    s.into()
}

fn tmp_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".tmp");
    s.into()
}

/// How long a lock file may sit untouched before it is treated as a corpse.
const LOCK_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

fn with_file_lock<F, T>(path: &std::path::Path, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let lp = lock_path(path);
    let start = std::time::Instant::now();
    // Wait at least as long as we are willing to call a lock dead. With a 5s
    // wait against a 30s staleness rule there was a whole band — a writer
    // holding the lock legitimately for 6 to 30 seconds, which a large embed
    // batch or an RSI compaction really does — where the caller gave up with
    // "lock timeout" on a perfectly healthy system, and the user saw a failure
    // where the correct behaviour was to wait a moment longer.
    let timeout = LOCK_STALE_AFTER + std::time::Duration::from_secs(5);
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lp)
        {
            Ok(_) => break,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(e.to_string());
                }
                if let Ok(meta) = std::fs::metadata(&lp) {
                    if let Ok(modified) = meta.modified() {
                        if modified.elapsed().unwrap_or(std::time::Duration::MAX)
                            > LOCK_STALE_AFTER
                        {
                            let _ = std::fs::remove_file(&lp);
                            continue;
                        }
                    }
                }
                if start.elapsed() > timeout {
                    return Err(format!("lock timeout on {}", path.display()));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    let result = f();
    let _ = std::fs::remove_file(&lp);
    result
}

fn atomic_write(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let tmp = tmp_path(path);
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}
