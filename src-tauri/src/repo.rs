use anyhow::{anyhow, Context, Result};
use git2::{DiffOptions, Repository};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use url::Url;

pub fn repos_dir() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| anyhow!("could not resolve user data dir"))?
        .join("co.garden.guided-review")
        .join("repos");
    std::fs::create_dir_all(&base).with_context(|| format!("creating {}", base.display()))?;
    Ok(base)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClonedRepo {
    pub path: PathBuf,
    pub head_ref: String,
    pub head_sha: String,
    pub base_ref: String,
    pub display_slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GithubRepoInfo {
    pub repo_url: String,
    pub owner: String,
    pub repo: String,
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PullRequestMetadata {
    pub title: String,
    pub body: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct GhPullRequestMetadata {
    title: String,
    body: Option<String>,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionSource {
    Pr {
        repo_url: String,
        number: u64,
    },
    Branch {
        repo_url: String,
        branch: String,
    },
    Sha {
        repo_url: String,
        sha: String,
    },
    Local {
        path: PathBuf,
    },
    LocalPr {
        path: PathBuf,
        repo_url: String,
        number: u64,
    },
    LocalBranch {
        path: PathBuf,
        branch: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RefSpec {
    Branch(String),
    PullRequest(u64),
    Sha(String),
}

fn slug_from_url(url: &str) -> Result<String> {
    let parsed = Url::parse(url).or_else(|_| {
        if let Some(rest) = url.strip_prefix("git@github.com:") {
            Url::parse(&format!("ssh://git@github.com/{}", rest))
        } else {
            Err(url::ParseError::RelativeUrlWithoutBase)
        }
    })?;
    let segments: Vec<_> = parsed
        .path_segments()
        .ok_or_else(|| anyhow!("url has no path segments"))?
        .filter(|s| !s.is_empty())
        .collect();
    if segments.len() < 2 {
        return Err(anyhow!("expected /<owner>/<repo> in {url}"));
    }
    let owner = segments[0];
    let repo = segments[1].trim_end_matches(".git");
    Ok(format!("{owner}-{repo}"))
}

pub async fn resolve_source(source: &SessionSource) -> Result<ClonedRepo> {
    match source {
        SessionSource::Pr { repo_url, number } => {
            clone_or_fetch(repo_url, &RefSpec::PullRequest(*number)).await
        }
        SessionSource::Branch { repo_url, branch } => {
            clone_or_fetch(repo_url, &RefSpec::Branch(branch.clone())).await
        }
        SessionSource::Sha { repo_url, sha } => {
            clone_or_fetch(repo_url, &RefSpec::Sha(sha.clone())).await
        }
        SessionSource::Local { path } => prepare_local(path).await,
        SessionSource::LocalPr {
            path,
            repo_url,
            number,
        } => prepare_local_pr(path, repo_url, *number).await,
        SessionSource::LocalBranch { path, branch } => prepare_local_branch(path, branch).await,
    }
}

fn local_display_slug(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

async fn prepare_local(path: &Path) -> Result<ClonedRepo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }
    let display_slug = local_display_slug(path);

    let head_ref = run_git_output(Some(path), &["rev-parse", "HEAD"])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let head_sha = resolve_commit_sha(path, &head_ref).await?;

    let upstream = run_git_output(
        Some(path),
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    )
    .await
    .map(|s| s.trim().to_string());
    let base_ref = match upstream {
        Ok(up) => run_git_output(Some(path), &["merge-base", "HEAD", &up])
            .await
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| up),
        Err(_) => "HEAD~1".to_string(),
    };

    Ok(ClonedRepo {
        path: path.to_path_buf(),
        head_ref,
        head_sha,
        base_ref,
        display_slug,
    })
}

async fn prepare_local_pr(path: &Path, repo_url: &str, number: u64) -> Result<ClonedRepo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }

    let _ = run_git(Some(path), &["fetch", "--all", "--prune"]).await;
    let head_ref = format!("guided-review-pr-{number}");
    let pr_refspec = format!("+refs/pull/{number}/head:{head_ref}");
    run_git(Some(path), &["fetch", repo_url, &pr_refspec]).await?;
    let head_sha = resolve_commit_sha(path, &head_ref).await?;
    let base_ref = resolve_local_base_ref(path, &head_ref).await?;

    Ok(ClonedRepo {
        path: path.to_path_buf(),
        head_ref,
        head_sha,
        base_ref,
        display_slug: local_display_slug(path),
    })
}

async fn prepare_local_branch(path: &Path, branch: &str) -> Result<ClonedRepo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }

    let _ = run_git(Some(path), &["fetch", "--all", "--prune"]).await;
    let head_ref = resolve_local_branch_ref(path, branch).await?;
    let head_sha = resolve_commit_sha(path, &head_ref).await?;
    let base_ref = resolve_local_base_ref(path, &head_ref).await?;

    Ok(ClonedRepo {
        path: path.to_path_buf(),
        head_ref,
        head_sha,
        base_ref,
        display_slug: local_display_slug(path),
    })
}

