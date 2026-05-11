use crate::acp_client::{start_session, AcpSessions};
use crate::agent_runner::{list_agents, AgentInfo, AgentKind};
use crate::gh::{check_installation, GhCliStatus};
use crate::projects::{self, RecentProject};
use crate::repo::{
    fetch_pull_request_metadata, fetch_pull_request_review_comments, get_changed_ranges, get_diff,
    get_file_at_ref, inspect_origin, parse_pr_url, resolve_source, ClonedRepo, DiffPatch,
    GithubRepoInfo, PublishedPrComment, PullRequestMetadata, SessionSource,
};
use crate::section::LineRange;
use crate::telemetry::{self, TelemetryContext};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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

const AGENT_SKILL: &str = include_str!(".././agent-skill.md");

fn command_span(
    command: &'static str,
    telemetry_context: Option<&TelemetryContext>,
) -> tracing::Span {
    let span = tracing::info_span!("tauri.command", command);
    telemetry::set_span_parent(&span, telemetry_context);
    span
}

fn read_agent_skill_from_disk(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn agent_skill() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("agent-skill.md");
    read_agent_skill_from_disk(&path).unwrap_or_else(|| AGENT_SKILL.to_string())
}

#[tauri::command]
pub async fn list_agents_cmd(telemetry_context: Option<TelemetryContext>) -> Vec<AgentInfo> {
    let span = command_span("list_agents_cmd", telemetry_context.as_ref());
    let _enter = span.enter();
    list_agents()
}

#[tauri::command]
pub async fn agent_skill_cmd(telemetry_context: Option<TelemetryContext>) -> String {
    let span = command_span("agent_skill_cmd", telemetry_context.as_ref());
    let _enter = span.enter();
    agent_skill()
}

#[tauri::command]
pub async fn check_gh_cli_cmd(telemetry_context: Option<TelemetryContext>) -> GhCliStatus {
    let span = command_span("check_gh_cli_cmd", telemetry_context.as_ref());
    async { check_installation().await }.instrument(span).await
}

#[tauri::command]
pub async fn start_session_cmd(
    app: AppHandle,
    sessions: State<'_, AcpSessions>,
    req: StartSessionRequest,
    telemetry_context: Option<TelemetryContext>,
) -> Result<StartSessionResponse, String> {
    let span = tracing::info_span!(
        "session.start",
        agent = ?req.agent_kind,
        source = ?req.source,
    );
    telemetry::set_span_parent(&span, telemetry_context.as_ref());
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
pub async fn parse_pr_url_cmd(
    url: String,
    telemetry_context: Option<TelemetryContext>,
) -> Option<(String, String, u64)> {
    let span = command_span("parse_pr_url_cmd", telemetry_context.as_ref());
    let _enter = span.enter();
    parse_pr_url(&url)
}

#[tauri::command]
pub async fn list_recent_projects_cmd(
    telemetry_context: Option<TelemetryContext>,
) -> Vec<RecentProject> {
    let span = command_span("list_recent_projects_cmd", telemetry_context.as_ref());
    async { projects::load().await.unwrap_or_default() }
        .instrument(span)
        .await
}

#[tauri::command]
pub async fn inspect_local_repo_origin_cmd(
    path: PathBuf,
    telemetry_context: Option<TelemetryContext>,
) -> Result<GithubRepoInfo, String> {
    let span = command_span("inspect_local_repo_origin_cmd", telemetry_context.as_ref());
    async { inspect_origin(&path).await.map_err(|e| e.to_string()) }
        .instrument(span)
        .await
}

#[tauri::command]
pub async fn record_recent_project_cmd(
    project: RecentProject,
    telemetry_context: Option<TelemetryContext>,
) -> Result<(), String> {
    let span = command_span("record_recent_project_cmd", telemetry_context.as_ref());
    async {
        projects::record(project)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn send_message_cmd(
    sessions: State<'_, AcpSessions>,
    session_id: String,
    text: String,
    origin: Option<String>,
    reason: Option<String>,
    section_id: Option<String>,
    suppress_preview: Option<bool>,
    telemetry_context: Option<TelemetryContext>,
) -> Result<(), String> {
    let span = tracing::info_span!("message.send", session_id = %session_id);
    telemetry::set_span_parent(&span, telemetry_context.as_ref());
    async move {
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
    .instrument(span)
    .await
}

#[tauri::command]
pub async fn end_session_cmd(
    sessions: State<'_, AcpSessions>,
    session_id: String,
    telemetry_context: Option<TelemetryContext>,
) -> Result<(), String> {
    let span = command_span("end_session_cmd", telemetry_context.as_ref());
    async move {
        if let Some(sess) = sessions.remove(&session_id).await {
            sess.join.abort();
        }
        Ok(())
    }
    .instrument(span)
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetFileAtRefArgs {
    pub repo_path: PathBuf,
    pub file_path: String,
    pub refspec: String,
}

#[tauri::command]
pub async fn get_file_at_ref_cmd(
    args: GetFileAtRefArgs,
    telemetry_context: Option<TelemetryContext>,
) -> Result<Option<String>, String> {
    let span = command_span("get_file_at_ref_cmd", telemetry_context.as_ref());
    async move {
        let path = args.repo_path;
        let file = args.file_path;
        let refspec = args.refspec;
        tokio::task::spawn_blocking(move || get_file_at_ref(&path, &file, &refspec))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetDiffArgs {
    pub repo_path: PathBuf,
    pub base_ref: String,
    pub head_ref: String,
    pub file_path: Option<String>,
}

#[tauri::command]
pub async fn get_diff_cmd(
    args: GetDiffArgs,
    telemetry_context: Option<TelemetryContext>,
) -> Result<Vec<DiffPatch>, String> {
    let span = command_span("get_diff_cmd", telemetry_context.as_ref());
    async move {
        let path = args.repo_path;
        let base = args.base_ref;
        let head = args.head_ref;
        let file = args.file_path;
        tokio::task::spawn_blocking(move || get_diff(&path, &base, &head, file.as_deref()))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetChangedRangesArgs {
    pub repo_path: PathBuf,
    pub base_ref: String,
    pub head_ref: String,
    pub file_paths: Vec<String>,
}

#[tauri::command]
pub async fn get_changed_ranges_cmd(
    args: GetChangedRangesArgs,
    telemetry_context: Option<TelemetryContext>,
) -> Result<Vec<LineRange>, String> {
    let span = command_span("get_changed_ranges_cmd", telemetry_context.as_ref());
    async move {
        let path = args.repo_path;
        let base = args.base_ref;
        let head = args.head_ref;
        let files = args.file_paths;
        tokio::task::spawn_blocking(move || get_changed_ranges(&path, &base, &head, &files))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    .instrument(span)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reads_agent_skill_from_disk_when_available() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("guided-review-agent-skill-{unique}.md"));
        fs::write(&path, "fresh skill from disk").expect("write test skill");

        let skill = read_agent_skill_from_disk(&path);

        fs::remove_file(&path).expect("remove test skill");
        assert_eq!(skill.as_deref(), Some("fresh skill from disk"));
    }
}
