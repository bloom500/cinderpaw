//! A skill from a link the person pasted in chat.
//!
//! The agent hands over the URL and nothing else. The host works out where
//! SKILL.md is (a github.com page, a folder, a repo, or a raw file), fetches
//! it, scans it, and HOLDS those exact bytes under a token. The person is
//! shown the source, the scan and the text; their yes sends the token back and
//! the held bytes are installed. Nothing is fetched twice, so what is installed
//! is what they read.
//!
//! Every refusal is a sentence for the person, because the agent passes it on
//! as it is: "this repo has 3 skills", not "404".

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};
use url::Url;

use super::{SkillMeta, SourceProvider, TrustLabel};

/// A SKILL.md is instructions, not a program; 256 KiB is far past any real one.
const MAX_SKILL_BYTES: usize = 256 * 1024;
/// How long a preview waits for the person's answer.
const HOLD: Duration = Duration::from_secs(15 * 60);
/// Files listed by name in the question; the rest are counted.
const LEFT_OUT_NAMED: usize = 12;

struct Held {
    meta: SkillMeta,
    content: String,
    dangerous: bool,
    at: Instant,
}

fn held() -> &'static Mutex<HashMap<String, Held>> {
    static H: OnceLock<Mutex<HashMap<String, Held>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where a link's SKILL.md is, and what sits beside it.
#[derive(Debug, PartialEq)]
struct Found {
    /// raw.githubusercontent.com / gist address of SKILL.md.
    raw: String,
    /// The folder the skill lives in, which names it (None: a repo-root SKILL.md).
    folder: Option<String>,
    /// Other files in that folder, relative to it.
    left_out: Vec<String>,
}

/// What a github.com link points at.
#[derive(Debug, PartialEq)]
enum GitHub {
    /// `/owner/repo/blob/<ref>/<path>`: one file.
    File { owner: String, repo: String, rf: String, path: String },
    /// `/owner/repo/tree/<ref>/<dir>` or `/owner/repo`: look inside.
    Dir { owner: String, repo: String, rf: String, dir: String },
}

const ONLY_GITHUB: &str =
    "For now Cinderpaw installs skills from GitHub links only. Send a github.com link to the skill or its folder.";

