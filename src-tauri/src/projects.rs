use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::paths;

/// A file added to a project: a copy kept in the project's folder, which the
/// agent reads with its file tools (spec 9). Nothing is embedded or uploaded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ProjectFile {
    pub name: String,
    /// Absolute path of the copy.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub conversation_ids: Vec<String>,
    /// Added to the system prompt of every chat in the project. `default` so a
    /// `projects.json` written before instructions existed still loads.
    #[serde(default)]
    pub instructions: String,
    #[serde(default)]
    pub files: Vec<ProjectFile>,
}

/// Where a project's files are copied: under the agent's scratch folder
/// (`<profile>/workspace`), because that is the one place inside the profile
/// its file tools may read (the self-protection wall, `resolveAllowedPath` in
/// the sidecar). A copy anywhere else in the profile could never be opened.
fn files_dir_for(dir: &Path, id: &str) -> Result<PathBuf> {
    let safe = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    anyhow::ensure!(safe, "not a project id: {id:?}");
    Ok(dir.join("workspace").join("projects").join(id))
}

/// A bare file name, or an error: never a path that could leave the folder.
fn plain_name(name: &str) -> Result<&str> {
    let ok = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name);
    anyhow::ensure!(ok, "not a file name: {name:?}");
    Ok(name)
}

/// Copy `src` into the project's folder. A name already taken gets " (2)",
/// " (3)"... so adding a second `notes.txt` never overwrites the first.
pub fn add_file_to(dir: &Path, id: &str, src: &Path) -> Result<ProjectFile> {
    let folder = files_dir_for(dir, id)?;
    anyhow::ensure!(src.is_file(), "not a file: {}", src.display());
    let original = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("the file has no usable name"))?;
    std::fs::create_dir_all(&folder)?;
    let (stem, ext) = match original.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (original.to_string(), String::new()),
    };
    let mut name = original.to_string();
    let mut n = 2;
    while folder.join(&name).exists() {
        name = format!("{stem} ({n}){ext}");
        n += 1;
    }
    let dest = folder.join(&name);
    std::fs::copy(src, &dest)?;
    Ok(ProjectFile { name, path: dest.to_string_lossy().into_owned() })
}

