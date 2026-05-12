import { useEffect, useState } from "react";
import { useApp, type SessionInfo } from "@/lib/store";
import {
	on,
	acp,
	type SectionMapEvent,
	type SectionEvent,
	type SectionProgressEvent,
	type TextChunkEvent,
	type TurnDoneEvent,
	type ErrorEvent,
	type CommentDraftEvent,
	type CommentResultEvent,
	type AgentStderrEvent,
	type ToolCallEvent,
	type ToolCallUpdateEvent,
	type Unlisten,
	type GhCliStatus,
} from "@/lib/acp";
import type {
	ReviewSection,
	SectionMap,
	SectionMapEntry,
	SectionProgressUpdate,
} from "@/lib/types/section";
import {
	parseReviewSectionPayload,
	parseSectionMapPayload,
	parseSectionProgressPayload,
} from "@/lib/reviewSectionPayload";
import { ProjectPicker } from "@/components/ProjectPicker";
import { ReviewLauncher } from "@/components/ReviewLauncher";
import { SectionList } from "@/components/SectionList";
import { DiffPane } from "@/components/DiffView";
import { ChatPanel } from "@/components/ChatPanel";
import { Button } from "@/components/ui/button";
import { AlertTriangle, PanelLeft, PanelRight } from "lucide-react";
import {
	recordClientTelemetry,
	recordClientTelemetryError,
	truncateTelemetryText,
} from "@/lib/telemetry";
import { formatPublishedCommentsForPrompt } from "@/lib/publishedComments";
import {
	createReviewSnapshot,
	saveReviewRequestFromSession,
} from "@/lib/reviewPersistence";
import { ghCliNeedsInstallPopup, ghCliPopupMessage } from "@/lib/ghCli";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

function parseToolSectionMap(raw: unknown): SectionMap | null {
	return parseSectionMapPayload(raw);
}

function parseToolReviewSection(raw: unknown): ReviewSection | null {
	return parseReviewSectionPayload(raw);
}

function parseToolSectionProgress(raw: unknown): SectionProgressUpdate | null {
	return parseSectionProgressPayload(raw);
}

async function enrichSectionMapWithLocalRanges(
	session: SessionInfo,
	sections: SectionMapEntry[],
): Promise<SectionMapEntry[]> {
	return Promise.all(
		sections.map(async (section) => {
			const files = section.files ?? [];
			if (files.length === 0) return section;
			try {
				recordClientTelemetry("client.acp.section_map.ranges.started", {
					"acp.session_id": session.session_id,
					"section.id": section.section_id,
					"section.file_count": files.length,
				});
				const ranges = await acp.getChangedRanges({
					repo_path: session.repo.path,
					base_ref: session.repo.base_ref,
					head_ref: session.repo.head_ref,
					file_paths: files,
				});
				recordClientTelemetry("client.acp.section_map.ranges.succeeded", {
					"acp.session_id": session.session_id,
					"section.id": section.section_id,
					"section.local_changed_range_count": ranges.length,
				});
				return { ...section, ranges };
			} catch (e) {
				recordClientTelemetryError("client.acp.section_map.ranges.failed", e, {
					"acp.session_id": session.session_id,
					"section.id": section.section_id,
				});
				return section;
			}
		}),
	);
}

