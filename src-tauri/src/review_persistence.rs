use anyhow::{Context, Result};
use libsql::{params, Builder, Database};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewPersistenceTarget {
    pub repo_url: String,
    pub number: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_project_path: Option<PathBuf>,
}

impl ReviewPersistenceTarget {
    pub fn id(&self) -> String {
        format!("pr::{}::{}", self.repo_url, self.number)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveReviewState {
    pub target: ReviewPersistenceTarget,
    pub base_ref: String,
    pub head_ref: String,
    pub head_sha: String,
    pub snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedReviewRecord {
    pub id: String,
    pub repo_url: String,
    pub number: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_project_path: Option<PathBuf>,
    pub base_ref: String,
    pub head_ref: String,
    pub head_sha: String,
    pub snapshot: Value,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub is_stale: bool,
}

impl SavedReviewRecord {
    pub fn is_stale_for(&self, head_sha: &str) -> bool {
        self.head_sha != head_sha
    }
}

pub struct ReviewPersistence {
    db: Database,
}

impl ReviewPersistence {
    pub async fn open_at(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let db = Builder::new_local(path.to_string_lossy().to_string())
            .build()
            .await
            .with_context(|| format!("opening review state database {}", path.display()))?;
        let store = Self { db };
        store.migrate().await?;
        Ok(store)
    }

    pub async fn open_default() -> Result<Self> {
        let path = default_db_path()?;
        Self::open_at(&path).await
    }

    async fn migrate(&self) -> Result<()> {
        let conn = self.db.connect()?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS review_states (
                id TEXT PRIMARY KEY NOT NULL,
                repo_url TEXT NOT NULL,
                pr_number INTEGER NOT NULL,
                local_project_path TEXT,
                base_ref TEXT NOT NULL,
                head_ref TEXT NOT NULL,
                head_sha TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_review_states_pr
                ON review_states (repo_url, pr_number);
            "#,
        )
        .await?;
        Ok(())
    }

    pub async fn save(&self, state: SaveReviewState) -> Result<SavedReviewRecord> {
        let conn = self.db.connect()?;
        let now = chrono_now();
        let id = state.target.id();
        let target = state.target.clone();
        let snapshot_json = serde_json::to_string(&state.snapshot)?;
        let local_project_path = state
            .target
            .local_project_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        conn.execute(
            r#"
            INSERT INTO review_states (
                id,
                repo_url,
                pr_number,
                local_project_path,
                base_ref,
                head_ref,
                head_sha,
                snapshot_json,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                repo_url = excluded.repo_url,
                pr_number = excluded.pr_number,
                local_project_path = excluded.local_project_path,
                base_ref = excluded.base_ref,
                head_ref = excluded.head_ref,
                head_sha = excluded.head_sha,
                snapshot_json = excluded.snapshot_json,
                updated_at = excluded.updated_at
            "#,
            params![
                id,
                state.target.repo_url,
                state.target.number as i64,
                local_project_path,
                state.base_ref,
                state.head_ref,
                state.head_sha,
                snapshot_json,
                now,
                now,
            ],
        )
        .await?;
        self.load(&target)
            .await?
            .context("saved review state was not readable after write")
    }

    pub async fn load(
        &self,
        target: &ReviewPersistenceTarget,
    ) -> Result<Option<SavedReviewRecord>> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                r#"
                SELECT
                    id,
                    repo_url,
                    pr_number,
                    local_project_path,
                    base_ref,
                    head_ref,
                    head_sha,
                    snapshot_json,
                    created_at,
                    updated_at
                FROM review_states
                WHERE id = ?1
                LIMIT 1
                "#,
                params![target.id()],
            )
            .await?;
        let Some(row) = rows.next().await? else {
            return Ok(None);
        };
        let snapshot_json: String = row.get(7)?;
        let local_project_path: Option<String> = row.get(3)?;
        let pr_number: i64 = row.get(2)?;
        Ok(Some(SavedReviewRecord {
            id: row.get(0)?,
            repo_url: row.get(1)?,
            number: pr_number as u64,
            local_project_path: local_project_path.map(PathBuf::from),
            base_ref: row.get(4)?,
            head_ref: row.get(5)?,
            head_sha: row.get(6)?,
            snapshot: serde_json::from_str(&snapshot_json)?,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            is_stale: false,
        }))
    }

    pub async fn delete(&self, target: &ReviewPersistenceTarget) -> Result<()> {
        let conn = self.db.connect()?;
        conn.execute(
            "DELETE FROM review_states WHERE id = ?1",
            params![target.id()],
        )
        .await?;
        Ok(())
    }
}

pub fn target_from_source(
    source: &crate::repo::SessionSource,
) -> Option<ReviewPersistenceTarget> {
    match source {
        crate::repo::SessionSource::Pr { repo_url, number } => Some(ReviewPersistenceTarget {
            repo_url: repo_url.clone(),
            number: *number,
            local_project_path: None,
        }),
        crate::repo::SessionSource::LocalPr {
            path,
            repo_url,
            number,
        } => Some(ReviewPersistenceTarget {
            repo_url: repo_url.clone(),
            number: *number,
            local_project_path: Some(path.clone()),
        }),
        _ => None,
    }
}

fn default_db_path() -> Result<PathBuf> {
    Ok(dirs::data_dir()
        .context("no data dir")?
        .join("co.garden.guided-review")
        .join("review-state.db"))
}

fn chrono_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("guided-review-{name}-{unique}.db"))
    }

    fn target() -> ReviewPersistenceTarget {
        ReviewPersistenceTarget {
            repo_url: "https://github.com/garden-co/jazz".to_string(),
            number: 787,
            local_project_path: Some(PathBuf::from("/Users/guidodorsi/dev/jazz")),
        }
    }

    #[tokio::test]
    async fn saves_and_loads_latest_review_snapshot_by_pr_target() {
        let path = temp_db_path("snapshot");
        let store = ReviewPersistence::open_at(&path).await.unwrap();
        let target = target();

        store
            .save(SaveReviewState {
                target: target.clone(),
                base_ref: "origin/main".to_string(),
                head_ref: "guided-review-pr-787".to_string(),
                head_sha: "head-1".to_string(),
                snapshot: json!({
                    "current_section_id": "validation",
                    "sections": [
                        { "id": "validation", "title": "Validation", "kind": "review_section" }
                    ]
                }),
            })
            .await
            .unwrap();

        let loaded = store.load(&target).await.unwrap().unwrap();

        assert_eq!(loaded.repo_url, target.repo_url);
        assert_eq!(loaded.number, 787);
        assert_eq!(loaded.local_project_path, target.local_project_path);
        assert_eq!(loaded.base_ref, "origin/main");
        assert_eq!(loaded.head_ref, "guided-review-pr-787");
        assert_eq!(loaded.head_sha, "head-1");
        assert!(!loaded.is_stale_for("head-1"));
        assert!(loaded.is_stale_for("head-2"));
        assert_eq!(loaded.snapshot["current_section_id"], "validation");

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn delete_removes_saved_review_for_start_over() {
        let path = temp_db_path("delete");
        let store = ReviewPersistence::open_at(&path).await.unwrap();
        let target = target();

        store
            .save(SaveReviewState {
                target: target.clone(),
                base_ref: "origin/main".to_string(),
                head_ref: "guided-review-pr-787".to_string(),
                head_sha: "head-1".to_string(),
                snapshot: json!({ "current_section_id": "overview" }),
            })
            .await
            .unwrap();

        store.delete(&target).await.unwrap();

        assert!(store.load(&target).await.unwrap().is_none());

        let _ = std::fs::remove_file(path);
    }
}
