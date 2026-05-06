import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { CommentDraftCard } from "./CommentDraftCard";
import { SeverityBadge } from "./SeverityBadge";
import { cn } from "@/lib/utils";
import {
	FileText,
	ListChecks,
	LoaderCircle,
	Map,
	Maximize2,
	X,
} from "lucide-react";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";
import {
	prTargetFromSessionSource,
	requestSubmitPendingReview,
} from "@/lib/commentPublish";
import {
	formatDiffReferenceForMessage,
	formatDiffReferenceLabel,
} from "@/lib/diffFocus";
import {
	assistantPartsToMarkdown,
	stripMarkdownForSummary,
} from "@/lib/markdownContent";
import { MarkdownViewer } from "./MarkdownViewer";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type {
	ChatItem,
	ChatMessage,
	ChatMessagePart,
	Concern,
	ToolCallItem,
} from "@/lib/types/section";

function FeedbackList({ title, concerns }: { title: string; concerns: Concern[] }) {
	if (concerns.length === 0) return null;
	return (
		<div className="space-y-1.5">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{title}
			</div>
			<ul className="space-y-1.5">
				{concerns.map((concern, index) => (
					<li key={index} className="flex items-start gap-2 text-xs">
						<SeverityBadge severity={concern.severity} />
						<div className="min-w-0 flex-1">
							<div>{concern.text}</div>
							{concern.file_path && (
								<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
									{concern.file_path}
									{concern.line ? `:${concern.line}` : ""}
								</div>
							)}
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}

function ChatItemView({ item }: { item: ChatItem }) {
	if (item.type === "section_map") {
		return (
			<div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
				<div className="mb-2 flex items-center gap-2 font-semibold">
					<Map className="size-4 text-muted-foreground" />
					<span>Section map</span>
					<span className="ml-auto text-xs font-normal text-muted-foreground">
						{item.sections.length} section
						{item.sections.length === 1 ? "" : "s"}
					</span>
				</div>
				<ul className="space-y-2">
					{item.sections.map((section) => (
						<li key={section.section_id} className="min-w-0">
							<div className="font-medium leading-tight">{section.title}</div>
							<div className="mt-0.5 text-xs text-muted-foreground">
								{stripMarkdownForSummary(section.intent)}
							</div>
						</li>
					))}
				</ul>
			</div>
		);
	}

	if (item.type === "review_section") {
		const { section } = item;
		const hasFeedback =
			section.concerns.length > 0 ||
			section.uncovered_scenarios.length > 0 ||
			!!section.test_coverage_notes;
		return (
			<div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
				<div className="mb-2 flex items-center gap-2 font-semibold">
					<ListChecks className="size-4 text-muted-foreground" />
					<span>{section.title}</span>
				</div>
				<div className="mb-2 text-xs text-muted-foreground">
					{stripMarkdownForSummary(section.intent)}
				</div>
				{section.files.length > 0 && (
					<div className="mb-3 space-y-1.5">
						<div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
							<FileText className="size-3" />
							<span>Files</span>
						</div>
						<div className="flex flex-wrap gap-1.5">
							{section.files.map((file) => (
								<span
									key={file}
									className="max-w-full truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]"
								>
									{file}
								</span>
							))}
						</div>
					</div>
				)}
				{hasFeedback ? (
					<div className="space-y-3">
						{section.test_coverage_notes && (
							<div className="text-xs">
								<div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Test coverage
								</div>
								{section.test_coverage_notes}
							</div>
						)}
						<FeedbackList title="Concerns" concerns={section.concerns} />
						<FeedbackList
							title="Uncovered scenarios"
							concerns={section.uncovered_scenarios}
						/>
					</div>
				) : (
					<div className="text-xs text-muted-foreground">
						No feedback called out for this section.
					</div>
				)}
			</div>
		);
	}

	return null;
}

function partsFromMessage(message: ChatMessage): ChatMessagePart[] {
	if (message.parts) return message.parts;
	return message.text ? [{ type: "markdown", text: message.text }] : [];
}

interface FullPageResponse {
	markdown: string;
	toolCalls: ToolCallItem[];
}

function AssistantResponseView({
	message,
	onOpenFullPage,
}: {
	message: ChatMessage;
	onOpenFullPage: (response: FullPageResponse) => void;
}) {
	const response = assistantPartsToMarkdown(partsFromMessage(message));
	const canOpenFullPage = response.markdown.trim().length > 0;

	return (
		<div className="relative rounded-md border border-border bg-card px-3 py-2 text-foreground">
			{canOpenFullPage && (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="absolute right-1.5 top-1.5 h-7 w-7 text-muted-foreground hover:text-foreground"
					onClick={() => onOpenFullPage(response)}
					title="Open response"
					aria-label="Open response"
				>
					<Maximize2 className="size-3.5" />
				</Button>
			)}
			<MarkdownViewer
				markdown={response.markdown}
				toolCalls={response.toolCalls}
				className={canOpenFullPage ? "pr-7" : undefined}
			/>
			{message.streaming && (
				<span className="ml-0.5 animate-pulse text-sm">▋</span>
			)}
		</div>
	);
}

export function ChatPanel() {
	const session = useApp((s) => s.session);
	const chat = useApp((s) => s.chat);
	const drafts = useApp((s) => s.commentDrafts);
	const pendingReview = useApp((s) => s.pendingReview);
	const streaming = useApp((s) => s.streaming);
	const sections = useApp((s) => s.sections);
	const processingSectionId = useApp((s) => s.processingSectionId);
	const addUserMessage = useApp((s) => s.addUserMessage);
	const pushError = useApp((s) => s.pushError);
	const pendingDiffReferences = useApp((s) => s.pendingDiffReferences);
	const removePendingDiffReference = useApp(
		(s) => s.removePendingDiffReference,
	);
	const clearPendingDiffReferences = useApp(
		(s) => s.clearPendingDiffReferences,
	);
	const updateCommentDraft = useApp((s) => s.updateCommentDraft);
	const markPendingReviewSubmitted = useApp(
		(s) => s.markPendingReviewSubmitted,
	);

	const [input, setInput] = useState("");
	const [submittingReview, setSubmittingReview] = useState(false);
	const [fullPageResponse, setFullPageResponse] =
		useState<FullPageResponse | null>(null);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const processingSection = processingSectionId
		? sections.find((s) => s.id === processingSectionId)
		: null;

	useEffect(() => {
		queueMicrotask(() => {
			if (scrollerRef.current) {
				scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
		}
	});
	}, [chat, drafts, streaming, pendingDiffReferences]);

	async function send() {
		if (!session) return;
		const text = input.trim();
		if (!text && pendingDiffReferences.length === 0) return;
		const refs = pendingDiffReferences
			.map((r) => formatDiffReferenceForMessage(r))
			.join("\n");
		const body = refs ? (text ? `${refs}\n\n${text}` : refs) : text;
		recordClientTelemetry("client.chat.send.requested", {
			"acp.session_id": session.session_id,
			"message.length": body.length,
			"context.count": pendingDiffReferences.length,
		});
		setInput("");
		addUserMessage(body);
		clearPendingDiffReferences();
		try {
			await acp.sendMessage(session.session_id, body, {
				origin: "chat_panel_user_send",
				reason: "user_reply",
			});
			recordClientTelemetry("client.chat.send.succeeded", {
				"acp.session_id": session.session_id,
				"message.length": body.length,
			});
		} catch (e) {
			recordClientTelemetryError("client.chat.send.failed", e, {
				"acp.session_id": session.session_id,
				"message.length": body.length,
			});
			pushError(`send_message failed: ${e}`);
		}
	}

	async function submitPendingReview() {
		if (!session || !pendingReview || submittingReview) return;
		const target = prTargetFromSessionSource(session.source);
		if (!target) {
			pushError("PR target unknown.");
			return;
		}
		setSubmittingReview(true);
		try {
			await requestSubmitPendingReview({
				target,
				pending_review: pendingReview,
				comment_drafts: drafts,
				updateCommentDraft,
				markPendingReviewSubmitted,
				submitPendingReview: acp.submitPendingReview,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			pushError(message || "Could not submit the pending review.");
		} finally {
			setSubmittingReview(false);
		}
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		// Enter sends; Cmd/Ctrl+Enter inserts a newline.
		if (e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			send();
			return;
		}
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			const ta = e.currentTarget;
			const start = ta.selectionStart ?? input.length;
			const end = ta.selectionEnd ?? start;
			const next = input.slice(0, start) + "\n" + input.slice(end);
			setInput(next);
			requestAnimationFrame(() => {
				if (textareaRef.current) {
					textareaRef.current.selectionStart = start + 1;
					textareaRef.current.selectionEnd = start + 1;
				}
			});
		}
	}

	return (
		<aside className="flex min-h-0 min-w-0 flex-col border-l border-border bg-card/30">
			<Dialog
				open={!!fullPageResponse}
				onOpenChange={(open) => {
					if (!open) setFullPageResponse(null);
				}}
			>
				<DialogContent className="grid h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none grid-rows-[auto_1fr] gap-0 p-0">
					<DialogHeader className="border-b border-border px-6 py-4">
						<DialogTitle>Assistant response</DialogTitle>
						<DialogDescription className="sr-only">
							Full page view of the selected assistant response.
						</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 overflow-y-auto px-6 py-5">
						{fullPageResponse && (
							<MarkdownViewer
								markdown={fullPageResponse.markdown}
								toolCalls={fullPageResponse.toolCalls}
								className="mx-auto max-w-4xl text-base"
							/>
						)}
					</div>
				</DialogContent>
			</Dialog>
			<div className="border-b border-border px-4 py-3 text-sm font-semibold text-muted-foreground">
				Chat
			</div>
			<div
				ref={scrollerRef}
				className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
			>
				{chat.map((m) => {
					if (!m.item && !m.text && !m.streaming && !m.parts?.length) {
						return null;
					}
					return (
						<div key={m.id} className="space-y-1">
							<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
								{m.role}
							</div>
							{m.item ? (
								<ChatItemView item={m.item} />
							) : m.role === "assistant" ? (
								<AssistantResponseView
									message={m}
									onOpenFullPage={setFullPageResponse}
								/>
							) : (
								<div
									className={cn(
										"whitespace-pre-wrap break-words rounded-md px-3 py-2 text-sm leading-relaxed",
										"bg-primary/15 text-foreground",
									)}
								>
									{m.text}
									{m.streaming && (
										<span className="ml-0.5 animate-pulse">▋</span>
									)}
								</div>
							)}
						</div>
					);
				})}
				{streaming &&
					(chat.length === 0 || chat[chat.length - 1].role === "user") && (
						<div className="flex items-center gap-1.5 self-start rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
							<span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
							<span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
							<span className="block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
							<span className="ml-1">agent thinking…</span>
						</div>
					)}
				{drafts.length > 0 && (
					<div className="flex flex-col gap-2 pt-2">
						{drafts.map((d) => (
							<CommentDraftCard key={d.id} state={d} />
						))}
						{pendingReview &&
							drafts.some(
								(d) =>
									d.status === "pending_review" &&
									d.pending_review_id === pendingReview.review_id,
							) && (
								<Button
									size="sm"
									onClick={submitPendingReview}
									disabled={submittingReview}
								>
									{submittingReview ? (
										<LoaderCircle className="size-3.5 animate-spin" />
									) : null}
									Submit review comments
								</Button>
							)}
					</div>
				)}
			</div>
			<div className="space-y-2 border-t border-border bg-background/40 p-3">
				{processingSectionId && (
					<div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary">
						<LoaderCircle className="size-3.5 animate-spin" />
						<span>
							Agent is processing{" "}
							{processingSection ? `“${processingSection.title}”` : "this section"}
							…
						</span>
					</div>
				)}
				{pendingDiffReferences.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{pendingDiffReferences.map((c) => (
							<span
								key={c.id}
								className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px]"
							>
								{formatDiffReferenceLabel(c)}
								<button
									type="button"
									className="text-muted-foreground hover:text-foreground"
									onClick={() => removePendingDiffReference(c.id)}
									aria-label="Remove reference"
								>
									<X className="size-3" />
								</button>
							</span>
						))}
					</div>
				)}
				<Textarea
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={
						session
							? "Reply to the agent…  (Enter to send · ⌘+Enter for newline)"
							: "Start a session first"
					}
					disabled={!session}
					rows={3}
				/>
				<div className="flex items-center justify-end gap-2">
					<Button
						size="sm"
						onClick={send}
						disabled={
							!session ||
							(!input.trim() && pendingDiffReferences.length === 0)
						}
					>
						Send
					</Button>
				</div>
			</div>
		</aside>
	);
}
