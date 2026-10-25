//! Scheduled tasks: the "every morning, summarise my inbox" jobs.
//!
//! Cinderpaw's schedules live in the sidecar's database, and the sidecar is the
//! only writer there, so each job goes to the import inbox as
//! `import/<source>/schedule-<id>.jsonl` and the sidecar adds it
//! (CinderpawAgent/src/memory/import-inbox.ts). They arrive **switched off**:
//! while the old agent still runs, the same job would fire twice.
//!
//! Where the jobs are:
//! - OpenClaw: `state/openclaw.sqlite`, table `cron_jobs` (current, read-only),
//!   or `cron/jobs.json` (older): schedule `cron` (+ tz) / `every` / `at`, and a
//!   payload `agentTurn` (message) or `systemEvent` (text). `heartbeat` jobs
//!   are OpenClaw's own and stay behind.
//! - Hermes: `cron/jobs.json`, `{jobs: [{id, name, prompt, skills, script,
//!   schedule: {kind: cron|interval|once, expr|minutes|run_at}, enabled}]}`
//!   (cron/jobs.py).

use serde_json::{json, Value};

use super::{Action, Found, Plan, PlanItem, Source};

pub struct Job {
    pub id: String,
    pub name: String,
    pub task: String,
    /// Cinderpaw's `Schedule` (CinderpawAgent/src/types.ts).
    pub schedule: Value,
    pub note: Option<String>,
}

