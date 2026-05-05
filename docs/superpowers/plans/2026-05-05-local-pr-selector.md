# Local PR Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current repo/PR selector with a local-only PR selector that accepts a PR number or PR URL, requires a selected local repo, blocks mismatched PR URLs, and removes the fake agent option.

**Architecture:** The frontend owns the simple input flow and validation. The backend owns local Git inspection, especially reading and normalizing the selected repo's `origin` remote. Reviews still start through the existing `local_pr` session source so the agent runs inside the selected local folder.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri commands, Rust, `git` CLI, `node:test`, `tsx`, Cargo tests.

---

## File Structure

- Modify `src/lib/projectSource.ts`
  - Own pure frontend parsing and validation helpers.
  - Keep logic independent from React so it is easy to test.

- Modify `src/lib/projectSource.test.ts`
  - Cover PR input parsing, local source creation, mismatch blocking, and local-only recent filtering.

- Modify `src-tauri/src/repo.rs`
  - Add GitHub origin parsing.
  - Add selected-repo origin inspection.
  - Keep PR fetching logic in the existing local PR flow.

- Modify `src-tauri/src/commands.rs`
  - Expose a Tauri command for local repo origin inspection.

- Modify `src-tauri/src/lib.rs`
  - Register the new Tauri command.

- Modify `src/lib/acp.ts`
  - Add the frontend type and invoke wrapper for local repo origin inspection.
  - Remove the fake agent from the frontend `AgentKind` type.
  - Keep existing session source variants to avoid unrelated churn.

- Replace most of `src/components/ProjectPicker.tsx`
  - Remove the tabbed remote/local modes.
  - Use one PR input and one local repo picker.
  - Show only local recent repos.

- Modify `src-tauri/src/agent_runner.rs`
  - Remove the fake agent enum variant, launch command, label, and list entry.

- Delete `scripts/fake-acp-agent.mjs`
  - Remove the offline stub because the app should only offer real agents.

---

## Task 1: Frontend Project Source Helpers

**Files:**
- Modify: `src/lib/projectSource.test.ts`
- Modify: `src/lib/projectSource.ts`

- [ ] **Step 1: Replace the helper tests with local-only PR selector tests**

Replace `src/lib/projectSource.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
	localPrSourceFromSelection,
	localRecentProjects,
	parsePrInput,
	type LocalRepoOrigin,
} from "./projectSource";
import type { RecentProject } from "./acp";

const origin: LocalRepoOrigin = {
	repo_url: "https://github.com/openai/codex",
	owner: "openai",
	repo: "codex",
	slug: "openai/codex",
};

test("parsePrInput accepts a plain PR number", () => {
	assert.deepEqual(parsePrInput(" 123 "), {
		value: {
			number: 123,
			rawKind: "number",
		},
	});
});

test("parsePrInput accepts a GitHub PR URL and keeps repo details", () => {
	assert.deepEqual(
		parsePrInput("https://github.com/OpenAI/codex/pull/123"),
		{
			value: {
				number: 123,
				owner: "OpenAI",
				repo: "codex",
				repoSlug: "openai/codex",
				rawKind: "url",
			},
		},
	);
});

test("parsePrInput rejects empty, zero, and non-GitHub values", () => {
	assert.deepEqual(parsePrInput(""), {
		error: "Enter a PR number or GitHub PR URL.",
	});
	assert.deepEqual(parsePrInput("0"), {
		error: "Enter a PR number greater than 0.",
	});
	assert.deepEqual(parsePrInput("https://gitlab.com/openai/codex/-/merge_requests/123"), {
		error: "Enter a PR number or GitHub PR URL like 123 or https://github.com/owner/repo/pull/123.",
	});
});

test("localPrSourceFromSelection builds a local PR source from selected origin", () => {
	assert.deepEqual(
		localPrSourceFromSelection({
			input: "https://github.com/openai/codex/pull/123",
			localPath: "/Users/guidodorsi/dev/codex",
			origin,
		}),
		{
			source: {
				kind: "local_pr",
				path: "/Users/guidodorsi/dev/codex",
				repo_url: "https://github.com/openai/codex",
				number: 123,
			},
		},
	);
});

test("localPrSourceFromSelection blocks mismatched PR URLs", () => {
	assert.deepEqual(
		localPrSourceFromSelection({
			input: "https://github.com/other/project/pull/123",
			localPath: "/Users/guidodorsi/dev/codex",
			origin,
		}),
		{
			error:
				"This PR URL is for other/project, but the selected folder uses openai/codex as origin.",
		},
	);
});

test("localPrSourceFromSelection explains missing local repo or origin", () => {
	assert.deepEqual(
		localPrSourceFromSelection({
			input: "123",
			localPath: "",
			origin,
		}),
		{ error: "Choose a local repository folder first." },
	);
	assert.deepEqual(
		localPrSourceFromSelection({
			input: "123",
			localPath: "/Users/guidodorsi/dev/codex",
			origin: null,
		}),
		{ error: "Choose a local GitHub repository folder first." },
	);
});

test("localRecentProjects keeps only local recent projects", () => {
	const recents: RecentProject[] = [
		{
			kind: "pr",
			repo_url: "https://github.com/openai/codex",
			owner: "openai",
			repo: "codex",
			number: 123,
			last_opened: 3,
		},
		{
			kind: "local",
			path: "/Users/guidodorsi/dev/codex",
			label: "codex",
			last_opened: 2,
		},
		{
			kind: "branch",
			repo_url: "https://github.com/openai/codex",
			owner: "openai",
			repo: "codex",
			branch: "feature/name",
			last_opened: 1,
		},
	];

	assert.deepEqual(localRecentProjects(recents), [
		{
			kind: "local",
			path: "/Users/guidodorsi/dev/codex",
			label: "codex",
			last_opened: 2,
		},
	]);
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
npx tsx --test src/lib/projectSource.test.ts
```

