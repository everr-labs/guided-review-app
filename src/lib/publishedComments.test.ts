import assert from "node:assert/strict";
import test from "node:test";
import {
	formatPublishedCommentsForPrompt,
	publishedCommentToDiffAnnotation,
} from "./publishedComments";
import type { PublishedPrComment } from "./acp";

const currentComment: PublishedPrComment = {
	id: 101,
	author_login: "mona",
	body: "This has already been reviewed.",
	html_url: "https://github.com/garden-co/jazz/pull/787#discussion_r101",
	created_at: "2026-05-05T10:00:00Z",
	file_path: "src/main.ts",
	line: 12,
	side: "RIGHT",
	is_outdated: false,
};

test("formatPublishedCommentsForPrompt includes existing PR review comments", () => {
	const text = formatPublishedCommentsForPrompt([currentComment], undefined);

	assert.match(text, /Existing published PR review comments/);
	assert.match(text, /mona/);
	assert.match(text, /src\/main\.ts:12 \(RIGHT\)/);
	assert.match(text, /This has already been reviewed\./);
	assert.match(text, /discussion_r101/);
});

test("formatPublishedCommentsForPrompt explains download failures", () => {
	const text = formatPublishedCommentsForPrompt([], "gh auth failed");

	assert.match(text, /could not be downloaded/);
	assert.match(text, /gh auth failed/);
});

test("publishedCommentToDiffAnnotation maps current right-side comments", () => {
	assert.deepEqual(publishedCommentToDiffAnnotation(currentComment), {
		lineNumber: 12,
		side: "additions",
		metadata: { comment: currentComment },
	});
});

test("publishedCommentToDiffAnnotation falls back to original outdated lines", () => {
	const outdated: PublishedPrComment = {
		...currentComment,
		id: 102,
		line: undefined,
		side: undefined,
		original_line: 8,
		original_side: "LEFT",
		is_outdated: true,
	};

	assert.deepEqual(publishedCommentToDiffAnnotation(outdated), {
		lineNumber: 8,
		side: "deletions",
		metadata: { comment: outdated },
	});
});

test("publishedCommentToDiffAnnotation skips comments without a file line", () => {
	const unplaced: PublishedPrComment = {
		...currentComment,
		file_path: undefined,
		line: undefined,
		original_line: undefined,
	};

	assert.equal(publishedCommentToDiffAnnotation(unplaced), null);
});
