use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub conversation_ids: Vec<String>,
}

fn projects_path_for(dir: &Path) -> PathBuf {
    dir.join("projects.json")
}

pub fn load_all_from(dir: &Path) -> Result<Vec<ProjectSummary>> {
    let path = projects_path_for(dir);
    if !path.exists() {
        return Ok(vec![]);
    }
    let bytes = std::fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn save_to(dir: &Path, project: &ProjectSummary) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut list = load_all_from(dir)?;
    match list.iter_mut().find(|p| p.id == project.id) {
        Some(existing) => *existing = project.clone(),
        None => list.push(project.clone()),
    }
    std::fs::write(projects_path_for(dir), serde_json::to_vec_pretty(&list)?)?;
    Ok(())
}

pub fn delete_from(dir: &Path, id: &str) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut list = load_all_from(dir)?;
    list.retain(|p| p.id != id);
    std::fs::write(projects_path_for(dir), serde_json::to_vec_pretty(&list)?)?;
    Ok(())
}

// ── Tauri-facing wrappers ──────────────────────────────────────────────────────

pub fn load_all() -> Result<Vec<ProjectSummary>> {
    paths::ensure_dirs()?;
    load_all_from(&paths::feral_dir())
}

pub fn save(project: &ProjectSummary) -> Result<()> {
    paths::ensure_dirs()?;
    save_to(&paths::feral_dir(), project)
}

pub fn delete(id: &str) -> Result<()> {
    paths::ensure_dirs()?;
    delete_from(&paths::feral_dir(), id)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("feral_proj_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn proj(id: &str, name: &str, ids: Vec<&str>) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: name.to_string(),
            conversation_ids: ids.into_iter().map(String::from).collect(),
        }
    }

    #[test]
    fn empty_dir_returns_empty_list() {
        let dir = tmp();
        assert!(load_all_from(&dir).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tmp();
        save_to(&dir, &proj("p1", "Work", vec!["c1", "c2"])).unwrap();
        let list = load_all_from(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "p1");
        assert_eq!(list[0].name, "Work");
        assert_eq!(list[0].conversation_ids, vec!["c1", "c2"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_upserts_without_duplicating() {
        let dir = tmp();
        save_to(&dir, &proj("p1", "Work", vec!["c1"])).unwrap();
        save_to(&dir, &proj("p1", "Work Renamed", vec!["c1", "c2"])).unwrap();
        let list = load_all_from(&dir).unwrap();
        assert_eq!(list.len(), 1, "should still be one project after upsert");
        assert_eq!(list[0].name, "Work Renamed");
        assert_eq!(list[0].conversation_ids.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_removes_project_from_list() {
        let dir = tmp();
        save_to(&dir, &proj("p1", "Alpha", vec![])).unwrap();
        save_to(&dir, &proj("p2", "Beta", vec![])).unwrap();
        delete_from(&dir, "p1").unwrap();
        let list = load_all_from(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "p2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_nonexistent_is_noop() {
        let dir = tmp();
        save_to(&dir, &proj("p1", "Alpha", vec![])).unwrap();
        delete_from(&dir, "ghost").unwrap();
        assert_eq!(load_all_from(&dir).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