Expected: the command fails because `parsePrInput`, `localPrSourceFromSelection`, `localRecentProjects`, and `LocalRepoOrigin` are not exported yet.

- [ ] **Step 3: Replace the helper implementation**

Replace `src/lib/projectSource.ts` with:

```ts
import type { RecentProject, SessionSource } from "./acp";

export type LocalRecentProject = Extract<RecentProject, { kind: "local" }>;

export interface ParsedPrInput {
	number: number;
	owner?: string;
	repo?: string;
	repoSlug?: string;
	rawKind: "number" | "url";
}

export interface LocalRepoOrigin {
	repo_url: string;
	owner: string;
	repo: string;
	slug: string;
}

type Result<T> = { value: T } | { error: string };
type SourceResult = { source: SessionSource } | { error: string };

function normalizeSlug(owner: string, repo: string): string {
	return `${owner}/${repo}`.toLowerCase();
}

function parsePositivePrNumber(value: string): number | null {
	if (!/^[0-9]+$/.test(value)) return null;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function parsePrInput(input: string): Result<ParsedPrInput> {
	const trimmed = input.trim();
	if (!trimmed) {
		return { error: "Enter a PR number or GitHub PR URL." };
	}

	if (/^[0-9]+$/.test(trimmed)) {
		const number = parsePositivePrNumber(trimmed);
		if (number === null) {
			return { error: "Enter a PR number greater than 0." };
		}
		return {
			value: {
				number,
				rawKind: "number",
			},
		};
	}

	try {
		const url = new URL(trimmed);
		if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
			return {
				error:
					"Enter a PR number or GitHub PR URL like 123 or https://github.com/owner/repo/pull/123.",
			};
		}
		const segments = url.pathname.split("/").filter(Boolean);
		if (segments.length < 4 || segments[2] !== "pull") {
			return {
				error:
					"Enter a PR number or GitHub PR URL like 123 or https://github.com/owner/repo/pull/123.",
			};
		}
		const number = parsePositivePrNumber(segments[3]);
		if (number === null) {
			return { error: "Enter a PR number greater than 0." };
		}
		const owner = segments[0];
		const repo = segments[1].replace(/\.git$/, "");
		return {
			value: {
				number,
				owner,
				repo,
				repoSlug: normalizeSlug(owner, repo),
				rawKind: "url",
			},
		};
	} catch {
		return {
			error:
				"Enter a PR number or GitHub PR URL like 123 or https://github.com/owner/repo/pull/123.",
		};
	}
}

export function localPrSourceFromSelection({
	input,
	localPath,
	origin,
}: {
	input: string;
	localPath: string;
	origin: LocalRepoOrigin | null;
}): SourceResult {
	const parsed = parsePrInput(input);
	if ("error" in parsed) return parsed;

	const path = localPath.trim();
	if (!path) return { error: "Choose a local repository folder first." };
	if (!origin) {
		return { error: "Choose a local GitHub repository folder first." };
	}

	const pr = parsed.value;
	if (pr.repoSlug && pr.repoSlug !== origin.slug.toLowerCase()) {
		return {
			error: `This PR URL is for ${pr.repoSlug}, but the selected folder uses ${origin.slug} as origin.`,
		};
	}

	return {
		source: {
			kind: "local_pr",
			path,
			repo_url: origin.repo_url,
			number: pr.number,
		},
	};
}

export function localRecentProjects(
	recents: RecentProject[],
): LocalRecentProject[] {
	return recents.filter(
		(project): project is LocalRecentProject => project.kind === "local",
	);
}
```

