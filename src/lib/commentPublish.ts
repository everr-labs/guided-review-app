import type { PrTarget } from "./acp";
import type { CommentDraft } from "./types/section";
import { truncateTelemetryText } from "./telemetry";

type TelemetryValue = string | number | boolean;

export interface SendMessageTelemetryOptions {
	origin?: string;
	sectionId?: string;
	reason?: string;
	suppressPreview?: boolean;
}

type CommentDraftStatusPatch = {
	status: "publishing" | "error";
	error?: string;
};

export function publishCommentTelemetryAttrs(args: {
	target: PrTarget;
	draft: CommentDraft;
	head_sha: string;
}): Record<string, TelemetryValue> {
	const attrs: Record<string, TelemetryValue> = {
		"github.owner": args.target.owner,
		"github.repo": args.target.repo,
		"github.pr_number": args.target.number,
		"comment.kind": args.draft.kind,
		"repo.head_sha.short": args.head_sha.slice(0, 12),
	};

	if (args.draft.file_path) {
		attrs["comment.file_path"] = args.draft.file_path;
	}
	if (args.draft.line !== undefined) {
		attrs["comment.line"] = args.draft.line;
	}
	if (args.draft.side) {
		attrs["comment.side"] = args.draft.side;
	}

	return attrs;
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

export function buildAgentPublishCommentPrompt(args: {
	draft_id: string;
	target: PrTarget;
	draft: CommentDraft;
	head_sha: string;
}): string {
	const target = `${args.target.owner}/${args.target.repo}#${args.target.number}`;
	const draftJson = JSON.stringify(args.draft, null, 2);
	return [
		"The user approved this PR comment draft in the app.",
		"",
		"Publish exactly this one comment to GitHub. Do not approve, merge, close, or otherwise change the PR.",
		"After the publish attempt, emit exactly one fenced `acp-comment-result` block.",
		"",
		`Draft id: ${args.draft_id}`,
		`PR target: ${target}`,
		`Head SHA: ${args.head_sha}`,
		"",
		"Comment draft JSON:",
		"```json",
		draftJson,
		"```",
		"",
		"Result block format:",
		"```acp-comment-result",
		JSON.stringify(
			{
				draft_id: args.draft_id,
				status: "published",
				url: "https://github.com/owner/repo/pull/123#discussion_r123",
			},
			null,
			2,
		),
		"```",
		"",
		'If publishing fails, use `"status": "failed"` and include a short `"error"` string instead of a URL.',
	].join("\n");
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

export async function requestAgentPublishComment(args: {
	session_id: string;
	draft_id: string;
	target: PrTarget;
	draft: CommentDraft;
	head_sha: string;
	updateCommentDraft: (id: string, patch: CommentDraftStatusPatch) => void;
	sendMessage: (
		session_id: string,
		text: string,
		options: SendMessageTelemetryOptions,
	) => Promise<void>;
}): Promise<void> {
	args.updateCommentDraft(args.draft_id, {
		status: "publishing",
		error: undefined,
	});

	const prompt = buildAgentPublishCommentPrompt({
		draft_id: args.draft_id,
		target: args.target,
		draft: args.draft,
		head_sha: args.head_sha,
	});

	try {
		await args.sendMessage(args.session_id, prompt, {
			origin: "comment_draft_approval",
			reason: "publish_approved_comment",
			suppressPreview: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		args.updateCommentDraft(args.draft_id, {
			status: "error",
			error: message || "Could not ask the agent to publish the comment.",
		});
	}
}