async fn resolve_local_branch_ref(path: &Path, branch: &str) -> Result<String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("branch name is required"));
    }

    if git_commit_exists(path, trimmed).await {
        return Ok(trimmed.to_string());
    }

    if !trimmed.contains('/') {
        let remote_ref = format!("origin/{trimmed}");
        if git_commit_exists(path, &remote_ref).await {
            return Ok(remote_ref);
        }
    }

    Err(anyhow!("branch not found: {trimmed}"))
}

async fn git_commit_exists(path: &Path, refspec: &str) -> bool {
    let commit_ref = format!("{refspec}^{{commit}}");
    run_git_output(Some(path), &["rev-parse", "--verify", &commit_ref])
        .await
        .is_ok()
}

async fn resolve_commit_sha(path: &Path, refspec: &str) -> Result<String> {
    let commit_ref = format!("{refspec}^{{commit}}");
    run_git_output(Some(path), &["rev-parse", "--verify", &commit_ref])
        .await
        .map(|s| s.trim().to_string())
        .with_context(|| format!("resolving commit SHA for {refspec}"))
}

async fn resolve_local_base_ref(path: &Path, head_ref: &str) -> Result<String> {
    let default_branch = resolve_default_branch(path)
        .await
        .unwrap_or_else(|_| "origin/main".to_string());
    let merge_base = run_git_output(Some(path), &["merge-base", head_ref, &default_branch])
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| default_branch.clone());
    Ok(merge_base)
}

pub async fn clone_or_fetch(url: &str, refspec: &RefSpec) -> Result<ClonedRepo> {
    let slug = slug_from_url(url)?;
    let path = repos_dir()?.join(&slug);

    if !path.join(".git").exists() {
        run_git(None, &["clone", url, &path.to_string_lossy()]).await?;
    } else {
        run_git(Some(&path), &["fetch", "--all", "--prune"]).await?;
    }

    let (base_ref, head_ref) = match refspec {
        RefSpec::Branch(name) => {
            run_git(Some(&path), &["fetch", "origin", name]).await?;
            let base = resolve_default_branch(&path).await?;
            (base, format!("origin/{name}"))
        }
        RefSpec::PullRequest(n) => {
            let head_local = format!("pr-{n}");
            run_git(
                Some(&path),
                &[
                    "fetch",
                    "origin",
                    &format!("+refs/pull/{n}/head:{head_local}"),
                ],
            )
            .await?;
            let base = resolve_default_branch(&path).await?;
            (base, head_local)
        }
        RefSpec::Sha(sha) => {
            run_git(Some(&path), &["fetch", "origin", sha]).await?;
            (format!("{sha}^"), sha.clone())
        }
    };
    let head_sha = resolve_commit_sha(&path, &head_ref).await?;

    Ok(ClonedRepo {
        path,
        head_ref,
        head_sha,
        base_ref,
        display_slug: slug,
    })
}

async fn resolve_default_branch(path: &Path) -> Result<String> {
    let out = run_git_output(
        Some(path),
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    )
    .await
    .or_else(|_| Ok::<String, anyhow::Error>("origin/main".into()))?;
    Ok(out.trim().to_string())
}