- [ ] **Step 4: Run the helper tests and verify they pass**

Run:

```bash
npx tsx --test src/lib/projectSource.test.ts
```

Expected: all tests in `src/lib/projectSource.test.ts` pass.

- [ ] **Step 5: Commit the helper change**

```bash
git add src/lib/projectSource.ts src/lib/projectSource.test.ts
git commit -m "test: cover local PR source helpers"
```

---

## Task 2: Backend GitHub Origin Parsing

**Files:**
- Modify: `src-tauri/src/repo.rs`

- [ ] **Step 1: Add failing Rust tests for GitHub origin parsing**

Add this test module near the end of `src-tauri/src/repo.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

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
}
```

- [ ] **Step 2: Run the Rust tests and verify they fail**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml parse_github_repo_url -- --nocapture
```

Expected: the command fails because `parse_github_repo_url` does not exist yet.

- [ ] **Step 3: Add GitHub repo info parsing and origin inspection**

In `src-tauri/src/repo.rs`, add this struct after `ClonedRepo`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GithubRepoInfo {
    pub repo_url: String,
    pub owner: String,
    pub repo: String,
    pub slug: String,
}
```

Add these functions near `parse_pr_url`:

```rust
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
        if !matches!(parsed.host_str(), Some("github.com") | Some("www.github.com")) {
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
```

- [ ] **Step 4: Run the Rust parsing tests and verify they pass**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml parse_github_repo_url -- --nocapture
```

Expected: both parsing tests pass.

- [ ] **Step 5: Commit the backend parsing change**

```bash
git add src-tauri/src/repo.rs
git commit -m "feat: parse GitHub origin remotes"
```

---

## Task 3: Backend Origin Inspection Command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/acp.ts`

- [ ] **Step 1: Add the Tauri command**

In `src-tauri/src/commands.rs`, change the `crate::repo` import to include `inspect_origin` and `GithubRepoInfo`:

```rust
use crate::repo::{
    get_diff, get_file_at_ref, inspect_origin, parse_pr_url, resolve_source, ClonedRepo, DiffPatch,
    GithubRepoInfo, SessionSource,
};
```

Add this command near `list_recent_projects_cmd`:

```rust
#[tauri::command]
pub async fn inspect_local_repo_origin_cmd(path: PathBuf) -> Result<GithubRepoInfo, String> {
    inspect_origin(&path).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, add `inspect_local_repo_origin_cmd` to the `tauri::generate_handler!` list:

```rust
            inspect_local_repo_origin_cmd,
```

Place it after `list_recent_projects_cmd` so the command list stays grouped with project metadata commands.

- [ ] **Step 3: Add the frontend invoke wrapper**

In `src/lib/acp.ts`, add this interface after `PrTarget`:

```ts
export interface LocalRepoOrigin {
	repo_url: string;
	owner: string;
	repo: string;
	slug: string;
}
```

Add this method after `listRecentProjects`:

```ts
	inspectLocalRepoOrigin: (path: string) =>
		invoke<LocalRepoOrigin>("inspect_local_repo_origin_cmd", { path }),
```

- [ ] **Step 4: Run backend and frontend type checks**

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Cargo check passes.

Run:

```bash
npm run check
```

Expected: this may fail until `ProjectPicker.tsx` is rewritten in Task 5, because the helper exports changed in Task 1. Any failure should be limited to old `ProjectPicker.tsx` imports and usage.

- [ ] **Step 5: Commit the command bridge**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/acp.ts
git commit -m "feat: expose local repo origin inspection"
```

---

## Task 4: Remove The Fake Agent

**Files:**
- Modify: `src-tauri/src/agent_runner.rs`
- Modify: `src/lib/acp.ts`
- Delete: `scripts/fake-acp-agent.mjs`

- [ ] **Step 1: Add a failing backend test that the fake agent is absent**