fn s(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// An `at` time that has already passed ran (or was missed) in the old agent.
fn in_future(iso: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(iso).map(|t| t > now).unwrap_or(true)
}

/// One OpenClaw job from its parts; `Err` is the line for "Leaves behind".
#[allow(clippy::too_many_arguments)]
fn openclaw_job(
    id: String,
    name: Option<String>,
    kind: &str,
    expr: Option<String>,
    tz: Option<String>,
    every_ms: Option<i64>,
    at: Option<String>,
    payload_kind: &str,
    message: Option<String>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Job, String> {
    let label = name.clone().unwrap_or_else(|| id.clone());
    if payload_kind == "heartbeat" {
        return Err(format!("schedule {label} — OpenClaw's own check-in, not a task"));
    }
    let task = message.ok_or_else(|| format!("schedule {label} — has no task text"))?;
    let (schedule, note) = match (kind, expr, every_ms, at) {
        ("cron", Some(e), _, _) => (json!({ "kind": "cron", "expression": e }), tz.map(|t| format!("its times were in {t}"))),
        ("every", _, Some(ms), _) if ms > 0 => (json!({ "kind": "every", "intervalMs": ms }), None),
        ("at", _, _, Some(at)) if in_future(&at, now) => (json!({ "kind": "at", "isoTimestamp": at }), None),
        ("at", ..) => return Err(format!("schedule {label} — a one-off that already ran")),
        _ => return Err(format!("schedule {label} — a schedule Cinderpaw does not read")),
    };
    Ok(Job { name: name.unwrap_or_else(|| task.chars().take(50).collect()), id, task, schedule, note })
}

fn openclaw_sqlite(found: &Found, now: chrono::DateTime<chrono::Utc>) -> Vec<Result<Job, String>> {
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = rusqlite::Connection::open_with_flags(found.root.join("state/openclaw.sqlite"), flags) else { return vec![] };
    let sql = "SELECT job_id, name, schedule_kind, schedule_expr, schedule_tz, every_ms, at, payload_kind, payload_message \
               FROM cron_jobs ORDER BY sort_order, created_at_ms";
    let Ok(mut stmt) = conn.prepare(sql) else { return vec![] };
    let rows: Vec<Result<Job, String>> = match stmt.query_map([], |r| {
        Ok(openclaw_job(
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            &r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?.filter(|t| !t.is_empty()),
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<String>>(6)?,
            &r.get::<_, Option<String>>(7)?.unwrap_or_default(),
            r.get::<_, Option<String>>(8)?,
            now,
        ))
    }) {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => vec![],
    };
    rows
}

/// `{jobs: [...]}` or a bare array.
fn job_list(path: &std::path::Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return vec![] };
    v.get("jobs").cloned().unwrap_or(v).as_array().cloned().unwrap_or_default()
}

fn openclaw_json(found: &Found, now: chrono::DateTime<chrono::Utc>) -> Vec<Result<Job, String>> {
    job_list(&found.root.join("cron/jobs.json"))
        .iter()
        .map(|j| {
            let sch = j.get("schedule").cloned().unwrap_or_default();
            let payload = j.get("payload").cloned().unwrap_or_default();
            openclaw_job(
                s(j.get("id")).unwrap_or_default(),
                s(j.get("name")),
                &s(sch.get("kind")).unwrap_or_default(),
                s(sch.get("expr")),
                s(sch.get("tz")),
                sch.get("everyMs").and_then(|v| v.as_i64()),
                s(sch.get("at")),
                &s(payload.get("kind")).unwrap_or_default(),
                s(payload.get("message")).or_else(|| s(payload.get("text"))),
                now,
            )
        })
        .collect()
}

fn hermes_jobs(found: &Found, now: chrono::DateTime<chrono::Utc>) -> Vec<Result<Job, String>> {
    job_list(&found.root.join("cron/jobs.json"))
        .iter()
        .map(|j| {
            let id = s(j.get("id")).unwrap_or_default();
            let name = s(j.get("name"));
            let label = name.clone().unwrap_or_else(|| id.clone());
            let Some(prompt) = s(j.get("prompt")) else {
                return Err(format!("schedule {label} — runs a script; Cinderpaw schedules give the agent a task"));
            };
            let skills: Vec<String> = j.get("skills").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let task = if skills.is_empty() { prompt } else { format!("{prompt}\n\n(Use the skills: {}.)", skills.join(", ")) };
            let sch = j.get("schedule").cloned().unwrap_or_default();
            let schedule = match s(sch.get("kind")).as_deref() {
                Some("cron") => s(sch.get("expr")).map(|e| json!({ "kind": "cron", "expression": e })),
                Some("interval") => sch.get("minutes").and_then(|m| m.as_i64()).filter(|m| *m > 0).map(|m| json!({ "kind": "every", "intervalMs": m * 60_000 })),
                Some("once") => match s(sch.get("run_at")) {
                    Some(at) if in_future(&at, now) => Some(json!({ "kind": "at", "isoTimestamp": at })),
                    Some(_) => return Err(format!("schedule {label} — a one-off that already ran")),
                    None => None,
                },
                _ => None,
            };
            let schedule = schedule.ok_or_else(|| format!("schedule {label} — a schedule Cinderpaw does not read"))?;
            Ok(Job { name: name.unwrap_or_else(|| task.chars().take(50).collect()), id, task, schedule, note: None })
        })
        .collect()
}

/// Add the source's scheduled tasks to `plan`, one inbox file each.
pub fn plan_schedules_into(found: &Found, cinderpaw_dir: &std::path::Path, overwrite: bool, plan: &mut Plan) {
    let now = chrono::Utc::now();
    let (src, jobs) = match found.source {
        Source::OpenClaw => {
            let mut jobs = openclaw_sqlite(found, now);
            jobs.extend(openclaw_json(found, now));
            ("openclaw", jobs)
        }
        Source::Hermes => ("hermes", hermes_jobs(found, now)),
    };
    let mut seen = std::collections::BTreeSet::new();
    for job in jobs {
        let job = match job {
            Ok(j) => j,
            Err(line) => {
                plan.not_imported.push(line);
                continue;
            }
        };
        if !seen.insert(job.id.clone()) {
            continue;
        }
        // The id is part of the file name: keep it to plain characters.
        let safe: String = job.id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        let target = cinderpaw_dir.join("import").join(src).join(format!("schedule-{safe}.jsonl"));
        if target.exists() && !overwrite {
            plan.conflicts.push(format!("schedule {}: an earlier import is still waiting to be read, kept it", job.name));
            continue;
        }
        let line = json!({ "kind": "schedule", "id": format!("import-{src}-{safe}"), "text": job.name, "task": job.task, "schedule": job.schedule });
        let mut note = vec!["off until you turn it on in Tasks; the old agent may still run it".to_string()];
        note.extend(job.note);
        plan.will_import.push(PlanItem {
            what: format!("schedule: {}", job.name),
            target: target.display().to_string(),
            note: Some(note.join("; ")),
            source: found.root.join(match found.source {
                Source::OpenClaw => "state/openclaw.sqlite",
                Source::Hermes => "cron/jobs.json",
            }),
            action: Action::Write(format!("{line}\n")),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn empty_plan() -> Plan {
        Plan { will_import: vec![], not_imported: vec![], conflicts: vec![], backup_dir: std::path::PathBuf::from("b") }
    }

    #[test]
    fn hermes_cron_interval_once_and_script_jobs() {
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join("cron")).unwrap();
        fs::write(
            src.path().join("cron/jobs.json"),
            r#"{"jobs":[
              {"id":"a1","name":"Morning brief","prompt":"Summarise my inbox","skills":["gmail"],"schedule":{"kind":"cron","expr":"0 8 * * *"}},
              {"id":"b2","prompt":"Check the build","schedule":{"kind":"interval","minutes":30}},
              {"id":"c3","name":"Old one-off","prompt":"x","schedule":{"kind":"once","run_at":"2020-01-01T00:00:00Z"}},
              {"id":"d4","name":"Backup","script":"backup.sh","schedule":{"kind":"cron","expr":"0 3 * * *"}}]}"#,
        )
        .unwrap();
        let found = Found { source: Source::Hermes, root: src.path().to_path_buf(), config: src.path().join("config.yaml"), version: None };
        let home = tempdir().unwrap();
        let mut plan = empty_plan();
        plan_schedules_into(&found, home.path(), false, &mut plan);
        let what: Vec<_> = plan.will_import.iter().map(|i| i.what.as_str()).collect();
        assert_eq!(what, ["schedule: Morning brief", "schedule: Check the build"]);
        assert_eq!(plan.not_imported.len(), 2);
        super::super::apply(&plan).unwrap();
        let line = fs::read_to_string(home.path().join("import/hermes/schedule-a1.jsonl")).unwrap();
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["schedule"], json!({ "kind": "cron", "expression": "0 8 * * *" }));
        assert_eq!(v["task"], "Summarise my inbox\n\n(Use the skills: gmail.)");
        let every: Value = serde_json::from_str(fs::read_to_string(home.path().join("import/hermes/schedule-b2.jsonl")).unwrap().trim()).unwrap();
        assert_eq!(every["schedule"], json!({ "kind": "every", "intervalMs": 1_800_000 }));
    }

    #[test]
    fn openclaw_cron_jobs_from_sqlite_and_heartbeat_stays() {
        let src = tempdir().unwrap();
        fs::create_dir_all(src.path().join("state")).unwrap();
        let conn = rusqlite::Connection::open(src.path().join("state/openclaw.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE cron_jobs (job_id TEXT, name TEXT, schedule_kind TEXT, schedule_expr TEXT, schedule_tz TEXT, every_ms INTEGER,
               at TEXT, payload_kind TEXT, payload_message TEXT, sort_order INTEGER, created_at_ms INTEGER);
             INSERT INTO cron_jobs VALUES ('j1', 'Weekly review', 'cron', '0 9 * * 1', 'Europe/Bucharest', NULL, NULL, 'agentTurn', 'Review my week', 0, 0);
             INSERT INTO cron_jobs VALUES ('hb', NULL, 'every', NULL, NULL, 1800000, NULL, 'heartbeat', NULL, 1, 0);",
        )
        .unwrap();
        drop(conn);
        let found = Found { source: Source::OpenClaw, root: src.path().to_path_buf(), config: src.path().join("openclaw.json"), version: None };
        let home = tempdir().unwrap();
        let mut plan = empty_plan();
        plan_schedules_into(&found, home.path(), false, &mut plan);
        assert_eq!(plan.will_import.len(), 1);
        assert_eq!(plan.will_import[0].what, "schedule: Weekly review");
        assert!(plan.will_import[0].note.as_deref().unwrap().contains("Europe/Bucharest"));
        assert!(plan.not_imported[0].contains("check-in"));
    }
}
