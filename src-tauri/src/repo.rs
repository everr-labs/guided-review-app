use crate::gh::{self, GhApiJsonRequest};
use anyhow::{anyhow, Context, Result};
use git2::{DiffOptions, Repository};
use serde::de::DeserializeOwned;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublishedPrComment {
    pub id: u64,
    pub author_login: String,
    pub body: String,
    pub html_url: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_side: Option<String>,
    #[serde(default)]
    pub is_outdated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingReview {
    pub review_id: u64,
    pub node_id: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub html_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingReviewComment {
    pub comment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhPullRequestMetadata {
    title: String,
    body: Option<String>,
    url: String,
}

#[derive(Debug, Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GhPullRequestReviewComment {
    id: u64,
    user: Option<GhUser>,
    body: String,
    html_url: String,
    created_at: String,
    path: Option<String>,
    line: Option<u32>,
    side: Option<String>,
    original_line: Option<u32>,
    original_side: Option<String>,
    #[serde(default)]
    outdated: bool,
}

#[derive(Debug, Deserialize)]
struct GhPullRequestReviewSummary {
    id: u64,
    user: Option<GhUser>,
    body: Option<String>,
    html_url: String,
    submitted_at: Option<String>,
    state: String,
}

#[derive(Debug, Deserialize)]
struct GhPendingReview {
    id: u64,
    node_id: String,
    body: Option<String>,
    html_url: Option<String>,
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
        SessionSource::LocalPr { path, number, .. } => prepare_local_pr(path, *number).await,
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

async fn prepare_local_pr(path: &Path, number: u64) -> Result<ClonedRepo> {
    if !path.is_dir() {
        return Err(anyhow!("not a directory: {}", path.display()));
    }

    let _ = run_git(Some(path), &["fetch", "--all", "--prune"]).await;
    let head_ref = format!("guided-review-pr-{number}");
    let pr_refspec = format!("+refs/pull/{number}/head:{head_ref}");
    run_git(Some(path), &["fetch", "origin", &pr_refspec]).await?;
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

pub fn gh_review_comments_args(owner: &str, repo: &str, number: u64) -> Vec<String> {
    vec![
        "api".to_string(),
        "--paginate".to_string(),
        "--slurp".to_string(),
        format!("/repos/{owner}/{repo}/pulls/{number}/comments?per_page=100"),
    ]
}

pub fn gh_review_summaries_args(owner: &str, repo: &str, number: u64) -> Vec<String> {
    vec![
        "api".to_string(),
        "--paginate".to_string(),
        "--slurp".to_string(),
        format!("/repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100"),
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

fn parse_paginated_gh_array<T: DeserializeOwned>(raw: &str) -> Result<Vec<T>> {
    let value: serde_json::Value = serde_json::from_str(raw)?;
    match value.as_array() {
        Some(pages) if pages.first().is_some_and(|page| page.is_array()) => {
            let mut items = Vec::new();
            for page in pages {
                items.extend(serde_json::from_value::<Vec<T>>(page.clone())?);
            }
            Ok(items)
        }
        _ => serde_json::from_value(value).map_err(Into::into),
    }
}

pub fn parse_pull_request_review_comments_json(raw: &str) -> Result<Vec<PublishedPrComment>> {
    let gh: Vec<GhPullRequestReviewComment> = parse_paginated_gh_array(raw)?;
    Ok(gh
        .into_iter()
        .map(|comment| PublishedPrComment {
            id: comment.id,
            author_login: comment.user.map(|user| user.login).unwrap_or_default(),
            body: comment.body,
            html_url: comment.html_url,
            created_at: comment.created_at,
            file_path: comment.path,
            line: comment.line,
            side: comment.side,
            original_line: comment.original_line,
            original_side: comment.original_side,
            is_outdated: comment.outdated,
        })
        .collect())
}

pub fn parse_pull_request_review_summaries_json(raw: &str) -> Result<Vec<PublishedPrComment>> {
    let gh: Vec<GhPullRequestReviewSummary> = parse_paginated_gh_array(raw)?;
    Ok(gh
        .into_iter()
        .filter(|review| !review.state.eq_ignore_ascii_case("PENDING"))
        .filter_map(|review| {
            let body = review.body.unwrap_or_default().trim().to_string();
            if body.is_empty() {
                return None;
            }
            Some(PublishedPrComment {
                id: review.id,
                author_login: review.user.map(|user| user.login).unwrap_or_default(),
                body,
                html_url: review.html_url,
                created_at: review.submitted_at.unwrap_or_default(),
                file_path: None,
                line: None,
                side: None,
                original_line: None,
                original_side: None,
                is_outdated: false,
            })
        })
        .collect())
}

pub async fn fetch_pull_request_metadata(
    repo_url: &str,
    number: u64,
) -> Result<PullRequestMetadata> {
    let repo = parse_github_repo_url(repo_url)
        .ok_or_else(|| anyhow!("PR metadata requires a GitHub repository URL"))?;
    let args = gh_pr_view_args(&repo.owner, &repo.repo, number);
    let raw = gh::output(&args).await?;
    parse_pull_request_metadata_json(&raw)
}

pub async fn fetch_pull_request_review_comments(
    repo_url: &str,
    number: u64,
) -> Result<Vec<PublishedPrComment>> {
    let repo = parse_github_repo_url(repo_url)
        .ok_or_else(|| anyhow!("PR comments require a GitHub repository URL"))?;
    let comment_args = gh_review_comments_args(&repo.owner, &repo.repo, number);
    let comments_raw = gh::output(&comment_args).await?;
    let mut comments = parse_pull_request_review_comments_json(&comments_raw)?;

    let review_args = gh_review_summaries_args(&repo.owner, &repo.repo, number);
    let summaries_raw = gh::output(&review_args).await?;
    comments.extend(parse_pull_request_review_summaries_json(&summaries_raw)?);
    Ok(comments)
}

pub fn create_pending_review_request(
    owner: &str,
    repo: &str,
    number: u64,
    head_sha: &str,
    body: &str,
) -> GhApiJsonRequest {
    GhApiJsonRequest {
        method: "POST".to_string(),
        path: format!("/repos/{owner}/{repo}/pulls/{number}/reviews"),
        body: serde_json::json!({
            "commit_id": head_sha,
            "body": body,
        }),
    }
}

pub fn update_pending_review_body_request(
    owner: &str,
    repo: &str,
    number: u64,
    review_id: u64,
    body: &str,
) -> GhApiJsonRequest {
    GhApiJsonRequest {
        method: "PATCH".to_string(),
        path: format!("/repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}"),
        body: serde_json::json!({ "body": body }),
    }
}

pub fn submit_pending_review_request(
    owner: &str,
    repo: &str,
    number: u64,
    review_id: u64,
    body: &str,
) -> GhApiJsonRequest {
    GhApiJsonRequest {
        method: "POST".to_string(),
        path: format!("/repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}/events"),
        body: serde_json::json!({
            "event": "COMMENT",
            "body": body,
        }),
    }
}

pub fn add_pending_review_thread_request(
    review_node_id: &str,
    body: &str,
    file_path: &str,
    line: u32,
    side: &str,
) -> GhApiJsonRequest {
    GhApiJsonRequest {
        method: "POST".to_string(),
        path: "graphql".to_string(),
        body: serde_json::json!({
            "query": "mutation($input:AddPullRequestReviewThreadInput!){addPullRequestReviewThread(input:$input){comment{id url}}}",
            "variables": {
                "input": {
                    "pullRequestReviewId": review_node_id,
                    "body": body,
                    "path": file_path,
                    "line": line,
                    "side": side,
                }
            }
        }),
    }
}

fn parse_pending_review_json(raw: &str) -> Result<PendingReview> {
    let review: GhPendingReview = serde_json::from_str(raw)?;
    Ok(PendingReview {
        review_id: review.id,
        node_id: review.node_id,
        body: review.body.unwrap_or_default(),
        html_url: review.html_url,
    })
}

fn parse_pending_review_comment_json(raw: &str) -> Result<PendingReviewComment> {
    let value: serde_json::Value = serde_json::from_str(raw)?;
    let comment = &value["data"]["addPullRequestReviewThread"]["comment"];
    let comment_id = comment["id"]
        .as_str()
        .ok_or_else(|| anyhow!("GitHub response did not include a review comment id"))?
        .to_string();
    let url = comment["url"].as_str().map(|url| url.to_string());
    Ok(PendingReviewComment { comment_id, url })
}

pub async fn create_pending_review(
    owner: &str,
    repo: &str,
    number: u64,
    head_sha: &str,
    body: &str,
) -> Result<PendingReview> {
    let raw = gh::api_json(create_pending_review_request(
        owner, repo, number, head_sha, body,
    ))
    .await?;
    parse_pending_review_json(&raw)
}

pub async fn update_pending_review_body(
    owner: &str,
    repo: &str,
    number: u64,
    review_id: u64,
    body: &str,
) -> Result<PendingReview> {
    let raw = gh::api_json(update_pending_review_body_request(
        owner, repo, number, review_id, body,
    ))
    .await?;
    parse_pending_review_json(&raw)
}

pub async fn submit_pending_review(
    owner: &str,
    repo: &str,
    number: u64,
    review_id: u64,
    body: &str,
) -> Result<PendingReview> {
    let raw = gh::api_json(submit_pending_review_request(
        owner, repo, number, review_id, body,
    ))
    .await?;
    parse_pending_review_json(&raw)
}

pub async fn add_pending_review_thread(
    review_node_id: &str,
    body: &str,
    file_path: &str,
    line: u32,
    side: &str,
) -> Result<PendingReviewComment> {
    let raw = gh::api_json(add_pending_review_thread_request(
        review_node_id,
        body,
        file_path,
        line,
        side,
    ))
    .await?;
    parse_pending_review_comment_json(&raw)
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

    #[test]
    fn gh_review_comments_args_target_the_pr_review_comments_endpoint() {
        assert_eq!(
            gh_review_comments_args("garden-co", "jazz", 787),
            vec![
                "api",
                "--paginate",
                "--slurp",
                "/repos/garden-co/jazz/pulls/787/comments?per_page=100",
            ]
        );
    }

    #[test]
    fn gh_review_summaries_args_target_the_pr_reviews_endpoint() {
        assert_eq!(
            gh_review_summaries_args("garden-co", "jazz", 787),
            vec![
                "api",
                "--paginate",
                "--slurp",
                "/repos/garden-co/jazz/pulls/787/reviews?per_page=100",
            ]
        );
    }

    #[test]
    fn parse_pull_request_review_comments_json_keeps_diff_location() {
        let comments = parse_pull_request_review_comments_json(
            r###"[
                [
                    {
                        "id": 101,
                        "user": { "login": "mona" },
                        "body": "This has already been reviewed.",
                        "html_url": "https://github.com/garden-co/jazz/pull/787#discussion_r101",
                        "created_at": "2026-05-05T10:00:00Z",
                        "path": "src/main.ts",
                        "line": 12,
                        "side": "RIGHT",
                        "original_line": 9,
                        "original_side": "RIGHT",
                        "outdated": false
                    }
                ]
            ]"###,
        )
        .unwrap();

        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].id, 101);
        assert_eq!(comments[0].author_login, "mona");
        assert_eq!(comments[0].file_path.as_deref(), Some("src/main.ts"));
        assert_eq!(comments[0].line, Some(12));
        assert_eq!(comments[0].side.as_deref(), Some("RIGHT"));
        assert!(!comments[0].is_outdated);
    }

    #[test]
    fn parse_pull_request_review_summaries_json_keeps_top_level_bodies() {
        let comments = parse_pull_request_review_summaries_json(
            r###"[
                [
                    {
                        "id": 202,
                        "user": { "login": "hubot" },
                        "body": "Top-level review feedback.",
                        "html_url": "https://github.com/garden-co/jazz/pull/787#pullrequestreview-202",
                        "submitted_at": "2026-05-05T11:00:00Z",
                        "state": "COMMENTED"
                    },
                    {
                        "id": 203,
                        "user": { "login": "hubot" },
                        "body": "",
                        "html_url": "https://github.com/garden-co/jazz/pull/787#pullrequestreview-203",
                        "submitted_at": "2026-05-05T11:10:00Z",
                        "state": "COMMENTED"
                    }
                ]
            ]"###,
        )
        .unwrap();

        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].id, 202);
        assert_eq!(comments[0].author_login, "hubot");
        assert_eq!(comments[0].body, "Top-level review feedback.");
        assert_eq!(comments[0].created_at, "2026-05-05T11:00:00Z");
        assert_eq!(comments[0].file_path, None);
    }

    #[test]
    fn create_pending_review_request_omits_submit_event() {
        let request = create_pending_review_request(
            "garden-co",
            "jazz",
            787,
            "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
            "Summary note.",
        );

        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/repos/garden-co/jazz/pulls/787/reviews");
        assert_eq!(
            request.body["commit_id"],
            "57d6bce6ed8e3750f829ff9e9a48b76615df11d6"
        );
        assert_eq!(request.body["body"], "Summary note.");
        assert!(request.body.get("event").is_none());
    }

    #[test]
    fn submit_pending_review_request_uses_comment_event() {
        let request = submit_pending_review_request("garden-co", "jazz", 787, 44, "Summary note.");

        assert_eq!(
            request.path,
            "/repos/garden-co/jazz/pulls/787/reviews/44/events",
        );
        assert_eq!(request.body["event"], "COMMENT");
        assert_eq!(request.body["body"], "Summary note.");
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

    #[tokio::test]
    async fn prepare_local_pr_fetches_from_origin_not_an_explicit_url() {
        let remote_path = temp_repo_path("pr-origin-remote");
        let local_path = temp_repo_path("pr-origin-local");
        fs::create_dir_all(&remote_path).unwrap();

        run_git_sync(&remote_path, &["init", "-b", "main"]);
        run_git_sync(&remote_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &remote_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );
        write_and_commit(&remote_path, "README.md", "base\n", "base");
        run_git_sync(&remote_path, &["checkout", "-b", "feature"]);
        write_and_commit(&remote_path, "README.md", "pr\n", "pr");
        let pr_sha = git_output_sync(&remote_path, &["rev-parse", "feature"]);
        run_git_sync(&remote_path, &["update-ref", "refs/pull/391/head", &pr_sha]);
        run_git_sync(&remote_path, &["checkout", "main"]);

        run_git_sync(
            Path::new("."),
            &[
                "clone",
                &remote_path.to_string_lossy(),
                &local_path.to_string_lossy(),
            ],
        );
        run_git_sync(&local_path, &["config", "user.name", "Guided Review Test"]);
        run_git_sync(
            &local_path,
            &["config", "user.email", "guided-review-test@example.com"],
        );

        let prepared = prepare_local_pr(&local_path, 391).await.unwrap();

        assert_eq!(prepared.head_ref, "guided-review-pr-391");
        assert_eq!(prepared.head_sha, pr_sha);

        fs::remove_dir_all(&remote_path).unwrap();
        fs::remove_dir_all(&local_path).unwrap();
    }
}
