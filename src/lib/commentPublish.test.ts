import assert from "node:assert/strict";
import test from "node:test";
import {
	buildAgentPublishCommentPrompt,
	formatPublishCommentError,
	publishCommentTelemetryAttrs,
	requestAgentPublishComment,
	sendMessageTelemetryAttrs,
} from "./commentPublish";
import type { SendMessageTelemetryOptions } from "./commentPublish";

test("formatPublishCommentError shows the useful GitHub rejection", () => {
	const message =
		'gh ["api", "--method", "POST"] failed: gh: Validation Failed (HTTP 422)\nline must be part of the diff';

	assert.equal(
		formatPublishCommentError(message),
		"GitHub rejected the comment: gh: Validation Failed (HTTP 422)\nline must be part of the diff",
	);
});

test("publishCommentTelemetryAttrs includes target and SHA details without the body", () => {
	const attrs = publishCommentTelemetryAttrs({
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		draft: {
			kind: "inline",
			body: "do not log this",
			file_path: "crates/jazz-tools/src/sync_manager/forwarding.rs",
			line: 60,
			side: "RIGHT",
		},
		head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
	});

	assert.deepEqual(attrs, {
		"comment.file_path": "crates/jazz-tools/src/sync_manager/forwarding.rs",
		"comment.kind": "inline",
		"comment.line": 60,
		"comment.side": "RIGHT",
		"github.owner": "garden-co",
		"github.pr_number": 787,
		"github.repo": "jazz",
		"repo.head_sha.short": "57d6bce6ed8e",
	});
	assert.equal(Object.values(attrs).includes("do not log this"), false);
});

test("buildAgentPublishCommentPrompt includes exact approved draft instructions", () => {
	const prompt = buildAgentPublishCommentPrompt({
		draft_id: "draft-123",
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		draft: {
			kind: "inline",
			body: "Please short-circuit this lookup.",
			file_path: "crates/jazz-tools/src/sync_manager/forwarding.rs",
			line: 60,
			side: "RIGHT",
		},
		head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
	});

	assert.match(prompt, /draft-123/);
	assert.match(prompt, /garden-co\/jazz#787/);
	assert.match(prompt, /57d6bce6ed8e3750f829ff9e9a48b76615df11d6/);
	assert.match(prompt, /Please short-circuit this lookup\./);
	assert.match(prompt, /acp-comment-result/);
	assert.match(prompt, /Do not approve, merge, close, or otherwise change the PR/);
});

test("sendMessageTelemetryAttrs suppresses private message preview", () => {
	const attrs = sendMessageTelemetryAttrs({
		session_id: "session-1",
		text: "private approved comment body",
		options: {
			origin: "comment_draft_approval",
			reason: "publish_approved_comment",
			suppressPreview: true,
		},
	});

	assert.equal(attrs["message.length"], 29);
	assert.equal(attrs["message.preview"], undefined);
	assert.equal(Object.values(attrs).includes("private approved comment body"), false);
});

test("requestAgentPublishComment marks draft publishing and sends hidden prompt", async () => {
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	const sent: Array<{
		session_id: string;
		text: string;
		options: SendMessageTelemetryOptions;
	}> = [];

	await requestAgentPublishComment({
		session_id: "session-1",
		draft_id: "draft-123",
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		draft: {
			kind: "inline",
			body: "Please short-circuit this lookup.",
			file_path: "crates/jazz-tools/src/sync_manager/forwarding.rs",
			line: 60,
			side: "RIGHT",
		},
		head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
		updateCommentDraft: (id, patch) => updates.push({ id, patch }),
		sendMessage: async (session_id, text, options) => {
			sent.push({ session_id, text, options });
		},
	});

	assert.deepEqual(updates[0], {
		id: "draft-123",
		patch: { status: "publishing", error: undefined },
	});
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.session_id, "session-1");
	assert.equal(sent[0]?.options.suppressPreview, true);
	assert.equal(sent[0]?.options.origin, "comment_draft_approval");
	assert.match(sent[0]?.text ?? "", /Please short-circuit this lookup\./);
	assert.match(sent[0]?.text ?? "", /acp-comment-result/);
});
