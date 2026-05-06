import { useApp, type CommentDraftState } from "@/lib/store";
import { acp } from "@/lib/acp";
import {
	prTargetFromSessionSource,
	requestAddDraftToPendingReview,
} from "@/lib/commentPublish";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useMemo } from "react";
import { X } from "lucide-react";

export function CommentDraftCard({ state }: { state: CommentDraftState }) {
	const session = useApp((s) => s.session);
	const updateCommentDraft = useApp((s) => s.updateCommentDraft);
	const dismissCommentDraft = useApp((s) => s.dismissCommentDraft);
	const pendingReview = useApp((s) => s.pendingReview);
	const setPendingReview = useApp((s) => s.setPendingReview);
	const commentDrafts = useApp((s) => s.commentDrafts);
	const pushError = useApp((s) => s.pushError);

	const target = useMemo(
		() => prTargetFromSessionSource(session?.source),
		[session],
	);

	async function approve() {
		if (!target || !session) return;
		try {
			await requestAddDraftToPendingReview({
				draft_id: state.id,
				target,
				draft: state.draft,
				head_sha: session.repo.head_sha,
				pending_review: pendingReview,
				comment_drafts: commentDrafts,
				updateCommentDraft,
				setPendingReview,
				createPendingReview: acp.createPendingReview,
				addPendingReviewThread: acp.addPendingReviewThread,
				updatePendingReviewBody: acp.updatePendingReviewBody,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			pushError(
				message || "Could not add the draft to the pending review.",
			);
		}
	}

	return (
		<Card className="bg-primary/5 border-primary/30 px-3 py-2.5">
			<div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-primary">
				<span>
					{state.draft.kind === "inline" ? "Inline" : "Top-level"} comment draft
				</span>
				<div className="flex items-center gap-1.5">
					<span className="text-muted-foreground">{state.status}</span>
					{state.status !== "pending_review" &&
						state.status !== "submitting" && (
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="size-6 text-muted-foreground hover:text-foreground"
								onClick={() => dismissCommentDraft(state.id)}
								aria-label="Dismiss comment draft"
							>
								<X className="size-3.5" />
							</Button>
						)}
				</div>
			</div>
			{state.draft.kind === "inline" && (
				<div className="mb-1.5 font-mono text-[11px] text-muted-foreground">
					{state.draft.file_path}:{state.draft.line}
					{state.draft.side ? ` (${state.draft.side})` : ""}
				</div>
			)}
			<div className="whitespace-pre-wrap text-sm">{state.draft.body}</div>
			{state.url && (
				<a
					className="mt-1.5 inline-block text-xs text-[oklch(0.7_0.16_155)]"
					href={state.url}
					target="_blank"
					rel="noreferrer"
				>
					View on GitHub
				</a>
			)}
			{state.error && (
				<div className="mt-1.5 text-xs text-destructive">{state.error}</div>
			)}
			{state.status === "pending" && (
				<div className="mt-2 flex gap-2">
					<Button
						size="sm"
						onClick={approve}
						disabled={!target}
					>
						{target ? "Add to pending review" : "PR target unknown"}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => dismissCommentDraft(state.id)}
					>
						Discard
					</Button>
				</div>
			)}
			{state.status === "pending_review" && (
				<div className="mt-2 text-xs text-muted-foreground">
					Saved in GitHub as a pending review comment.
				</div>
			)}
		</Card>
	);
}