Add this test module to the end of `src-tauri/src/agent_runner.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_agents_excludes_fake_agent() {
        let agents = list_agents();
        let kinds: Vec<AgentKind> = agents.into_iter().map(|agent| agent.kind).collect();

        assert_eq!(kinds, vec![AgentKind::ClaudeCode, AgentKind::Codex]);
    }
}
```

- [ ] **Step 2: Run the backend agent test and verify it fails**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml list_agents_excludes_fake_agent -- --nocapture
```

Expected: the test fails because `list_agents()` still includes `AgentKind::Fake`.

- [ ] **Step 3: Remove the fake agent from Rust**

Replace `src-tauri/src/agent_runner.rs` with:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
}

impl AgentKind {
    pub fn label(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "Claude Code",
            AgentKind::Codex => "Codex",
        }
    }

    pub fn launch_command(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "npx -y @zed-industries/claude-code-acp",
            AgentKind::Codex => "npx -y @zed-industries/codex-acp",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub kind: AgentKind,
    pub label: &'static str,
    pub launch_command: &'static str,
}

pub fn list_agents() -> Vec<AgentInfo> {
    [AgentKind::ClaudeCode, AgentKind::Codex]
        .into_iter()
        .map(|kind| AgentInfo {
            kind,
            label: kind.label(),
            launch_command: kind.launch_command(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_agents_excludes_fake_agent() {
        let agents = list_agents();
        let kinds: Vec<AgentKind> = agents.into_iter().map(|agent| agent.kind).collect();

        assert_eq!(kinds, vec![AgentKind::ClaudeCode, AgentKind::Codex]);
    }
}
```

- [ ] **Step 4: Remove the fake agent from TypeScript**

In `src/lib/acp.ts`, replace:

```ts
export type AgentKind = "claude_code" | "codex" | "fake";
```

with:

```ts
export type AgentKind = "claude_code" | "codex";
```

- [ ] **Step 5: Delete the fake ACP script**

Run:

```bash
if git ls-files --error-unmatch scripts/fake-acp-agent.mjs >/dev/null 2>&1; then git rm scripts/fake-acp-agent.mjs; else rm -f scripts/fake-acp-agent.mjs; fi
```

Expected: `scripts/fake-acp-agent.mjs` no longer exists.

- [ ] **Step 6: Run the agent test and checks**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml list_agents_excludes_fake_agent -- --nocapture
```

Expected: the test passes.

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Cargo check passes.

- [ ] **Step 7: Commit the fake-agent removal**

```bash
git add src-tauri/src/agent_runner.rs src/lib/acp.ts
git add -u scripts/fake-acp-agent.mjs
git commit -m "feat: remove fake agent option"
```

---

## Task 5: Replace the Project Picker UI

**Files:**
- Modify: `src/components/ProjectPicker.tsx`

- [ ] **Step 1: Replace imports**

At the top of `src/components/ProjectPicker.tsx`, replace the current imports with:

```tsx
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, GitPullRequest } from "lucide-react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import {
	acp,
	type AgentInfo,
	type AgentKind,
	type LocalRepoOrigin,
	type SessionSource,
} from "@/lib/acp";
import { cn } from "@/lib/utils";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";
import {
	localPrSourceFromSelection,
	localRecentProjects,
	type LocalRecentProject,
} from "@/lib/projectSource";
```

- [ ] **Step 2: Replace old project label helpers**

Replace `projectLabel` and `projectSubtitle` with:

```tsx
function projectLabel(project: LocalRecentProject): string {
	return project.label || project.path.split(/[\\/]/).pop() || project.path;
}

function projectSubtitle(project: LocalRecentProject): string {
	return project.path;
}
```

- [ ] **Step 3: Replace selector state**

Inside `ProjectPicker`, replace the old source-mode state with this state:

```tsx
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [prInput, setPrInput] = useState("");
	const [localPath, setLocalPath] = useState("");
	const [origin, setOrigin] = useState<LocalRepoOrigin | null>(null);
	const [originLoading, setOriginLoading] = useState(false);
	const [recents, setRecents] = useState<LocalRecentProject[]>([]);
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [agentKind, setAgentKind] = useState<AgentKind>("claude_code");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
```

- [ ] **Step 4: Update metadata loading**

Replace the metadata loading effect with:

```tsx
	useEffect(() => {
		(async () => {
			try {
				const [recentProjects, availableAgents] = await Promise.all([
					acp.listRecentProjects(),
					acp.listAgents(),
				]);
				setRecents(localRecentProjects(recentProjects));
				setAgents(availableAgents);
			} catch (e) {
				recordClientTelemetryError("client.project.metadata_load.failed", e, {
					"dropdown.open": open,
				});
			}
		})();
	}, [open]);