pub fn parse_pr_url(url: &str) -> Option<(String, String, u64)> {
    let parsed = Url::parse(url).ok()?;
    if !matches!(
        parsed.host_str(),
        Some("github.com") | Some("www.github.com")
    ) {
        return None;
    }
    let segs: Vec<&str> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
    if segs.len() >= 4 && segs[2] == "pull" {
        let number: u64 = segs[3].parse().ok()?;
        return Some((segs[0].to_string(), segs[1].to_string(), number));
    }
    None
}

pub async fn inspect_origin(path: &Path) -> Result<GithubRepoInfo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }
    if !path.join(".git").exists() {
        return Err(anyhow!("selected folder is not a Git repository"));
    }

    let remote = run_git_output(Some(path), &["config", "--get", "remote.origin.url"])
        .await
        .context("selected repository has no origin remote")?;

    parse_github_repo_url(remote.trim())
        .ok_or_else(|| anyhow!("selected repository origin is not a GitHub repository"))
}

pub fn parse_github_repo_url(remote: &str) -> Option<GithubRepoInfo> {
    let trimmed = remote.trim();
    let path = if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        rest.to_string()
    } else {
        let parsed = Url::parse(trimmed).ok()?;
        if !matches!(
            parsed.host_str(),
            Some("github.com") | Some("www.github.com")
        ) {
            return None;
        }
        parsed.path().trim_start_matches('/').to_string()
    };

    let mut segments = path.split('/').filter(|s| !s.is_empty());
    let owner = segments.next()?.to_string();
    let repo = segments.next()?.trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    let slug = format!("{owner}/{repo}").to_lowercase();
    Some(GithubRepoInfo {
        repo_url: format!("https://github.com/{owner}/{repo}"),
        owner,
        repo,
        slug,
    })
}

pub fn gh_pr_view_args(owner: &str, repo: &str, number: u64) -> Vec<String> {
    vec![
        "pr".to_string(),
        "view".to_string(),
        number.to_string(),
        "--repo".to_string(),
        format!("{owner}/{repo}"),
        "--json".to_string(),
        "title,body,url".to_string(),
    ]
}

pub fn parse_pull_request_metadata_json(raw: &str) -> Result<PullRequestMetadata> {
    let gh: GhPullRequestMetadata = serde_json::from_str(raw)?;
    Ok(PullRequestMetadata {
        title: gh.title,
        body: gh.body.unwrap_or_default(),
        url: gh.url,
    })
}

