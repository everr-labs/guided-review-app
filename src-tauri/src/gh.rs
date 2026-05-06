use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const PATH_BEGIN_MARKER: &str = "__GUIDED_REVIEW_GH_PATH_BEGIN__";
const PATH_END_MARKER: &str = "__GUIDED_REVIEW_GH_PATH_END__";
const COMMON_GH_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GhCliStatus {
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhApiJsonRequest {
    pub method: String,
    pub path: String,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhInvocation {
    pub args: Vec<String>,
    pub stdin_json: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedGhCommand {
    program: PathBuf,
    path_env: String,
}

impl GhInvocation {
    pub fn args(args: Vec<String>) -> Self {
        Self {
            args,
            stdin_json: None,
        }
    }

    pub fn api_json(request: &GhApiJsonRequest) -> Self {
        Self {
            args: vec![
                "api".to_string(),
                "--method".to_string(),
                request.method.clone(),
                request.path.clone(),
                "--input".to_string(),
                "-".to_string(),
            ],
            stdin_json: Some(request.body.clone()),
        }
    }
}

pub fn missing_gh_message() -> &'static str {
    "GitHub CLI (`gh`) is not installed or could not be found in PATH. Install GitHub CLI to fetch PR details, read review comments, and publish review comments."
}

pub fn parse_gh_version(raw: &str) -> Option<String> {
    raw.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

pub async fn check_installation() -> GhCliStatus {
    let prepared = match prepare_gh_command() {
        Ok(prepared) => prepared,
        Err(e) => {
            return GhCliStatus {
                installed: false,
                version: None,
                error: Some(e.to_string()),
            }
        }
    };

    match Command::new(&prepared.program)
        .arg("--version")
        .env("PATH", &prepared.path_env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
    {
        Ok(out) if out.status.success() => GhCliStatus {
            installed: true,
            version: parse_gh_version(&String::from_utf8_lossy(&out.stdout)),
            error: None,
        },
        Ok(out) => GhCliStatus {
            installed: true,
            version: None,
            error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        },
        Err(e) if e.kind() == ErrorKind::NotFound => GhCliStatus {
            installed: false,
            version: None,
            error: Some(missing_gh_message().to_string()),
        },
        Err(e) => GhCliStatus {
            installed: false,
            version: None,
            error: Some(e.to_string()),
        },
    }
}

pub async fn output(args: &[String]) -> Result<String> {
    run(GhInvocation::args(args.to_vec())).await
}

pub async fn api_json(request: GhApiJsonRequest) -> Result<String> {
    run(GhInvocation::api_json(&request)).await
}

async fn run(invocation: GhInvocation) -> Result<String> {
    let prepared = prepare_gh_command()?;
    let stdin_json = invocation.stdin_json;
    let mut command = Command::new(&prepared.program);
    command
        .args(&invocation.args)
        .env("PATH", &prepared.path_env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_json.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }

    let mut child = command
        .spawn()
        .map_err(|e| {
            if e.kind() == ErrorKind::NotFound {
                anyhow!(missing_gh_message())
            } else {
                anyhow!(e)
            }
        })
        .with_context(|| format!("running gh {:?}", invocation.args))?;

    if let Some(body) = stdin_json {
        let bytes = serde_json::to_vec(&body)?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("gh stdin was not available"))?;
        stdin.write_all(&bytes).await?;
    }

    let out = child
        .wait_with_output()
        .await
        .with_context(|| format!("running gh {:?}", invocation.args))?;
    if !out.status.success() {
        return Err(anyhow!(
            "gh {:?} failed: {}",
            invocation.args,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn prepare_gh_command() -> Result<PreparedGhCommand> {
    let path_env = gh_process_path();
    let program =
        resolve_program_in_path("gh", &path_env).ok_or_else(|| anyhow!(missing_gh_message()))?;

    Ok(PreparedGhCommand { program, path_env })
}

fn gh_process_path() -> String {
    static LOGIN_SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

    let current_path = std::env::var("PATH").unwrap_or_default();
    let shell_path = LOGIN_SHELL_PATH
        .get_or_init(login_shell_path)
        .as_deref()
        .unwrap_or("");
    let common_path = std::env::join_paths(COMMON_GH_PATH_DIRS)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    merge_path_values([current_path.as_str(), shell_path, common_path.as_str()])
}

fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let shell_command = format!("printf '{PATH_BEGIN_MARKER}%s{PATH_END_MARKER}' \"$PATH\"");
    let output = std::process::Command::new(shell)
        .arg("-lc")
        .arg(shell_command)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_marked_path(&stdout)
}

fn extract_marked_path(output: &str) -> Option<String> {
    let start = output.find(PATH_BEGIN_MARKER)? + PATH_BEGIN_MARKER.len();
    let rest = &output[start..];
    let end = rest.find(PATH_END_MARKER)?;
    let path = rest[..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn merge_path_values<I, S>(paths: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut seen = HashSet::new();
    let mut merged = Vec::new();

    for path in paths {
        for dir in std::env::split_paths(&path) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let key = dir.to_string_lossy().into_owned();
            if seen.insert(key) {
                merged.push(dir);
            }
        }
    }

    std::env::join_paths(merged)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn resolve_program_in_path(program: &str, path_env: &str) -> Option<PathBuf> {
    let program_path = Path::new(program);
    if program_path.components().count() > 1 {
        return Some(program_path.to_path_buf());
    }

    std::env::split_paths(path_env)
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_json_invocation_uses_stdin_and_method() {
        let request = GhApiJsonRequest {
            method: "PATCH".to_string(),
            path: "/repos/garden-co/jazz/pulls/787/reviews/44".to_string(),
            body: serde_json::json!({ "body": "Summary note." }),
        };

        let invocation = GhInvocation::api_json(&request);

        assert_eq!(
            invocation.args,
            vec![
                "api",
                "--method",
                "PATCH",
                "/repos/garden-co/jazz/pulls/787/reviews/44",
                "--input",
                "-"
            ]
        );
        assert_eq!(invocation.stdin_json, Some(request.body));
    }

    #[test]
    fn parse_version_reads_first_gh_version_line() {
        assert_eq!(
            parse_gh_version("gh version 2.65.0 (2026-01-01)\nhttps://github.com/cli/cli"),
            Some("gh version 2.65.0 (2026-01-01)".to_string())
        );
    }

    #[test]
    fn missing_gh_message_is_actionable() {
        assert_eq!(
            missing_gh_message(),
            "GitHub CLI (`gh`) is not installed or could not be found in PATH. Install GitHub CLI to fetch PR details, read review comments, and publish review comments."
        );
    }

    #[test]
    fn extracts_shell_path_even_when_startup_files_print_text() {
        assert_eq!(
            extract_marked_path(
                "welcome\n__GUIDED_REVIEW_GH_PATH_BEGIN__/opt/homebrew/bin:/usr/bin__GUIDED_REVIEW_GH_PATH_END__\n"
            ),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
    }

    #[test]
    fn merge_path_values_keeps_first_copy_of_each_dir() {
        let merged = merge_path_values(["/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin"]);
        let parts: Vec<_> = std::env::split_paths(&merged).collect();

        assert_eq!(parts[0], std::path::PathBuf::from("/usr/bin"));
        assert_eq!(parts[1], std::path::PathBuf::from("/bin"));
        assert_eq!(parts[2], std::path::PathBuf::from("/opt/homebrew/bin"));
    }

    #[test]
    fn resolve_program_in_path_finds_executable_file() {
        let temp_dir =
            std::env::temp_dir().join(format!("guided-review-gh-path-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let gh_path = temp_dir.join("gh");
        std::fs::write(&gh_path, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&gh_path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&gh_path, perms).unwrap();
        }

        let path_env = std::env::join_paths([temp_dir.as_path()]).unwrap();
        let resolved = resolve_program_in_path("gh", &path_env.to_string_lossy());

        assert_eq!(resolved, Some(gh_path.clone()));

        let _ = std::fs::remove_file(gh_path);
        let _ = std::fs::remove_dir(temp_dir);
    }
}
