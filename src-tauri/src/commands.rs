use crate::acp_client::{start_session, AcpSessions};
use crate::agent_runner::{list_agents, AgentInfo, AgentKind};
use crate::gh::{check_installation, GhCliStatus};
use crate::projects::{self, RecentProject};
use crate::repo::{
    add_pending_review_thread, create_pending_review, fetch_pull_request_metadata,
    fetch_pull_request_review_comments, get_diff, get_file_at_ref, inspect_origin, parse_pr_url,
    resolve_source, submit_pending_review, update_pending_review_body, ClonedRepo, DiffPatch,
    GithubRepoInfo, PendingReview, PendingReviewComment, PublishedPrComment, PullRequestMetadata,
    SessionSource,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tracing::Instrument;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionRequest {
    pub source: SessionSource,
    pub agent_kind: AgentKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionResponse {
    pub session_id: String,
    pub repo: ClonedRepo,
    pub source: SessionSource,
    pub pull_request: Option<PullRequestMetadata>,
    pub pull_request_error: Option<String>,
    pub published_comments: Vec<PublishedPrComment>,
    pub published_comments_error: Option<String>,
}

const AGENT_SKILL: &str = include_str!("../../agent-skill.md");

#[tauri::command]
pub async fn list_agents_cmd() -> Vec<AgentInfo> {
    list_agents()
}

#[tauri::command]
pub async fn agent_skill_cmd() -> &'static str {
    AGENT_SKILL
}

#[tauri::command]
pub async fn check_gh_cli_cmd() -> GhCliStatus {
    check_installation().await
}

#[tauri::command]
pub async fn start_session_cmd(
    app: AppHandle,
    sessions: State<'_, AcpSessions>,
    req: StartSessionRequest,
) -> Result<StartSessionResponse, String> {
    let span = tracing::info_span!(
        "session.start",
        agent = ?req.agent_kind,
        source = ?req.source,
    );
    async move {
        let cloned = resolve_source(&req.source)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "resolve_source failed");
                e.to_string()
            })?;
        tracing::info!(repo = %cloned.display_slug, head = %cloned.head_ref, base = %cloned.base_ref, "repo ready");

        let (pull_request, pull_request_error) = pull_request_metadata_for_source(&req.source).await;
        let (published_comments, published_comments_error) =
            published_comments_for_source(&req.source).await;

        let session = start_session(app, req.agent_kind, cloned.path.clone())
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "start_session failed");
                e.to_string()
            })?;
        let session_id = session.session_id.clone();
        tracing::info!(session_id = %session_id, "acp session created");
        sessions.insert(session).await;

        let now = chrono_now();
        let recent = match &req.source {
            SessionSource::Pr {
                repo_url, number, ..
            } => {
                let (owner, repo) = parse_owner_repo(repo_url);
                Some(RecentProject::Pr {
                    repo_url: repo_url.clone(),
                    owner,
                    repo,
                    number: *number,
                    last_opened: now,
                })
            }
            SessionSource::Branch {
                repo_url, branch, ..
            } => {
                let (owner, repo) = parse_owner_repo(repo_url);
                Some(RecentProject::Branch {
                    repo_url: repo_url.clone(),
                    owner,
                    repo,
                    branch: branch.clone(),
                    last_opened: now,
                })
            }
            SessionSource::Sha { .. } => None,
            SessionSource::Local { path }
            | SessionSource::LocalPr { path, .. }
            | SessionSource::LocalBranch { path, .. } => Some(RecentProject::Local {
                path: path.clone(),
                label: cloned.display_slug.clone(),
                last_opened: now,
            }),
        };
        if let Some(r) = recent {
            let _ = projects::record(r).await;
        }

        Ok(StartSessionResponse {
            session_id,
            repo: cloned,
            source: req.source,
            pull_request,
            pull_request_error,
            published_comments,
            published_comments_error,
        })
    }
    .instrument(span)
    .await
}

async fn published_comments_for_source(
    source: &SessionSource,
) -> (Vec<PublishedPrComment>, Option<String>) {
    let target = match source {
        SessionSource::Pr { repo_url, number }
        | SessionSource::LocalPr {
            repo_url, number, ..
        } => Some((repo_url, *number)),
        _ => None,
    };
    let Some((repo_url, number)) = target else {
        return (Vec::new(), None);
    };
    match fetch_pull_request_review_comments(repo_url, number).await {
        Ok(comments) => (comments, None),
        Err(e) => {
            let message = e.to_string();
            tracing::warn!(error = %message, "PR review comments unavailable");
            (Vec::new(), Some(message))
        }
    }
}

async fn pull_request_metadata_for_source(
    source: &SessionSource,
) -> (Option<PullRequestMetadata>, Option<String>) {
    let target = match source {
        SessionSource::Pr { repo_url, number }
        | SessionSource::LocalPr {
            repo_url, number, ..
        } => Some((repo_url, *number)),
        _ => None,
    };
    let Some((repo_url, number)) = target else {
        return (None, None);
    };
    match fetch_pull_request_metadata(repo_url, number).await {
        Ok(metadata) => (Some(metadata), None),
        Err(e) => {
            let message = e.to_string();
            tracing::warn!(error = %message, "PR metadata unavailable");
            (None, Some(message))
        }
    }
}

