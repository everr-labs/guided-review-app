import assert from "node:assert/strict";
import test from "node:test";
import {
	localRecentProjects,
	localReviewSourceFromInput,
	parsePrInput,
	type LocalProject,
	type LocalRepoOrigin,
} from "./projectSource";
import type { RecentProject } from "./acp";

const origin: LocalRepoOrigin = {
	repo_url: "https://github.com/openai/codex",
	owner: "openai",
	repo: "codex",
	slug: "openai/codex",
};

const project: LocalProject = {
	path: "/Users/guidodorsi/dev/codex",
	origin,
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

test("localReviewSourceFromInput accepts a PR number", () => {
	assert.deepEqual(
		localReviewSourceFromInput({ input: " 123 ", project }),
		{
			source: {
				kind: "local_pr",
				path: project.path,
				repo_url: origin.repo_url,
				number: 123,
			},
		},
	);
});

test("localReviewSourceFromInput accepts a matching GitHub PR URL", () => {
	assert.deepEqual(
		localReviewSourceFromInput({
			input: "https://github.com/openai/codex/pull/42",
			project,
		}),
		{
			source: {
				kind: "local_pr",
				path: project.path,
				repo_url: origin.repo_url,
				number: 42,
			},
		},
	);
});

test("localReviewSourceFromInput rejects mismatched PR URLs", () => {
	assert.deepEqual(
		localReviewSourceFromInput({
			input: "https://github.com/other/project/pull/1",
			project,
		}),
		{
			error:
				"This PR URL is for other/project, but the project's origin is openai/codex.",
		},
	);
});

test("localReviewSourceFromInput treats anything else as a branch or SHA", () => {
	assert.deepEqual(
		localReviewSourceFromInput({ input: "feature/foo", project }),
		{
			source: {
				kind: "local_branch",
				path: project.path,
				branch: "feature/foo",
			},
		},
	);
	assert.deepEqual(
		localReviewSourceFromInput({ input: "abc1234", project }),
		{
			source: {
				kind: "local_branch",
				path: project.path,
				branch: "abc1234",
			},
		},
	);
});

test("localReviewSourceFromInput requires a project and non-empty input", () => {
	assert.deepEqual(
		localReviewSourceFromInput({ input: "123", project: null }),
		{ error: "Choose a project first." },
	);
	assert.deepEqual(
		localReviewSourceFromInput({ input: "  ", project }),
		{ error: "Enter a PR number, PR URL, branch name, or commit SHA." },
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