pub async fn fetch_pull_request_metadata(
    repo_url: &str,
    number: u64,
) -> Result<PullRequestMetadata> {
    let repo = parse_github_repo_url(repo_url)
        .ok_or_else(|| anyhow!("PR metadata requires a GitHub repository URL"))?;
    let args = gh_pr_view_args(&repo.owner, &repo.repo, number);
    let out = Command::new("gh")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .with_context(|| format!("running gh {args:?}"))?;
    if !out.status.success() {
        return Err(anyhow!(
            "gh pr view failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_pull_request_metadata_json(&String::from_utf8_lossy(&out.stdout))
}

async fn run_git(cwd: Option<&Path>, args: &[&str]) -> Result<()> {
    let mut cmd = Command::new("git");
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.args(args).stdin(Stdio::null());
    let status = cmd
        .status()
        .await
        .with_context(|| format!("running git {args:?}"))?;
    if !status.success() {
        return Err(anyhow!("git {args:?} failed: {status}"));
    }
    Ok(())
}

async fn run_git_output(cwd: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new("git");
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd.output().await?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn get_file_at_ref(repo_path: &Path, file_path: &str, refspec: &str) -> Result<Option<String>> {
    let repo = Repository::open(repo_path)?;
    let object = repo.revparse_single(refspec)?;
    let commit = object.peel_to_commit()?;
    let tree = commit.tree()?;
    match tree.get_path(Path::new(file_path)) {
        Ok(entry) => {
            let blob = entry.to_object(&repo)?.peel_to_blob()?;
            Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
        }
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffPatch {
    pub file_path: String,
    pub patch: String,
}

pub fn get_diff(
    repo_path: &Path,
    base_ref: &str,
    head_ref: &str,
    file_path: Option<&str>,
) -> Result<Vec<DiffPatch>> {
    let repo = Repository::open(repo_path)?;
    let base_tree = repo.revparse_single(base_ref)?.peel_to_commit()?.tree()?;
    let head_tree = repo.revparse_single(head_ref)?.peel_to_commit()?.tree()?;

    let mut opts = DiffOptions::new();
    if let Some(p) = file_path {
        opts.pathspec(p);
    }
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;

    use std::cell::RefCell;
    let out: RefCell<Vec<DiffPatch>> = RefCell::new(Vec::new());
    diff.foreach(
        &mut |delta, _| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.borrow_mut().push(DiffPatch {
                file_path: path,
                patch: String::new(),
            });
            true
        },
        None,
        None,
        Some(&mut |_, _, line| {
            let mut patches = out.borrow_mut();
            if let Some(last) = patches.last_mut() {
                let origin = line.origin();
                if matches!(origin, ' ' | '+' | '-') {
                    last.patch.push(origin);
                }
                last.patch
                    .push_str(&String::from_utf8_lossy(line.content()));
            }
            true
        }),
    )?;

    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as StdCommand;
    use uuid::Uuid;

    fn temp_repo_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("guided-review-app-{name}-{}", Uuid::new_v4()))
    }

    fn run_git_sync(path: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("running git {args:?}: {e}"));
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output_sync(path: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .current_dir(path)
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("running git {args:?}: {e}"));
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn write_and_commit(path: &Path, file_name: &str, body: &str, message: &str) {
        fs::write(path.join(file_name), body).unwrap();
        run_git_sync(path, &["add", file_name]);
        run_git_sync(path, &["commit", "-m", message]);
    }

    #[test]
    fn parse_github_repo_url_accepts_common_github_formats() {
        let cases = [
            "https://github.com/openai/codex",
            "https://github.com/openai/codex.git",
            "git@github.com:openai/codex.git",
            "ssh://git@github.com/openai/codex.git",
        ];

        for remote in cases {
            let info = parse_github_repo_url(remote).expect(remote);
            assert_eq!(info.repo_url, "https://github.com/openai/codex");
            assert_eq!(info.owner, "openai");
            assert_eq!(info.repo, "codex");
            assert_eq!(info.slug, "openai/codex");
        }
    }

    #[test]
    fn parse_github_repo_url_rejects_non_github_remotes() {
        assert!(parse_github_repo_url("https://gitlab.com/openai/codex").is_none());
        assert!(parse_github_repo_url("not-a-url").is_none());
    }

    #[test]
    fn parse_pull_request_metadata_json_reads_gh_pr_view_output() {
        let metadata = parse_pull_request_metadata_json(
            r###"{
                "title": "Improve guided review",
                "body": "## Summary\nMake review easier.",
                "url": "https://github.com/openai/codex/pull/123"
            }"###,
        )
        .unwrap();

        assert_eq!(metadata.title, "Improve guided review");
        assert_eq!(metadata.body, "## Summary\nMake review easier.");
        assert_eq!(metadata.url, "https://github.com/openai/codex/pull/123");
    }

    #[test]
    fn gh_pr_view_args_target_the_expected_repo_and_fields() {
        assert_eq!(
            gh_pr_view_args("openai", "codex", 123),
            vec![
                "pr",
                "view",
                "123",
                "--repo",
                "openai/codex",
                "--json",
                "title,body,url",
            ]
        );
    }

    #[tokio::test]
    async fn prepare_local_branch_serializes_resolved_head_sha() {
        let repo_path = temp_repo_path("head-sha");
        fs::create_dir_all(&repo_path).unwrap();
        run_git_sync(&repo_path, &["init", "-b", "main"]);
        run_git_sync(&repo_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &repo_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );

        write_and_commit(&repo_path, "README.md", "base\n", "base");
        run_git_sync(&repo_path, &["branch", "feature"]);
        run_git_sync(&repo_path, &["checkout", "feature"]);
        write_and_commit(&repo_path, "README.md", "feature\n", "feature");
        let feature_sha = git_output_sync(&repo_path, &["rev-parse", "feature"]);

        let prepared = prepare_local_branch(&repo_path, "feature").await.unwrap();
        let json = serde_json::to_value(prepared).unwrap();

        assert_eq!(json["head_sha"], feature_sha);

        fs::remove_dir_all(repo_path).unwrap();
    }
}