```

- [ ] **Step 5: Add origin inspection when the selected folder changes**

Add this effect after metadata loading:

```tsx
	useEffect(() => {
		if (!localPath) {
			setOrigin(null);
			setOriginLoading(false);
			return;
		}

		let cancelled = false;
		setOrigin(null);
		setOriginLoading(true);
		setError(null);

		(async () => {
			try {
				const info = await acp.inspectLocalRepoOrigin(localPath);
				if (!cancelled) setOrigin(info);
			} catch (e) {
				if (!cancelled) {
					setOrigin(null);
					setError(String(e));
				}
			} finally {
				if (!cancelled) setOriginLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [localPath]);
```

- [ ] **Step 6: Replace filtering and validation**

Replace the old `filtered` calculation with:

```tsx
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return recents;
		return recents.filter((project) => {
			const label = projectLabel(project).toLowerCase();
			const sub = projectSubtitle(project).toLowerCase();
			return label.includes(q) || sub.includes(q);
		});
	}, [query, recents]);

	const sourceResult = useMemo(
		() =>
			localPrSourceFromSelection({
				input: prInput,
				localPath,
				origin,
			}),
		[prInput, localPath, origin],
	);

	const validationError =
		originLoading && localPath
			? "Checking selected repository origin..."
			: "error" in sourceResult
				? sourceResult.error
				: null;
	const canStart = !starting && !originLoading && "source" in sourceResult;
```

- [ ] **Step 7: Keep the start function but clear local-only fields**

In `start(source: SessionSource)`, keep the existing kickoff logic. Replace the field clearing block with:

```tsx
			setOpen(false);
			setQuery("");
			setPrInput("");
```

Remove clearing for `remoteRepoUrl`, `remoteBranch`, `localPrUrl`, and `localBranch` because those fields no longer exist.

- [ ] **Step 8: Replace start handlers**

Remove `startFromPrUrl`, `startFromRemoteBranch`, `startFromLocalPrUrl`, `startFromLocalBranch`, and `openRecent`.

Add:

```tsx
	async function startFromSelection(e?: FormEvent) {
		e?.preventDefault();
		const result = localPrSourceFromSelection({
			input: prInput,
			localPath,
			origin,
		});
		if ("error" in result) {
			setError(result.error);
			return;
		}
		await start(result.source);
	}

	function chooseRecent(project: LocalRecentProject) {
		setLocalPath(project.path);
		setError(null);
		setQuery("");
	}
```

Keep `pickLocal`, but remove `setSourceMode("local")` from it:

```tsx
	async function pickLocal() {
		try {
			const selected = await openDialog({ directory: true, multiple: false });
			if (typeof selected === "string") {
				setLocalPath(selected);
				setError(null);
			}
		} catch (e) {
			setError(String(e));
		}
	}
```

- [ ] **Step 9: Replace the dropdown content**

Replace the JSX inside `<DropdownMenu.Content>` with:

```tsx
					<Command shouldFilter={false}>
						<form className="border-b border-border p-3" onSubmit={startFromSelection}>
							<div className="space-y-3">
								<label className="block">
									<span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
										Pull request
									</span>
									<div className="flex gap-2">
										<Input
											value={prInput}
											onChange={(e) => {
												setPrInput(e.target.value);
												setError(null);
											}}
											placeholder="123 or https://github.com/owner/repo/pull/123"
											disabled={starting}
										/>
										<Button type="submit" disabled={!canStart}>
											Start Review
										</Button>
									</div>
								</label>

								<div className="space-y-2">
									<div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
										Local repository
									</div>
									<Button
										type="button"
										variant="outline"
										onClick={pickLocal}
										disabled={starting}
										className="w-full justify-start"
									>
										<FolderOpen className="size-4" />
										{localPath ? "Change local folder" : "Choose local folder"}
									</Button>
									{localPath && (
										<div className="truncate rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
											{localPath}
										</div>
									)}
									{origin && (
										<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
											<GitPullRequest className="size-3.5" />
											<span>{origin.slug}</span>
										</div>
									)}
								</div>
							</div>
						</form>

						{(error || validationError) && (
							<div className="mx-3 my-2 rounded-md bg-destructive/15 px-2 py-1.5 text-xs text-destructive">
								{error ?? validationError}
							</div>
						)}
						{starting && (
							<div className="px-4 py-2 text-xs text-muted-foreground">
								Starting...
							</div>
						)}

						<CommandInput
							placeholder="Search recent local repos..."
							value={query}
							onValueChange={setQuery}
							disabled={starting}
						/>
						<CommandList>
							<CommandEmpty>No matches</CommandEmpty>
							{session && (
								<CommandGroup heading="This Window">
									<CommandItem
										value={`__session::${session.session_id}`}
										onSelect={() => setOpen(false)}
									>
										<div className="min-w-0 flex-1">
											<div>{session.repo.display_slug}</div>
											<div className="truncate font-mono text-[11px] text-muted-foreground">
												{session.repo.head_ref} ← {session.repo.base_ref}
											</div>
										</div>
									</CommandItem>
								</CommandGroup>
							)}
							{filtered.length > 0 && (
								<CommandGroup heading="Recent Local Repos">
									{filtered.map((project) => (
										<CommandItem
											key={`local:${project.path}`}
											value={`${projectLabel(project)} ${projectSubtitle(project)}`}
											onSelect={() => chooseRecent(project)}
											disabled={starting}
										>
											<FolderOpen className="mr-2 size-3.5 text-muted-foreground" />
											<div className="min-w-0 flex-1">
												<div>{projectLabel(project)}</div>
												<div className="truncate font-mono text-[11px] text-muted-foreground">
													{projectSubtitle(project)}
												</div>
											</div>
										</CommandItem>
									))}
								</CommandGroup>
							)}
						</CommandList>
						<div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
							<label className="flex items-center gap-2">
								<span>Agent</span>
								<select
									value={agentKind}
									onChange={(e) => setAgentKind(e.target.value as AgentKind)}
									className="rounded-md border border-border bg-input px-1.5 py-0.5 text-foreground"
									disabled={starting}
								>
									{agents.map((agent) => (
										<option key={agent.kind} value={agent.kind}>
											{agent.label}
										</option>
									))}
								</select>
							</label>
						</div>
					</Command>
```

- [ ] **Step 10: Run TypeScript check**

Run:

```bash
npm run check
```

Expected: TypeScript check passes. If it fails, fix only errors introduced by this selector work.

- [ ] **Step 11: Commit the picker change**

```bash
git add src/components/ProjectPicker.tsx
git commit -m "feat: replace project picker with local PR selector"
```

---

## Task 6: Full Verification And Manual Checks

**Files:**
- Verify: `src/lib/projectSource.test.ts`
- Verify: `src-tauri/src/repo.rs`
- Verify: full app build

- [ ] **Step 1: Run frontend helper tests**

Run:

```bash
npx tsx --test src/lib/projectSource.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run frontend type and build checks**

Run:

```bash
npm run check
```

Expected: TypeScript check passes.

Run:

```bash
npm run build
```

Expected: TypeScript build and Vite build pass.

- [ ] **Step 3: Run backend tests and checks**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml parse_github_repo_url -- --nocapture
```

Expected: GitHub origin parsing tests pass.

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: Cargo check passes.

- [ ] **Step 4: Manually verify the selector in the app**

Run:

```bash
npm run tauri dev
```

Expected: the app opens.

Manual checks:

- Open the project selector.
- Confirm there are no tabs for remote PR, remote branch, or local branch.
- Enter `123`, then choose a local GitHub repo folder. Start Review becomes enabled after origin inspection succeeds.
- Choose a local GitHub repo folder first, then enter `123`. Start Review becomes enabled.
- Paste a matching PR URL for the selected repo. Start Review stays enabled.
- Paste a PR URL for a different repo. Start Review is disabled and shows the mismatch warning.
- Confirm recent projects show local folders only.

- [ ] **Step 5: Commit verification fixes if any were needed**

If verification required fixes, commit those changed files with an exact path list:

```bash
git add src/lib/projectSource.ts src/lib/projectSource.test.ts src/lib/acp.ts src/components/ProjectPicker.tsx src-tauri/src/repo.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "fix: finish local PR selector verification"
```

If no fixes were needed, do not create an empty commit.

---

## Notes For Execution

- The current working tree already contains many project files that were not created by this plan. Before staging, run `git status --short` and stage only the files listed in each task.
- Do not remove remote session source variants from Rust or TypeScript unless a later task specifically needs it. The UI is the important behavior change.
- Keep user-facing messages short and plain.
