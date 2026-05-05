import { useApp, type CommentDraftState } from "@/lib/store";
import { acp, type PrTarget } from "@/lib/acp";
import { requestAgentPublishComment } from "@/lib/commentPublish";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useMemo } from "react";

export function CommentDraftCard({ state }: { state: CommentDraftState }) {
	const session = useApp((s) => s.session);
	const updateCommentDraft = useApp((s) => s.updateCommentDraft);

	const target = useMemo<PrTarget | null>(() => {
		if (
			!session ||
			(session.source.kind !== "pr" && session.source.kind !== "local_pr")
		) {
			return null;
		}
		const url = new URL(session.source.repo_url);
		const segs = url.pathname.split("/").filter(Boolean);
		if (segs.length < 2) return null;
		return {
			owner: segs[0],
			repo: segs[1].replace(/\.git$/, ""),
			number: session.source.number,
		};
	}, [session]);

	async function approve() {
		if (!target || !session) return;
		await requestAgentPublishComment({
			session_id: session.session_id,
			draft_id: state.id,
			target,
			draft: state.draft,
			head_sha: session.repo.head_sha,
			updateCommentDraft,
			sendMessage: acp.sendMessage,
		});
	}

	return (
		<Card className="bg-primary/5 border-primary/30 px-3 py-2.5">
			<div className="mb-1 flex justify-between text-[10px] uppercase tracking-wider text-primary">
				<span>
					{state.draft.kind === "inline" ? "Inline" : "Top-level"} comment draft
				</span>
				<span className="text-muted-foreground">{state.status}</span>
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
						{target ? "Approve & post" : "PR target unknown"}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() =>
							updateCommentDraft(state.id, { status: "rejected" })
						}
					>
						Discard
					</Button>
				</div>
			)}
		</Card>
	);
}
