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

export interface LocalProject {
	path: string;
	origin: LocalRepoOrigin;
}

type Result<T> = { value: T } | { error: string };
type SourceResult = { source: SessionSource } | { error: string };

export const LAST_PROJECT_PATH_KEY = "gr.lastProjectPath";

export function loadLastProjectPath(storage: Storage = localStorage): string | null {
	try {
		const path = storage.getItem(LAST_PROJECT_PATH_KEY)?.trim() ?? "";
		return path ? path : null;
	} catch {
		return null;
	}
}

export function saveLastProjectPath(
	path: string,
	storage: Storage = localStorage,
): void {
	const trimmed = path.trim();
	if (!trimmed) return;
	try {
		storage.setItem(LAST_PROJECT_PATH_KEY, trimmed);
	} catch {}
}

export function clearLastProjectPath(storage: Storage = localStorage): void {
	try {
		storage.removeItem(LAST_PROJECT_PATH_KEY);
	} catch {}
}

function normalizeSlug(owner: string, repo: string): string {
	return `${owner}/${repo}`.toLowerCase();
}

function parsePositivePrNumber(value: string): number | null {
	if (!/^[0-9]+$/.test(value)) return null;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseGithubPrUrl(input: string): Result<ParsedPrInput> | null {
	const trimmed = input.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
		return null;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 4 || segments[2] !== "pull") {
		return {
			error:
				"GitHub URL must point to a PR like https://github.com/owner/repo/pull/123.",
		};
	}
	const number = parsePositivePrNumber(segments[3]);
	if (number === null) {
		return { error: "PR number in URL must be greater than 0." };
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

	const urlResult = parseGithubPrUrl(trimmed);
	if (urlResult) return urlResult;

	return {
		error:
			"Enter a PR number or GitHub PR URL like 123 or https://github.com/owner/repo/pull/123.",
	};
}

export function localReviewSourceFromInput({
	input,
	project,
}: {
	input: string;
	project: LocalProject | null;
}): SourceResult {
	const trimmed = input.trim();
	if (!trimmed) {
		return {
			error: "Enter a PR number, PR URL, branch name, or commit SHA.",
		};
	}
	if (!project) {
		return { error: "Choose a project first." };
	}

	if (/^[0-9]+$/.test(trimmed)) {
		const number = parsePositivePrNumber(trimmed);
		if (number === null) {
			return { error: "Enter a PR number greater than 0." };
		}
		return {
			source: {
				kind: "local_pr",
				path: project.path,
				repo_url: project.origin.repo_url,
				number,
			},
		};
	}

	const urlResult = parseGithubPrUrl(trimmed);
	if (urlResult) {
		if ("error" in urlResult) return urlResult;
		const pr = urlResult.value;
		if (pr.repoSlug && pr.repoSlug !== project.origin.slug.toLowerCase()) {
			return {
				error: `This PR URL is for ${pr.repoSlug}, but the project's origin is ${project.origin.slug}.`,
			};
		}
		return {
			source: {
				kind: "local_pr",
				path: project.path,
				repo_url: project.origin.repo_url,
				number: pr.number,
			},
		};
	}

	return {
		source: {
			kind: "local_branch",
			path: project.path,
			branch: trimmed,
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
