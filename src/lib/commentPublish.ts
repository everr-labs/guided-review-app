import type {
	PendingReview,
	PendingReviewComment,
	PrTarget,
	SessionSource,
} from "./acp";
import type { CommentDraft } from "./types/section";
import type { CommentDraftState } from "./store";
import { truncateTelemetryText } from "./telemetry";

type TelemetryValue = string | number | boolean;

export interface SendMessageTelemetryOptions {
	origin?: string;
	sectionId?: string;
	reason?: string;
	suppressPreview?: boolean;
}

type CommentDraftStatusPatch = {
	status:
		| "adding_to_review"
		| "pending_review"
		| "submitting"
		| "error";
	pending_review_id?: number;
	pending_review_node_id?: string;
	error?: string;
};

type CreatePendingReview = (args: {
	target: PrTarget;
	head_sha: string;
	body: string;
}) => Promise<PendingReview>;

type AddPendingReviewThread = (args: {
	target: PrTarget;
	review_node_id: string;
	body: string;
	file_path: string;
	line: number;
	side: "LEFT" | "RIGHT";
}) => Promise<PendingReviewComment>;

type UpdatePendingReviewBody = (args: {
	target: PrTarget;
	review_id: number;
	body: string;
}) => Promise<PendingReview>;

type SubmitPendingReview = (args: {
	target: PrTarget;
	review_id: number;
	body: string;
}) => Promise<PendingReview>;

function errorMessage(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : String(error);
	return message || fallback;
}

export function prTargetFromSessionSource(
	source: SessionSource | undefined,
): PrTarget | null {
	if (!source || (source.kind !== "pr" && source.kind !== "local_pr")) {
		return null;
	}
	const url = new URL(source.repo_url);
	const segs = url.pathname.split("/").filter(Boolean);
	if (segs.length < 2) return null;
	return {
		owner: segs[0],
		repo: segs[1].replace(/\.git$/, ""),
		number: source.number,
	};
}

export function formatPublishCommentError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const message = raw.replace(/^Error:\s*/, "").trim();
	const ghFailure = message.match(/^gh \[[\s\S]*?\] failed:\s*([\s\S]*)$/);
	if (ghFailure) {
		const stderr = ghFailure[1]?.trim();
		return stderr
			? `GitHub rejected the comment: ${stderr}`
			: "GitHub rejected the comment.";
	}

	return message || "Could not post the comment.";
}

export function buildPendingReviewBody(
	drafts: Pick<CommentDraftState, "draft" | "status" | "pending_review_id">[],
	reviewId?: number,
): string {
	return drafts
		.filter((state) => {
			if (state.draft.kind !== "top_level") return false;
			if (state.status !== "pending_review") return false;
			return reviewId === undefined || state.pending_review_id === reviewId;
		})
		.map((state) => state.draft.body.trim())
		.filter(Boolean)
		.join("\n\n");
}

function pendingReviewBodyWithDraft(args: {
	reviewId?: number;
	comment_drafts: CommentDraftState[];
	current: CommentDraftState;
}): string {
	return buildPendingReviewBody(
		[...args.comment_drafts, args.current],
		args.reviewId,
	);
}

export async function requestAddDraftToPendingReview(args: {
	draft_id: string;
	target: PrTarget;
	draft: CommentDraft;
	head_sha: string;
	pending_review: PendingReview | null;
	comment_drafts: CommentDraftState[];
	updateCommentDraft: (id: string, patch: CommentDraftStatusPatch) => void;
	setPendingReview: (review: PendingReview) => void;
	createPendingReview: CreatePendingReview;
	addPendingReviewThread: AddPendingReviewThread;
	updatePendingReviewBody: UpdatePendingReviewBody;
}): Promise<void> {
	args.updateCommentDraft(args.draft_id, {
		status: "adding_to_review",
		error: undefined,
	});

	let review = args.pending_review;
	const currentDraftState: CommentDraftState = {
		id: args.draft_id,
		draft: args.draft,
		status: "pending_review",
		pending_review_id: review?.review_id,
	};

	try {
		const body =
			args.draft.kind === "top_level"
				? pendingReviewBodyWithDraft({
						reviewId: review?.review_id,
						comment_drafts: args.comment_drafts,
						current: currentDraftState,
					})
				: buildPendingReviewBody(args.comment_drafts, review?.review_id);

		if (!review) {
			const created = await args.createPendingReview({
				target: args.target,
				head_sha: args.head_sha,
				body,
			});
			review = { ...created, body: created.body || body };
		} else if (args.draft.kind === "top_level" && body !== review.body) {
			const updated = await args.updatePendingReviewBody({
				target: args.target,
				review_id: review.review_id,
				body,
			});
			review = { ...updated, body: updated.body || body };
		}
		args.setPendingReview(review);

		if (args.draft.kind === "inline") {
			if (!args.draft.file_path || args.draft.line === undefined) {
				throw new Error("Inline comment drafts need a file path and line.");
			}
			await args.addPendingReviewThread({
				target: args.target,
				review_node_id: review.node_id,
				body: args.draft.body,
				file_path: args.draft.file_path,
				line: args.draft.line,
				side: args.draft.side ?? "RIGHT",
			});
		}

		args.updateCommentDraft(args.draft_id, {
			status: "pending_review",
			pending_review_id: review.review_id,
			pending_review_node_id: review.node_id,
			error: undefined,
		});
	} catch (error) {
		args.updateCommentDraft(args.draft_id, {
			status: "error",
			error: errorMessage(error, "Could not add the draft to pending review."),
		});
		throw error;
	}
}

export async function requestSubmitPendingReview(args: {
	target: PrTarget;
	pending_review: PendingReview;
	comment_drafts: CommentDraftState[];
	updateCommentDraft: (id: string, patch: CommentDraftStatusPatch) => void;
	markPendingReviewSubmitted: (reviewId: number) => void;
	submitPendingReview: SubmitPendingReview;
}): Promise<void> {
	const drafts = args.comment_drafts.filter(
		(draft) =>
			draft.status === "pending_review" &&
			draft.pending_review_id === args.pending_review.review_id,
	);
	for (const draft of drafts) {
		args.updateCommentDraft(draft.id, {
			status: "submitting",
			error: undefined,
		});
	}

	try {
		await args.submitPendingReview({
			target: args.target,
			review_id: args.pending_review.review_id,
			body: args.pending_review.body,
		});
		args.markPendingReviewSubmitted(args.pending_review.review_id);
	} catch (error) {
		for (const draft of drafts) {
			args.updateCommentDraft(draft.id, {
				status: "pending_review",
				error: errorMessage(error, "Could not submit the pending review."),
			});
		}
		throw error;
	}
}

export function sendMessageTelemetryAttrs(args: {
	session_id: string;
	text: string;
	options?: SendMessageTelemetryOptions;
}): Record<string, TelemetryValue | undefined> {
	const options = args.options ?? {};
	return {
		"acp.session_id": args.session_id,
		"message.origin": options.origin,
		"message.reason": options.reason,
		"section.id": options.sectionId,
		"message.length": args.text.length,
		"message.preview": options.suppressPreview
			? undefined
			: truncateTelemetryText(args.text.slice(0, 1024)),
		"message.preview_suppressed": options.suppressPreview ? true : undefined,
	};
}