export default function App() {
	const session = useApp((s) => s.session);
	const sections = useApp((s) => s.sections);
	const currentSectionId = useApp((s) => s.currentSectionId);
	const chat = useApp((s) => s.chat);
	const commentDrafts = useApp((s) => s.commentDrafts);
	const publishedComments = useApp((s) => s.publishedComments);
	const publishedCommentsError = useApp((s) => s.publishedCommentsError);
	const errors = useApp((s) => s.errors);
	const dismissErrors = useApp((s) => s.dismissErrors);
	const setSectionMap = useApp((s) => s.setSectionMap);
	const upsertSection = useApp((s) => s.upsertSection);
	const upsertSectionProgress = useApp((s) => s.upsertSectionProgress);
	const setCurrentSection = useApp((s) => s.setCurrentSection);
	const startSectionProcessing = useApp((s) => s.startSectionProcessing);
	const finishSectionProcessing = useApp((s) => s.finishSectionProcessing);
	const appendAssistantChunk = useApp((s) => s.appendAssistantChunk);
	const finishAssistantMessage = useApp((s) => s.finishAssistantMessage);
	const addSectionMapItem = useApp((s) => s.addSectionMapItem);
	const addReviewSectionItem = useApp((s) => s.addReviewSectionItem);
	const addToolCallItem = useApp((s) => s.addToolCallItem);
	const updateToolCallItem = useApp((s) => s.updateToolCallItem);
	const pushError = useApp((s) => s.pushError);
	const addCommentDraft = useApp((s) => s.addCommentDraft);
	const applyCommentResult = useApp((s) => s.applyCommentResult);
	const pushStderr = useApp((s) => s.pushStderr);
	const chatVisible = useApp((s) => s.chatVisible);
	const toggleChat = useApp((s) => s.toggleChat);
	const [ghCliStatus, setGhCliStatus] = useState<GhCliStatus | null>(null);
	const [ghCliDismissed, setGhCliDismissed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const status = await acp.checkGhCli();
				if (!cancelled) setGhCliStatus(status);
			} catch (e) {
				if (!cancelled) pushError(`gh check failed: ${e}`);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [pushError]);

	useEffect(() => {
		if (!session) return;
		const snapshot = createReviewSnapshot({
			current_section_id: currentSectionId,
			sections,
			chat,
			comment_drafts: commentDrafts,
			published_comments: publishedComments,
			published_comments_error: publishedCommentsError,
		});
		const req = saveReviewRequestFromSession({ session, snapshot });
		if (!req) return;
		const handle = window.setTimeout(() => {
			void acp.saveReviewState(req).catch((e) => {
				recordClientTelemetryError("client.review_persistence.save.failed", e, {
					"acp.session_id": session.session_id,
					"session.source.kind": session.source.kind,
				});
			});
		}, 500);
		return () => window.clearTimeout(handle);
	}, [
		session,
		sections,
		currentSectionId,
		chat,
		commentDrafts,
		publishedComments,
		publishedCommentsError,
	]);

	useEffect(() => {
		recordClientTelemetry("client.app.event_listeners.effect_started", {
			"react.strict_mode_probe": true,
		});
		let cancelled = false;
		const registered: Unlisten[] = [];

		const handleSectionMap = async (p: SectionMapEvent) => {
			recordClientTelemetry("client.acp.section_map.received", {
				"acp.session_id": p.session_id,
				"section.count": p.map.sections.length,
			});
			setSectionMap(p.map.sections);
			addSectionMapItem(p.map.sections);
			const sess = useApp.getState().session;
			const sectionsWithRanges = sess
				? await enrichSectionMapWithLocalRanges(sess, p.map.sections)
				: p.map.sections;
			if (cancelled) return;
			if (sectionsWithRanges !== p.map.sections) {
				setSectionMap(sectionsWithRanges);
			}
			const first = sectionsWithRanges[0];
			recordClientTelemetry("client.acp.section_map.auto_open_evaluated", {
				"acp.session_id": p.session_id,
				"session.current_id": sess?.session_id,
				"section.first_id": first?.section_id,
				"section.count": sectionsWithRanges.length,
				"auto_open.will_send": !!first && !!sess,
			});
			if (first && sess) {
				try {
					startSectionProcessing(first.section_id);
					recordClientTelemetry("client.acp.section_map.auto_open_sending", {
						"acp.session_id": sess.session_id,
						"section.id": first.section_id,
						"section.title": first.title,
					});
					const publishedCommentContext = formatPublishedCommentsForPrompt(
						sess.published_comments ?? [],
						sess.published_comments_error,
					);
					await acp.sendMessage(
						sess.session_id,
						`Walk me through the section "${first.title}" (\`${first.section_id}\`).\n\n${publishedCommentContext}\n\nEmit one feedback-only acp-section block for it and stop. Do not include files, ranges, unimportant_ranges, base_ref, or head_ref.`,
						{
							origin: "section_map_auto_open",
							sectionId: first.section_id,
							reason: "show_first_section_immediately",
							suppressPreview: true,
						},
					);
					recordClientTelemetry("client.acp.section_map.auto_open_sent", {
						"acp.session_id": sess.session_id,
						"section.id": first.section_id,
					});
				} catch (e) {
					finishSectionProcessing(first.section_id);
					recordClientTelemetryError("client.acp.auto_open.failed", e, {
						"acp.session_id": sess.session_id,
						"section.id": first.section_id,
					});
					pushError(`auto-open failed: ${e}`);
				}
			}
		};

		const handleReviewSection = (p: SectionEvent) => {
			recordClientTelemetry("client.acp.section.received", {
				"acp.session_id": p.session_id,
				"section.id": p.section.section_id,
				"section.file_count": p.section.files.length,
				"section.unimportant_range_count":
					p.section.unimportant_ranges?.length ?? 0,
				"section.concern_count": p.section.concerns.length,
			});
			upsertSection(p.section);
			addReviewSectionItem(p.section);
		};

		const handleSectionProgress = (p: SectionProgressEvent) => {
			recordClientTelemetry("client.acp.section_progress.received", {
				"acp.session_id": p.session_id,
				"section.id": p.update.section_id,
				"section.phase": p.update.phase,
				"section.file_count": p.update.files?.length,
				"section.unimportant_range_count":
					p.update.unimportant_ranges?.length,
				"section.concern_count": p.update.concerns?.length,
			});
			upsertSectionProgress(p.update);
		};

		const handleToolCall = async (p: ToolCallEvent) => {
			const sectionProgress = parseToolSectionProgress(p.raw_input);
			if (sectionProgress) {
				handleSectionProgress({
					session_id: p.session_id,
					update: sectionProgress,
				});
				return;
			}
			const sectionMap = parseToolSectionMap(p.raw_input);
			if (sectionMap) {
				await handleSectionMap({ session_id: p.session_id, map: sectionMap });
				return;
			}
			const section = parseToolReviewSection(p.raw_input);
			if (section) {
				handleReviewSection({ session_id: p.session_id, section });
				return;
			}
			addToolCallItem({
				tool_call_id: p.tool_call_id,
				title: p.title,
				kind: p.kind,
				status: p.status,
			});
		};

		(async () => {
			const pending = await Promise.all([
				on<SectionMapEvent>("acp://section-map", handleSectionMap),
				on<SectionEvent>("acp://section", handleReviewSection),
				on<SectionProgressEvent>(
					"acp://section-progress",
					handleSectionProgress,
				),
				on<ToolCallEvent>("acp://tool-call", handleToolCall),
				on<ToolCallUpdateEvent>("acp://tool-call-update", (p) => {
					updateToolCallItem(p.tool_call_id, p.status);
				}),
				on<TextChunkEvent>("acp://text-chunk", (p) => {
					recordClientTelemetry("client.acp.text_chunk.received", {
						"acp.session_id": p.session_id,
						"acp.message_id": p.message_id,
						"chat.chunk.length": p.text.length,
						"chat.chunk.text": truncateTelemetryText(p.text),
						"chat.chunk.text_truncated":
							p.text.length > truncateTelemetryText(p.text).length,
					});
					appendAssistantChunk(p.text, {
						messageId: p.message_id,
						sessionId: p.session_id,
					});
				}),
				on<TurnDoneEvent>("acp://turn-done", (p) => {
					recordClientTelemetry("client.acp.turn_done.received", {
						"acp.session_id": p.session_id,
						"acp.stop_reason": p.stop_reason,
					});
					finishAssistantMessage();
				}),
				on<ErrorEvent>("acp://error", (p) => {
					recordClientTelemetryError("client.acp.error.received", p.error, {
						"acp.session_id": p.session_id,
					});
					finishSectionProcessing();
					pushError(p.error);
				}),
				on<CommentDraftEvent>("acp://comment-draft", (p) => {
					recordClientTelemetry("client.acp.comment_draft.received", {
						"acp.session_id": p.session_id,
						"comment.draft_id": p.draft_id,
						"comment.kind": p.draft.kind,
						"comment.file_path": p.draft.file_path,
						"comment.line": p.draft.line,
					});
					addCommentDraft(p.draft_id, p.draft);
				}),
				on<CommentResultEvent>("acp://comment-result", (p) => {
					recordClientTelemetry("client.acp.comment_result.received", {
						"acp.session_id": p.session_id,
						"comment.draft_id": p.result.draft_id,
						"comment.result.status": p.result.status,
						"comment.result.has_url": !!p.result.url,
						"comment.result.has_error": !!p.result.error,
					});
					applyCommentResult(p.result);
				}),
				on<AgentStderrEvent>("acp://agent-stderr", (p) => {
					recordClientTelemetry("client.acp.agent_stderr.received", {
						"acp.session_id": p.session_id,
						"agent.stderr.line": truncateTelemetryText(p.line),
					});
					pushStderr(p.line);
				}),
			]);

			if (cancelled) {
				// Effect was torn down (StrictMode double-mount, hot reload, etc.)
				// while we were still resolving listener registrations. Drop them
				// before they can fire.
				recordClientTelemetry("client.app.event_listeners.registration_cancelled", {
					"listener.count": pending.length,
				});
				for (const u of pending) u();
				return;
			}
			registered.push(...pending);
			recordClientTelemetry("client.app.event_listeners.registered", {
				"listener.count": registered.length,
			});
		})();

		return () => {
			cancelled = true;
			recordClientTelemetry("client.app.event_listeners.cleanup", {
				"listener.count": registered.length,
			});
			for (const u of registered) u();
		};
	}, [
			setSectionMap,
			upsertSection,
			upsertSectionProgress,
			setCurrentSection,
			startSectionProcessing,
			finishSectionProcessing,
		appendAssistantChunk,
		finishAssistantMessage,
		addSectionMapItem,
		addReviewSectionItem,
		addToolCallItem,
		updateToolCallItem,
			pushError,
			addCommentDraft,
			applyCommentResult,
			pushStderr,
		]);

	return (
		<div className="grid h-screen grid-rows-[44px_1fr] bg-background text-foreground">
			<Dialog
				open={ghCliNeedsInstallPopup(ghCliStatus) && !ghCliDismissed}
				onOpenChange={(open) => {
					if (!open) setGhCliDismissed(true);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<AlertTriangle className="size-4 text-destructive" />
							GitHub CLI is missing
						</DialogTitle>
						<DialogDescription className="whitespace-pre-line">
							{ghCliStatus ? ghCliPopupMessage(ghCliStatus) : ""}
						</DialogDescription>
					</DialogHeader>
					<div className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
						brew install gh
					</div>
					<div className="flex justify-end">
						<Button size="sm" onClick={() => setGhCliDismissed(true)}>
							Dismiss
						</Button>
					</div>
				</DialogContent>
			</Dialog>
			<header className="flex items-center gap-3 border-b border-border bg-background px-3">
				<ProjectPicker />
				<ReviewLauncher />
				{session && (
					<span className="font-mono text-[11px] text-muted-foreground">
						{session.repo.head_ref} ← {session.repo.base_ref}
					</span>
				)}
				<Button
					size="icon"
					variant="ghost"
					onClick={toggleChat}
					title={chatVisible ? "Hide chat" : "Show chat"}
					aria-label={chatVisible ? "Hide chat" : "Show chat"}
				>
					{chatVisible ? (
						<PanelRight className="size-4" />
					) : (
						<PanelLeft className="size-4" />
					)}
				</Button>
			</header>
			<main
				className="grid min-h-0 overflow-hidden"
				style={{
					gridTemplateColumns: chatVisible
						? "340px minmax(0, 1fr) 460px"
						: "340px minmax(0, 1fr)",
				}}
			>
				<SectionList />
				<DiffPane />
				{chatVisible && <ChatPanel />}
			</main>
			{errors.length > 0 && (
				<div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive shadow-lg">
					<span>{errors[errors.length - 1]}</span>
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs text-destructive hover:text-destructive"
						onClick={dismissErrors}
					>
						dismiss
					</Button>
				</div>
			)}
		</div>
	);
}
