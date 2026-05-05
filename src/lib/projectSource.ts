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
