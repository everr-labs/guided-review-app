import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPendingReviewBody,
	formatPublishCommentError,
	requestAddDraftToPendingReview,
	requestSubmitPendingReview,
	sendMessageTelemetryAttrs,
} from "./commentPublish";

test("formatPublishCommentError shows the useful GitHub rejection", () => {
	const message =
		'gh ["api", "--method", "POST"] failed: gh: Validation Failed (HTTP 422)\nline must be part of the diff';

	assert.equal(
		formatPublishCommentError(message),
		"GitHub rejected the comment: gh: Validation Failed (HTTP 422)\nline must be part of the diff",
	);
});

test("sendMessageTelemetryAttrs suppresses private message preview", () => {
	const attrs = sendMessageTelemetryAttrs({
		session_id: "session-1",
		text: "private pending comment body",
		options: {
			origin: "review_launcher_kickoff",
			reason: "request_section_map",
			suppressPreview: true,
		},
	});

	assert.equal(attrs["message.length"], 28);
	assert.equal(attrs["message.preview"], undefined);
	assert.equal(Object.values(attrs).includes("private pending comment body"), false);
});

test("buildPendingReviewBody combines top-level drafts already in the pending review", () => {
	const body = buildPendingReviewBody([
		{
			status: "pending_review",
			pending_review_id: 44,
			draft: { kind: "top_level", body: "First summary note." },
		},
		{
			status: "pending",
			draft: { kind: "inline", body: "Inline note.", file_path: "a.ts", line: 1 },
		},
	]);

	assert.equal(body, "First summary note.");
});

test("requestAddDraftToPendingReview creates a pending review and adds an inline thread", async () => {
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	const pendingReviews: unknown[] = [];
	const threads: unknown[] = [];

	await requestAddDraftToPendingReview({
		draft_id: "draft-123",
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		draft: {
			kind: "inline",
			body: "Please short-circuit this lookup.",
			file_path: "src/main.ts",
			line: 12,
			side: "RIGHT",
		},
		head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
		pending_review: null,
		comment_drafts: [],
		updateCommentDraft: (id, patch) => updates.push({ id, patch }),
		setPendingReview: (review) => pendingReviews.push(review),
		createPendingReview: async (args) => {
			pendingReviews.push(args);
			return { review_id: 44, node_id: "PRR_node", body: "" };
		},
		addPendingReviewThread: async (args) => {
			threads.push(args);
			return { comment_id: "PRRC_node" };
		},
		updatePendingReviewBody: async () => {
			throw new Error("body should not be updated for inline-only draft");
		},
	});

	assert.deepEqual(updates, [
		{ id: "draft-123", patch: { status: "adding_to_review", error: undefined } },
		{
			id: "draft-123",
			patch: {
				status: "pending_review",
				pending_review_id: 44,
				pending_review_node_id: "PRR_node",
				error: undefined,
			},
		},
	]);
	assert.deepEqual(pendingReviews[0], {
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
		body: "",
	});
	assert.deepEqual(pendingReviews[1], {
		review_id: 44,
		node_id: "PRR_node",
		body: "",
	});
	assert.deepEqual(threads, [
		{
			target: { owner: "garden-co", repo: "jazz", number: 787 },
			review_node_id: "PRR_node",
			body: "Please short-circuit this lookup.",
			file_path: "src/main.ts",
			line: 12,
			side: "RIGHT",
		},
	]);
});

test("requestAddDraftToPendingReview stores top-level drafts in the review body", async () => {
	const updatedBodies: string[] = [];
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

	await requestAddDraftToPendingReview({
		draft_id: "draft-2",
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		draft: { kind: "top_level", body: "Second summary note." },
		head_sha: "57d6bce6ed8e3750f829ff9e9a48b76615df11d6",
		pending_review: { review_id: 44, node_id: "PRR_node", body: "First summary note." },
		comment_drafts: [
			{
				id: "draft-1",
				status: "pending_review",
				pending_review_id: 44,
				draft: { kind: "top_level", body: "First summary note." },
			},
		],
		updateCommentDraft: (id, patch) => updates.push({ id, patch }),
		setPendingReview: () => {},
		createPendingReview: async () => {
			throw new Error("pending review already exists");
		},
		addPendingReviewThread: async () => {
			throw new Error("top-level drafts should not add inline threads");
		},
		updatePendingReviewBody: async (args) => {
			updatedBodies.push(args.body);
			return { review_id: 44, node_id: "PRR_node", body: args.body };
		},
	});

	assert.deepEqual(updatedBodies, [
		"First summary note.\n\nSecond summary note.",
	]);
	assert.deepEqual(updates.at(-1), {
		id: "draft-2",
		patch: {
			status: "pending_review",
			pending_review_id: 44,
			pending_review_node_id: "PRR_node",
			error: undefined,
		},
	});
});

test("requestSubmitPendingReview marks pending drafts submitted after review submit", async () => {
	const submitted: unknown[] = [];
	const submittedReviewIds: number[] = [];
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

	await requestSubmitPendingReview({
		target: { owner: "garden-co", repo: "jazz", number: 787 },
		pending_review: { review_id: 44, node_id: "PRR_node", body: "Summary." },
		comment_drafts: [
			{
				id: "draft-1",
				status: "pending_review",
				pending_review_id: 44,
				draft: { kind: "top_level", body: "Summary." },
			},
			{
				id: "draft-2",
				status: "pending",
				draft: { kind: "top_level", body: "Not added yet." },
			},
		],
		updateCommentDraft: (id, patch) => updates.push({ id, patch }),
		markPendingReviewSubmitted: (review_id) => submittedReviewIds.push(review_id),
		submitPendingReview: async (args) => {
			submitted.push(args);
			return { review_id: 44, node_id: "PRR_node", body: "Summary." };
		},
	});

	assert.deepEqual(updates, [
		{ id: "draft-1", patch: { status: "submitting", error: undefined } },
	]);
	assert.deepEqual(submitted, [
		{
			target: { owner: "garden-co", repo: "jazz", number: 787 },
			review_id: 44,
			body: "Summary.",
		},
	]);
	assert.deepEqual(submittedReviewIds, [44]);
});