/// Delete one copied file. Gone already is fine: the list is what matters.
pub fn remove_file_from(dir: &Path, id: &str, name: &str) -> Result<()> {
    let path = files_dir_for(dir, id)?.join(plain_name(name)?);
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
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

/// Serialises the read-modify-write below.
///
/// Both `save_to` and `delete_from` load the whole list, change one entry and
/// write it back. Two of them running at once — the UI saves a project while a
/// background task deletes another — each read the same "before" and each write
/// their own "after": one of the two changes is simply gone, with no error to
/// notice. A process-wide lock is enough because this file has exactly one
/// writer process, the desktop host.
static PROJECTS_WRITE: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

pub fn save_to(dir: &Path, project: &ProjectSummary) -> Result<()> {
    let _guard = PROJECTS_WRITE.lock();
    std::fs::create_dir_all(dir)?;
    let mut list = load_all_from(dir)?;
    match list.iter_mut().find(|p| p.id == project.id) {
        Some(existing) => *existing = project.clone(),
        None => list.push(project.clone()),
    }
    cinderpaw_core::atomic_file::write_atomic(
        &projects_path_for(dir),
        &serde_json::to_vec_pretty(&list)?,
    )?;
    Ok(())
}

pub fn delete_from(dir: &Path, id: &str) -> Result<()> {
    let _guard = PROJECTS_WRITE.lock();
    std::fs::create_dir_all(dir)?;
    let mut list = load_all_from(dir)?;
    list.retain(|p| p.id != id);
    cinderpaw_core::atomic_file::write_atomic(
        &projects_path_for(dir),
        &serde_json::to_vec_pretty(&list)?,
    )?;
    // The copies go with the project; the originals were never touched.
    if let Ok(folder) = files_dir_for(dir, id) {
        let _ = std::fs::remove_dir_all(folder);
    }
    Ok(())
}

// ── Tauri-facing wrappers ──────────────────────────────────────────────────────

pub fn load_all() -> Result<Vec<ProjectSummary>> {
    paths::ensure_dirs()?;
    load_all_from(&paths::cinderpaw_dir())
}

pub fn save(project: &ProjectSummary) -> Result<()> {
    paths::ensure_dirs()?;
    save_to(&paths::cinderpaw_dir(), project)
}

pub fn delete(id: &str) -> Result<()> {
    paths::ensure_dirs()?;
    delete_from(&paths::cinderpaw_dir(), id)
}

/// The stored project, for a save that leaves instructions or files unsaid.
pub fn find(id: &str) -> Result<Option<ProjectSummary>> {
    paths::ensure_dirs()?;
    Ok(load_all_from(&paths::cinderpaw_dir())?.into_iter().find(|p| p.id == id))
}

pub fn add_file(id: &str, src: &Path) -> Result<ProjectFile> {
    paths::ensure_dirs()?;
    add_file_to(&paths::cinderpaw_dir(), id, src)
}

pub fn remove_file(id: &str, name: &str) -> Result<()> {
    paths::ensure_dirs()?;
    remove_file_from(&paths::cinderpaw_dir(), id, name)
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("cinderpaw_proj_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn proj(id: &str, name: &str, ids: Vec<&str>) -> ProjectSummary {
        ProjectSummary {
            id: id.to_string(),
            name: name.to_string(),
            conversation_ids: ids.into_iter().map(String::from).collect(),
            instructions: String::new(),
            files: vec![],
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

    #[test]
    fn an_old_projects_json_loads_with_empty_instructions_and_no_files() {
        let dir = tmp();
        std::fs::write(
            projects_path_for(&dir),
            r#"[{"id":"p1","name":"Work","conversation_ids":["c1"]}]"#,
        )
        .unwrap();
        let list = load_all_from(&dir).unwrap();
        assert_eq!(list[0].instructions, "");
        assert!(list[0].files.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_is_copied_into_the_scratch_folder_without_overwriting() {
        let dir = tmp();
        let src = dir.join("notes.txt");
        std::fs::write(&src, "a").unwrap();
        let first = add_file_to(&dir, "p1", &src).unwrap();
        let second = add_file_to(&dir, "p1", &src).unwrap();
        assert_eq!(first.name, "notes.txt");
        assert_eq!(second.name, "notes (2).txt");
        let folder = dir.join("workspace").join("projects").join("p1");
        assert!(folder.join("notes.txt").is_file());
        assert!(folder.join("notes (2).txt").is_file());

        remove_file_from(&dir, "p1", "notes.txt").unwrap();
        assert!(!folder.join("notes.txt").exists());
        // Gone already is not an error.
        remove_file_from(&dir, "p1", "notes.txt").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ids_and_names_cannot_leave_the_project_folder() {
        let dir = tmp();
        let src = dir.join("x.txt");
        std::fs::write(&src, "x").unwrap();
        assert!(add_file_to(&dir, "../evil", &src).is_err());
        assert!(add_file_to(&dir, "", &src).is_err());
        assert!(remove_file_from(&dir, "p1", "../projects.json").is_err());
        assert!(remove_file_from(&dir, "p1", "..").is_err());
        assert!(remove_file_from(&dir, "p1", "a/b.txt").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deleting_a_project_removes_its_copies() {
        let dir = tmp();
        let src = dir.join("x.txt");
        std::fs::write(&src, "x").unwrap();
        save_to(&dir, &proj("p1", "Alpha", vec![])).unwrap();
        add_file_to(&dir, "p1", &src).unwrap();
        delete_from(&dir, "p1").unwrap();
        assert!(!dir.join("workspace").join("projects").join("p1").exists());
        assert!(src.is_file(), "the original is never touched");
        std::fs::remove_dir_all(&dir).ok();
    }
}
