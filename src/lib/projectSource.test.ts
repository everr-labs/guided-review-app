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
	assert.deepEqual(
		parsePrInput("https://gitlab.com/openai/codex/-/merge_requests/123"),
		{
			error:
				"Enter a PR number or GitHub PR URL like 123 or https://github.com/owner/repo/pull/123.",
		},
	);
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
