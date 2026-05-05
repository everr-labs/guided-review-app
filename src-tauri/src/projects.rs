use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecentProject {
    Pr {
        repo_url: String,
        owner: String,
        repo: String,
        number: u64,
        last_opened: i64,
    },
    Branch {
        repo_url: String,
        owner: String,
        repo: String,
        branch: String,
        last_opened: i64,
    },
    Local {
        path: PathBuf,
        label: String,
        last_opened: i64,
    },
}

impl RecentProject {
    pub fn fingerprint(&self) -> String {
        match self {
            RecentProject::Pr {
                repo_url, number, ..
            } => format!("pr::{repo_url}::{number}"),
            RecentProject::Branch {
                repo_url, branch, ..
            } => format!("branch::{repo_url}::{branch}"),
            RecentProject::Local { path, .. } => format!("local::{}", path.display()),
        }
    }
}

fn store_path() -> Result<PathBuf> {
    let dir = dirs::data_dir()
        .context("no data dir")?
        .join("co.garden.guided-review");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("recent.json"))
}

pub async fn load() -> Result<Vec<RecentProject>> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&path).await?;
    let list: Vec<RecentProject> = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok(list)
}

pub async fn save(list: &[RecentProject]) -> Result<()> {
    let path = store_path()?;
    let bytes = serde_json::to_vec_pretty(list)?;
    fs::write(&path, bytes).await?;
    Ok(())
}

pub async fn record(p: RecentProject) -> Result<Vec<RecentProject>> {
    let mut list = load().await.unwrap_or_default();
    let fp = p.fingerprint();
    list.retain(|x| x.fingerprint() != fp);
    list.insert(0, p);
    list.truncate(20);
    save(&list).await?;
    Ok(list)
}