fn parse_owner_repo(url: &str) -> (String, String) {
    if let Some(parsed) = url::Url::parse(url).ok() {
        let segs: Vec<&str> = parsed
            .path_segments()
            .map(|s| s.collect())
            .unwrap_or_default();
        if segs.len() >= 2 {
            return (
                segs[0].to_string(),
                segs[1].trim_end_matches(".git").to_string(),
            );
        }
    }
    (String::new(), String::new())
}

fn chrono_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn parse_pr_url_cmd(url: String) -> Option<(String, String, u64)> {
    parse_pr_url(&url)
}

#[tauri::command]
pub async fn list_recent_projects_cmd() -> Vec<RecentProject> {
    projects::load().await.unwrap_or_default()
}

#[tauri::command]
pub async fn inspect_local_repo_origin_cmd(path: PathBuf) -> Result<GithubRepoInfo, String> {
    inspect_origin(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn record_recent_project_cmd(project: RecentProject) -> Result<(), String> {
    projects::record(project)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[tracing::instrument(skip(sessions, text), fields(session_id = %session_id))]
pub async fn send_message_cmd(
    sessions: State<'_, AcpSessions>,
    session_id: String,
    text: String,
    origin: Option<String>,
    reason: Option<String>,
    section_id: Option<String>,
    suppress_preview: Option<bool>,
) -> Result<(), String> {
    let sess = sessions
        .get(&session_id)
        .await
        .ok_or_else(|| "unknown session".to_string())?;
    tracing::info!(
        len = text.len(),
        origin = origin.as_deref().unwrap_or("unknown"),
        reason = reason.as_deref().unwrap_or("unknown"),
        section_id = section_id.as_deref().unwrap_or(""),
        suppress_preview = suppress_preview.unwrap_or(false),
        "user prompt",
    );
    sess.send_prompt(text, origin, reason, section_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn end_session_cmd(
    sessions: State<'_, AcpSessions>,
    session_id: String,
) -> Result<(), String> {
    if let Some(sess) = sessions.remove(&session_id).await {
        sess.join.abort();
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetFileAtRefArgs {
    pub repo_path: PathBuf,
    pub file_path: String,
    pub refspec: String,
}

#[tauri::command]
pub async fn get_file_at_ref_cmd(args: GetFileAtRefArgs) -> Result<Option<String>, String> {
    let path = args.repo_path;
    let file = args.file_path;
    let refspec = args.refspec;
    tokio::task::spawn_blocking(move || get_file_at_ref(&path, &file, &refspec))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetDiffArgs {
    pub repo_path: PathBuf,
    pub base_ref: String,
    pub head_ref: String,
    pub file_path: Option<String>,
}

#[tauri::command]
pub async fn get_diff_cmd(args: GetDiffArgs) -> Result<Vec<DiffPatch>, String> {
    let path = args.repo_path;
    let base = args.base_ref;
    let head = args.head_ref;
    let file = args.file_path;
    tokio::task::spawn_blocking(move || get_diff(&path, &base, &head, file.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrTarget {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePendingReviewArgs {
    pub target: PrTarget,
    pub head_sha: String,
    pub body: String,
}

#[tauri::command]
pub async fn create_pending_review_cmd(
    args: CreatePendingReviewArgs,
) -> Result<PendingReview, String> {
    create_pending_review(
        &args.target.owner,
        &args.target.repo,
        args.target.number,
        &args.head_sha,
        &args.body,
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddPendingReviewThreadArgs {
    pub target: PrTarget,
    pub review_node_id: String,
    pub body: String,
    pub file_path: String,
    pub line: u32,
    pub side: String,
}

#[tauri::command]
pub async fn add_pending_review_thread_cmd(
    args: AddPendingReviewThreadArgs,
) -> Result<PendingReviewComment, String> {
    let _target = args.target;
    add_pending_review_thread(
        &args.review_node_id,
        &args.body,
        &args.file_path,
        args.line,
        &args.side,
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePendingReviewBodyArgs {
    pub target: PrTarget,
    pub review_id: u64,
    pub body: String,
}

#[tauri::command]
pub async fn update_pending_review_body_cmd(
    args: UpdatePendingReviewBodyArgs,
) -> Result<PendingReview, String> {
    update_pending_review_body(
        &args.target.owner,
        &args.target.repo,
        args.target.number,
        args.review_id,
        &args.body,
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitPendingReviewArgs {
    pub target: PrTarget,
    pub review_id: u64,
    pub body: String,
}

#[tauri::command]
pub async fn submit_pending_review_cmd(
    args: SubmitPendingReviewArgs,
) -> Result<PendingReview, String> {
    submit_pending_review(
        &args.target.owner,
        &args.target.repo,
        args.target.number,
        args.review_id,
        &args.body,
    )
    .await
    .map_err(|e| e.to_string())
}