fn parse_github(url: &Url) -> Result<GitHub, String> {
    let segs: Vec<&str> = url.path_segments().map(|s| s.filter(|p| !p.is_empty()).collect()).unwrap_or_default();
    let (owner, repo) = match segs.as_slice() {
        [o, r, ..] => (o.to_string(), r.trim_end_matches(".git").to_string()),
        _ => return Err("That GitHub link does not point at a repository. Send the link to the skill's folder.".into()),
    };
    match segs.get(2).copied() {
        None => Ok(GitHub::Dir { owner, repo, rf: "HEAD".into(), dir: String::new() }),
        Some("blob") if segs.len() >= 5 => {
            Ok(GitHub::File { owner, repo, rf: segs[3].to_string(), path: segs[4..].join("/") })
        }
        Some("tree") if segs.len() >= 4 => {
            Ok(GitHub::Dir { owner, repo, rf: segs[3].to_string(), dir: segs[4..].join("/") })
        }
        _ => Err("That GitHub page is not a skill. Send the link to the skill's folder or its SKILL.md.".into()),
    }
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn is_skill_md(path: &str) -> bool {
    path.rsplit('/').next().is_some_and(|f| f.eq_ignore_ascii_case("SKILL.md"))
}

/// Pick the SKILL.md for a link from the repo's file list (`blobs`, paths from
/// the repo root). Pure, so the link rules are tested without the network.
fn choose(owner: &str, repo: &str, rf: &str, want: &GitHub, blobs: &[String]) -> Result<Found, String> {
    let path = match want {
        GitHub::File { path, .. } => {
            if !is_skill_md(path) {
                return Err("That link is to a file that is not a SKILL.md. Send the link to the skill's folder.".into());
            }
            path.clone()
        }
        GitHub::Dir { dir, .. } => {
            let inside = |p: &&String| dir.is_empty() || p.starts_with(&format!("{dir}/"));
            let skills: Vec<&String> = blobs.iter().filter(inside).filter(|p| is_skill_md(p)).collect();
            // The folder's own SKILL.md wins over skills nested below it.
            let own = if dir.is_empty() { "SKILL.md".to_string() } else { format!("{dir}/SKILL.md") };
            if let Some(p) = skills.iter().find(|p| p.eq_ignore_ascii_case(&own)) {
                (*p).clone()
            } else {
                match skills.as_slice() {
                    [] => {
                        return Err("There is no SKILL.md at that link. It may be a plugin or a tool server, \
                                    which Cinderpaw cannot install from a link yet."
                            .into())
                    }
                    [one] => (*one).clone(),
                    many => {
                        // Each skill's own link, so the agent can ask "which one?" and
                        // try again itself: "send the folder link" is a step a person
                        // who pasted a repo link does not know how to take.
                        let lines: Vec<String> = many
                            .iter()
                            .take(30)
                            .map(|p| {
                                let d = parent(p);
                                format!("- {}: https://github.com/{owner}/{repo}/tree/{rf}/{d}", d.rsplit('/').next().unwrap_or(d))
                            })
                            .collect();
                        return Err(format!(
                            "That link has {} skills. Ask the person which one they want, then install it from its own link:\n{}{}",
                            many.len(),
                            lines.join("\n"),
                            if many.len() > 30 { format!("\n- and {} more", many.len() - 30) } else { String::new() }
                        ));
                    }
                }
            }
        }
    };
    let folder = parent(&path).to_string();
    let prefix = if folder.is_empty() { String::new() } else { format!("{folder}/") };
    let left_out = if folder.is_empty() {
        // A repo-root skill: the whole repo sits beside it, which says nothing
        // about what the skill needs. Name nothing rather than the repo.
        Vec::new()
    } else {
        blobs.iter().filter(|p| p.starts_with(&prefix) && **p != path).map(|p| p[prefix.len()..].to_string()).collect()
    };
    Ok(Found {
        raw: format!("https://raw.githubusercontent.com/{owner}/{repo}/{rf}/{path}"),
        folder: (!folder.is_empty()).then(|| folder.rsplit('/').next().unwrap_or(&folder).to_string()).or(Some(repo.to_string())),
        left_out,
    })
}

/// The repo's file list, from GitHub's tree API (one request, no key: 60 an hour).
async fn repo_files(owner: &str, repo: &str, rf: &str) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .user_agent("cinderpaw")
        .timeout(Duration::from_secs(15))
        // api.github.com answers itself; a redirect anywhere else is not followed.
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.url().host_str() == Some("api.github.com") && a.previous().len() < 3 { a.follow() } else { a.stop() }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://api.github.com/repos/{owner}/{repo}/git/trees/{rf}?recursive=1");
    let res = client.get(&url).header("Accept", "application/vnd.github+json").send().await.map_err(|e| {
        format!("Could not reach GitHub ({e}). Check the internet connection and try again.")
    })?;
    match res.status().as_u16() {
        200 => {}
        404 => return Err("GitHub says that repository does not exist or is private.".into()),
        403 | 429 => return Err("GitHub is limiting requests right now. Try again in an hour.".into()),
        s => return Err(format!("GitHub answered {s}. Try again in a minute.")),
    }
    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(body["tree"]
        .as_array()
        .map(|t| {
            t.iter()
                .filter(|e| e["type"] == "blob")
                .filter_map(|e| e["path"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

fn slug(s: &str) -> String {
    let s: String = s.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '-' }).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "skill".into() } else { s }
}

/// Resolve, fetch, scan and hold. The JSON is what `install_skill_from_link` reads.
pub async fn preview(link: &str) -> Result<Value, String> {
    let url = Url::parse(link.trim()).map_err(|_| "That is not a link. Send the full address, starting with https://.".to_string())?;
    if url.scheme() != "https" {
        return Err("Only https:// links can be installed.".into());
    }
    let found = match url.host_str() {
        Some("raw.githubusercontent.com") | Some("gist.githubusercontent.com") => {
            let path = url.path().to_string();
            Found {
                raw: url.to_string(),
                folder: parent(&path).rsplit('/').next().filter(|f| !f.is_empty()).map(str::to_string),
                left_out: Vec::new(),
            }
        }
        Some("github.com") | Some("www.github.com") => {
            let want = parse_github(&url)?;
            let (owner, repo, rf) = match &want {
                GitHub::File { owner, repo, rf, .. } | GitHub::Dir { owner, repo, rf, .. } => (owner.clone(), repo.clone(), rf.clone()),
            };
            let files = repo_files(&owner, &repo, &rf).await?;
            choose(&owner, &repo, &rf, &want, &files)?
        }
        Some("gist.github.com") => return Err("For a gist, send its Raw link.".into()),
        _ => return Err(ONLY_GITHUB.into()),
    };

    let res = super::content_client()
        .map_err(|e| e.to_string())?
        .get(&found.raw)
        .send()
        .await
        .map_err(|e| format!("Could not download the skill ({e})."))?;
    if !res.status().is_success() {
        return Err(format!("The skill could not be downloaded (GitHub answered {}).", res.status().as_u16()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SKILL_BYTES {
        return Err("That SKILL.md is too big to be a skill (over 256 KB).".into());
    }
    let content = String::from_utf8(bytes.to_vec()).map_err(|_| "That SKILL.md is not text.".to_string())?;
    super::validate_skill_body(&content)
        .map_err(|_| "That file is not a skill: a SKILL.md starts with a name and a description between --- lines.".to_string())?;

    let mut meta = super::parse_frontmatter(&slug(found.folder.as_deref().unwrap_or("skill")), &content);
    meta.source_provider = SourceProvider::GitHub;
    meta.trust_label = TrustLabel::Community;
    meta.source_url = Some(link.trim().to_string());
    meta.content_url = Some(found.raw.clone());
    let replaces = super::skill_exists(&meta.id).unwrap_or(false);

    let (verdict, findings) = super::scan::scan(&content);
    let mut left_out = found.left_out;
    let more = left_out.len().saturating_sub(LEFT_OUT_NAMED);
    left_out.truncate(LEFT_OUT_NAMED);
    if more > 0 {
        left_out.push(format!("and {more} more"));
    }
    let source = found.raw.trim_start_matches("https://").to_string();

    let token = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut h = held().lock();
        h.retain(|_, v| v.at.elapsed() < HOLD);
        h.insert(token.clone(), Held { meta: meta.clone(), content: content.clone(), dangerous: verdict == "dangerous", at: Instant::now() });
    }
    Ok(json!({
        "token": token, "meta": meta, "source": source, "content": content,
        "verdict": verdict, "findings": findings, "left_out": left_out, "replaces": replaces,
    }))
}

/// Install the bytes a preview held. The token is single-use.
pub fn install(token: &str) -> Result<SkillMeta, String> {
    let Held { meta, content, dangerous, at } =
        held().lock().remove(token).ok_or("That preview is gone. Ask for the link to be checked again.")?;
    if at.elapsed() >= HOLD {
        return Err("That preview waited too long. Ask for the link to be checked again.".into());
    }
    if dangerous {
        return Err("The safety check refused this skill, so it cannot be installed.".into());
    }
    // The bytes this host fetched and scanned itself; do_install stays private
    // to the skills module, and this is its child.
    super::validate_skill_body(&content).map_err(|e| e.to_string())?;
    super::do_install(&meta, &content, true).map_err(|e| e.to_string())?;
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn gh(link: &str) -> GitHub {
        parse_github(&Url::parse(link).unwrap()).unwrap()
    }

    #[test]
    fn github_links_name_a_file_or_a_folder() {
        assert_eq!(
            gh("https://github.com/acme/skills/blob/main/pdf/SKILL.md"),
            GitHub::File { owner: "acme".into(), repo: "skills".into(), rf: "main".into(), path: "pdf/SKILL.md".into() }
        );
        assert_eq!(
            gh("https://github.com/acme/skills/tree/main/pdf"),
            GitHub::Dir { owner: "acme".into(), repo: "skills".into(), rf: "main".into(), dir: "pdf".into() }
        );
        assert_eq!(
            gh("https://github.com/acme/skills"),
            GitHub::Dir { owner: "acme".into(), repo: "skills".into(), rf: "HEAD".into(), dir: String::new() }
        );
        assert!(parse_github(&Url::parse("https://github.com/acme/skills/issues/3").unwrap()).is_err());
    }

    #[test]
    fn a_folder_link_finds_its_skill_and_lists_what_is_left_out() {
        let repo = files(&["README.md", "pdf/SKILL.md", "pdf/scripts/split.sh", "xls/SKILL.md"]);
        let f = choose("acme", "skills", "main", &gh("https://github.com/acme/skills/tree/main/pdf"), &repo).unwrap();
        assert_eq!(f.raw, "https://raw.githubusercontent.com/acme/skills/main/pdf/SKILL.md");
        assert_eq!(f.folder.as_deref(), Some("pdf"));
        assert_eq!(f.left_out, vec!["scripts/split.sh".to_string()]);
    }

    #[test]
    fn a_repo_with_several_skills_asks_for_one_by_name() {
        let repo = files(&["pdf/SKILL.md", "xls/SKILL.md", "docs/x.md"]);
        let err = choose("acme", "skills", "HEAD", &gh("https://github.com/acme/skills"), &repo).unwrap_err();
        assert!(err.contains("2 skills"), "{err}");
        assert!(err.contains("- pdf: https://github.com/acme/skills/tree/HEAD/pdf"), "{err}");
        assert!(err.contains("- xls: https://github.com/acme/skills/tree/HEAD/xls"), "{err}");
    }

    #[test]
    fn a_repo_with_one_skill_installs_it_and_a_repo_with_none_says_why() {
        let one = files(&["skills/reverse-engineer/SKILL.md", "src/index.ts"]);
        let f = choose("m", "rea", "HEAD", &gh("https://github.com/m/rea"), &one).unwrap();
        assert_eq!(f.raw, "https://raw.githubusercontent.com/m/rea/HEAD/skills/reverse-engineer/SKILL.md");
        let err = choose("m", "tool", "HEAD", &gh("https://github.com/m/tool"), &files(&["src/main.ts"])).unwrap_err();
        assert!(err.contains("no SKILL.md"), "{err}");
    }

    #[test]
    fn a_file_link_that_is_not_skill_md_is_refused() {
        let err = choose("a", "b", "main", &gh("https://github.com/a/b/blob/main/README.md"), &[]).unwrap_err();
        assert!(err.contains("not a SKILL.md"), "{err}");
    }

    #[test]
    fn a_token_installs_once_and_a_dangerous_one_never() {
        let meta = super::super::parse_frontmatter("x", "---\nname: X\ndescription: d\n---\n");
        held().lock().insert("bad".into(), Held { meta, content: String::new(), dangerous: true, at: Instant::now() });
        assert!(install("bad").unwrap_err().contains("refused"));
        // Single use: the refused token is gone too.
        assert!(install("bad").unwrap_err().contains("gone"));
    }
    /// Live, by hand: `cargo test -p cinderpaw --lib live_links -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "network"]
    async fn live_links() {
        for link in ["https://github.com/morluto/rea", "https://github.com/morluto/rea/tree/HEAD/skills/reverse-engineer-anything", "https://github.com/anthropics/skills/tree/main/skills/pdf", "https://example.com/x"] {
            match preview(link).await {
                Ok(v) => println!("{link} -> {} | {} | {} | left out {}", v["source"], v["verdict"], v["findings"], v["left_out"]),
                Err(e) => println!("{link} -> refused: {e}"),
            }
        }
    }
}
