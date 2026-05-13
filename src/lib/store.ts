import { create } from "zustand";
import type {
	ChatItem,
	ChatMessage,
	ChatMessagePart,
	CommentDraft,
	CommentResult,
	ReviewSection,
	SectionMapEntry,
	SectionProgressUpdate,
	SectionStatus,
	ToolCallItem,
} from "./types/section";
import type {
	ClonedRepo,
	PublishedPrComment,
	PullRequestMetadata,
	SessionSource,
} from "./acp";
import type { LocalProject } from "./projectSource";
import { clearLastProjectPath, saveLastProjectPath } from "./projectSource";
import type { DiffFocusRange } from "./diffFocus";
import { recordClientTelemetry, truncateTelemetryText } from "./telemetry";
import type { ReviewSnapshot } from "./reviewPersistence";

export interface SessionInfo {
	session_id: string;
	repo: ClonedRepo;
	source: SessionSource;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
	published_comments?: PublishedPrComment[];
	published_comments_error?: string;
}

export const PR_DESCRIPTION_SECTION_ID = "pr-description";

function hasSectionFeedback(section: ReviewSection): boolean {
	return (
		section.concerns.length > 0 ||
		section.pause_prompt.trim().length > 0
	);
}

function emptyFeedbackSection(
	section_id: string,
	title: string,
	intent: string,
	session: SessionInfo | null,
): ReviewSection {
	return {
		schema_version: 1,
		section_id,
		title,
		intent,
		files: [],
		ranges: [],
		unimportant_ranges: [],
		concerns: [],
		base_ref: session?.repo.base_ref ?? "",
		head_ref: session?.repo.head_ref ?? "",
		pause_prompt: "",
	};
}

function mergeMapEntrySection(
	entry: SectionMapEntry,
	existing: ReviewSectionState | undefined,
	session: SessionInfo | null,
): ReviewSection | undefined {
	const previous = existing?.section;
	const hasPreview =
		Array.isArray(entry.files) || Array.isArray(entry.ranges);
	if (!hasPreview && !previous) return undefined;
	const section = previous
		? { ...previous }
		: emptyFeedbackSection(entry.section_id, entry.title, entry.intent, session);
	return {
		...section,
		section_id: entry.section_id,
		title: entry.title,
		intent: entry.intent,
		files: entry.files ?? section.files,
		ranges: entry.ranges ?? section.ranges,
		base_ref: section.base_ref || session?.repo.base_ref || "",
		head_ref: section.head_ref || session?.repo.head_ref || "",
	};
}

function hasStructure(section: ReviewSection | undefined): boolean {
	return Boolean(
		section &&
			(section.files.length > 0 ||
				section.ranges.length > 0 ||
				section.base_ref ||
				section.head_ref),
	);
}

function mergeSectionProgress(
	update: SectionProgressUpdate,
	existing: ReviewSectionState | undefined,
	session: SessionInfo | null,
): ReviewSection {
	const previous = existing?.section;
	const previousHasStructure = hasStructure(previous);
	return {
		schema_version: 1,
		section_id: update.section_id,
		title: update.title ?? previous?.title ?? existing?.title ?? update.section_id,
		intent: update.intent ?? previous?.intent ?? existing?.intent ?? "",
		files: previousHasStructure
			? previous?.files ?? []
			: update.files ?? previous?.files ?? [],
		ranges: previousHasStructure
			? previous?.ranges ?? []
			: update.ranges ?? previous?.ranges ?? [],
		unimportant_ranges:
			update.unimportant_ranges ?? previous?.unimportant_ranges ?? [],
		concerns: update.concerns ?? previous?.concerns ?? [],
		base_ref: update.base_ref ?? previous?.base_ref ?? session?.repo.base_ref ?? "",
		head_ref: update.head_ref ?? previous?.head_ref ?? session?.repo.head_ref ?? "",
		pause_prompt: previous?.pause_prompt ?? "",
	};
}

function mergeSectionFeedback(
	section: ReviewSection,
	existing: ReviewSectionState | undefined,
	session: SessionInfo | null,
): ReviewSection {
	const previous = existing?.section;
	const previousHasStructure = hasStructure(previous);
	return {
		schema_version: 1,
		section_id: section.section_id,
		title: previous?.title ?? existing?.title ?? section.title,
		intent: previous?.intent ?? existing?.intent ?? section.intent,
		files: previousHasStructure ? previous?.files ?? [] : section.files ?? [],
		ranges: previousHasStructure ? previous?.ranges ?? [] : section.ranges ?? [],
		unimportant_ranges: previous
			? previous.unimportant_ranges
			: section.unimportant_ranges ?? [],
		concerns: section.concerns ?? [],
		base_ref: previousHasStructure
			? previous?.base_ref ?? ""
			: section.base_ref || session?.repo.base_ref || "",
		head_ref: previousHasStructure
			? previous?.head_ref ?? ""
			: section.head_ref || session?.repo.head_ref || "",
		pause_prompt: section.pause_prompt ?? "",
	};
}

interface BaseSectionState {
	id: string;
	title: string;
	intent: string;
	status: SectionStatus;
}

export interface PrDescriptionSectionState extends BaseSectionState {
	kind: "pr_description";
	body: string;
	url?: string;
	error?: string;
}

export interface ReviewSectionState extends BaseSectionState {
	kind: "review_section";
	section?: ReviewSection;
}

export type SectionState = PrDescriptionSectionState | ReviewSectionState;

export interface CommentDraftState {
	id: string;
	draft: CommentDraft;
	status:
		| "pending"
		| "approved"
		| "publishing"
		| "published"
		| "rejected"
		| "error";
	url?: string;
	error?: string;
}

interface AssistantChunkMeta {
	sessionId?: string;
	messageId?: string;
}

interface AppState {
	project: LocalProject | null;
	session: SessionInfo | null;
	sections: SectionState[];
	currentSectionId: string | null;
	processingSectionIds: string[];
	chat: ChatMessage[];
	commentDrafts: CommentDraftState[];
	publishedComments: PublishedPrComment[];
	publishedCommentsFetchedAt: number | null;
	publishedCommentsError: string | null;
	streaming: boolean;
	errors: string[];
	stderr: string[];
	chatVisible: boolean;
	structuredReviewBlockOpen: boolean;
	diffFocus: DiffFocusRange | null;
	diffFocusError: string | null;
	pendingDiffReferences: DiffFocusRange[];

	setProject: (p: LocalProject | null) => void;
	setSession: (s: SessionInfo | null) => void;
	restoreSavedReview: (session: SessionInfo, snapshot: ReviewSnapshot) => void;
	reset: () => void;
	setSectionMap: (entries: SectionMapEntry[]) => void;
	upsertSection: (section: ReviewSection) => void;
	upsertSectionProgress: (update: SectionProgressUpdate) => void;
	markSectionCompleted: (id: string) => void;
	setCurrentSection: (id: string | null, reason?: string) => void;
	startSectionProcessing: (id: string) => void;
	finishSectionProcessing: (id?: string | null) => void;

	addUserMessage: (text: string) => void;
	appendAssistantChunk: (text: string, meta?: AssistantChunkMeta) => void;
	finishAssistantMessage: () => void;
	addSectionMapItem: (entries: SectionMapEntry[]) => void;
	addReviewSectionItem: (section: ReviewSection) => void;
	addToolCallItem: (toolCall: ToolCallItem) => void;
	updateToolCallItem: (id: string, status: string) => void;

	addCommentDraft: (id: string, draft: CommentDraft) => void;
	updateCommentDraft: (id: string, patch: Partial<CommentDraftState>) => void;
	editCommentDraftBody: (id: string, body: string) => void;
	dismissCommentDraft: (id: string) => void;
	applyCommentResult: (result: CommentResult) => void;

	pushError: (e: string) => void;
	dismissErrors: () => void;
	pushStderr: (line: string) => void;
	setStreaming: (s: boolean) => void;

	toggleChat: () => void;

	setDiffFocus: (range: DiffFocusRange | null) => void;
	clearDiffFocus: (id?: string) => void;
	setDiffFocusError: (error: string | null) => void;
	addPendingDiffReference: (range: DiffFocusRange) => void;
	removePendingDiffReference: (id: string) => void;
	clearPendingDiffReferences: () => void;
}

const LS_KEYS = {
	chatVisible: "gr.chatVisible",
} as const;

function loadBool(key: string, fallback: boolean): boolean {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : v === "1";
	} catch {
		return fallback;
	}
}

function prDescriptionFromSession(
	session: SessionInfo | null,
): PrDescriptionSectionState | null {
	if (!session?.pull_request && !session?.pull_request_error) return null;
	const pr = session.pull_request;
	return {
		id: PR_DESCRIPTION_SECTION_ID,
		kind: "pr_description",
		title: "PR description",
		intent: pr?.title || "PR description unavailable",
		status: "in_review",
		body: pr
			? pr.body.trim() || "No PR description was provided."
			: "PR description unavailable.",
		url: pr?.url,
		error: session.pull_request_error,
	};
}

interface AppendStreamingTextResult {
	text: string;
	rawOverlapLength: number;
	appliedOverlapLength: number;
	replacesCurrent: boolean;
}

function sharedBoundaryLength(current: string, chunk: string): number {
	const maxOverlap = Math.min(current.length, chunk.length);
	for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
		if (current.endsWith(chunk.slice(0, overlap))) {
			return overlap;
		}
	}
	return 0;
}

function appendStreamingText(
	current: string,
	chunk: string,
): AppendStreamingTextResult {
	if (!current || !chunk) {
		return {
			text: current + chunk,
			rawOverlapLength: 0,
			appliedOverlapLength: 0,
			replacesCurrent: false,
		};
	}

	const rawOverlapLength = sharedBoundaryLength(current, chunk);
	const replacesCurrent = chunk.startsWith(current);
	const appliedOverlapLength =
		replacesCurrent || rawOverlapLength >= 4 ? rawOverlapLength : 0;
	const text = replacesCurrent
		? chunk
		: current + chunk.slice(appliedOverlapLength);

	return {
		text,
		rawOverlapLength,
		appliedOverlapLength,
		replacesCurrent,
	};
}

const STRUCTURED_REVIEW_BLOCK_RE =
	/```[ \t]*(?:acp-section-map|acp-section|acp-comment-draft|acp-comment-result)[^\n]*\n[\s\S]*?\n```[ \t]*(?:\r?\n)?/g;
const STRUCTURED_REVIEW_BLOCK_START_RE =
	/```[ \t]*(?:acp-section-map|acp-section|acp-comment-draft|acp-comment-result)[^\n]*\r?\n/g;

export function cleanVisibleStructuredText(text: string): string {
	return text
		.replace(STRUCTURED_REVIEW_BLOCK_RE, "")
		.replace(/[ \t]+\r?\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
}

function findStructuredFenceCloseEnd(text: string, start: number): number | null {
	if (text.startsWith("```", start)) {
		const lineEnd = text.indexOf("\n", start);
		return lineEnd === -1 ? text.length : lineEnd + 1;
	}
	const match = /\r?\n```[ \t]*(?:\r?\n)?/.exec(text.slice(start));
	return match ? start + match.index + match[0].length : null;
}

function stripStructuredReviewBlocks(
	text: string,
	insideBlock: boolean,
): { text: string; insideBlock: boolean } {
	let cursor = 0;
	let visible = "";
	let hidden = insideBlock;

	while (cursor < text.length) {
		if (hidden) {
			const closeEnd = findStructuredFenceCloseEnd(text, cursor);
			if (closeEnd === null) {
				return {
					text: cleanVisibleStructuredText(visible),
					insideBlock: true,
				};
			}
			cursor = closeEnd;
			hidden = false;
			continue;
		}

		STRUCTURED_REVIEW_BLOCK_START_RE.lastIndex = cursor;
		const startMatch = STRUCTURED_REVIEW_BLOCK_START_RE.exec(text);
		if (!startMatch) {
			visible += text.slice(cursor);
			break;
		}

		visible += text.slice(cursor, startMatch.index);
		cursor = startMatch.index + startMatch[0].length;
		const closeEnd = findStructuredFenceCloseEnd(text, cursor);
		if (closeEnd === null) {
			return {
				text: cleanVisibleStructuredText(visible),
				insideBlock: true,
			};
		}
		cursor = closeEnd;
	}

	return { text: cleanVisibleStructuredText(visible), insideBlock: false };
}

function finishStreamingMessages(chat: ChatMessage[]): ChatMessage[] {
	let changed = false;
	const next = chat.map((message) => {
		if (!message.streaming) return message;
		changed = true;
		return { ...message, streaming: false };
	});
	return changed ? next : chat;
}

function partsFromMessage(message: ChatMessage): ChatMessagePart[] {
	if (message.parts) return [...message.parts];
	return message.text ? [{ type: "markdown", text: message.text }] : [];
}

function textFromParts(parts: ChatMessagePart[]): string {
	return parts
		.filter((part): part is Extract<ChatMessagePart, { type: "markdown" }> =>
			part.type === "markdown"
		)
		.map((part) => part.text)
		.join("");
}

function updateToolCallPart(
	part: ChatMessagePart,
	id: string,
	status: string,
): ChatMessagePart {
	if (part.type !== "tool_call" || part.toolCall.tool_call_id !== id) {
		return part;
	}
	return {
		type: "tool_call",
		toolCall: {
			...part.toolCall,
			status,
		},
	};
}

function readableAssistantMessage(item: ChatItem): ChatMessage {
	return {
		id: crypto.randomUUID(),
		role: "assistant",
		text: "",
		item,
	};
}

function addProcessingSectionId(ids: string[], id: string): string[] {
	return ids.includes(id) ? ids : [...ids, id];
}

function removeProcessingSectionId(ids: string[], id: string): string[] {
	return ids.filter((current) => current !== id);
}

export const useApp = create<AppState>((set) => ({
	project: null,
	session: null,
	sections: [],
	currentSectionId: null,
	processingSectionIds: [],
	chat: [],
	commentDrafts: [],
	publishedComments: [],
	publishedCommentsFetchedAt: null,
	publishedCommentsError: null,
	streaming: false,
	errors: [],
	stderr: [],
	chatVisible: loadBool(LS_KEYS.chatVisible, true),
	structuredReviewBlockOpen: false,
	diffFocus: null,
	diffFocusError: null,
	pendingDiffReferences: [],

	setProject: (p) =>
		set((state) => {
			const samePath = state.project?.path === p?.path;
			if (p) saveLastProjectPath(p.path);
			else clearLastProjectPath();
			recordClientTelemetry("client.store.project.set", {
				"project.path": p?.path,
				"project.slug": p?.origin.slug,
				"project.previous_path": state.project?.path,
				"project.cleared_session": !samePath && !!state.session,
			});
				if (samePath) {
					return { project: p };
				}
				return {
					project: p,
					session: null,
					sections: [],
					currentSectionId: null,
					processingSectionIds: [],
					chat: [],
					commentDrafts: [],
					publishedComments: [],
					publishedCommentsFetchedAt: null,
					publishedCommentsError: null,
					streaming: false,
					structuredReviewBlockOpen: false,
					diffFocus: null,
					diffFocusError: null,
					pendingDiffReferences: [],
				};
			}),

		setSession: (s) => {
			recordClientTelemetry("client.store.session.set", {
				"acp.session_id": s?.session_id,
				"repo.display_slug": s?.repo.display_slug,
				"repo.base_ref": s?.repo.base_ref,
				"repo.head_ref": s?.repo.head_ref,
				"session.source.kind": s?.source.kind,
				"pull_request.has_metadata": !!s?.pull_request,
				"pull_request.has_error": !!s?.pull_request_error,
			});
			const prDescription = prDescriptionFromSession(s);
			set({
				session: s,
				sections: prDescription ? [prDescription] : [],
				currentSectionId: prDescription ? prDescription.id : null,
				commentDrafts: [],
				publishedComments: s?.published_comments ?? [],
				publishedCommentsFetchedAt: s ? Date.now() : null,
				publishedCommentsError: s?.published_comments_error ?? null,
				pendingDiffReferences: [],
			});
		},
		restoreSavedReview: (session, snapshot) => {
			recordClientTelemetry("client.store.saved_review.restored", {
				"acp.session_id": session.session_id,
				"repo.display_slug": session.repo.display_slug,
				"repo.base_ref": session.repo.base_ref,
				"repo.head_ref": session.repo.head_ref,
				"session.source.kind": session.source.kind,
				"section.current_id": snapshot.current_section_id,
				"section.count": snapshot.sections.length,
				"chat.count": snapshot.chat.length,
				"comment_draft.count": snapshot.comment_drafts.length,
			});
			set({
				session,
				sections: snapshot.sections,
				currentSectionId: snapshot.current_section_id,
				processingSectionIds: [],
				chat: snapshot.chat,
				commentDrafts: snapshot.comment_drafts,
				publishedComments: snapshot.published_comments,
				publishedCommentsFetchedAt: Date.now(),
				publishedCommentsError: snapshot.published_comments_error,
				streaming: false,
				structuredReviewBlockOpen: false,
				diffFocus: null,
				diffFocusError: null,
				pendingDiffReferences: [],
			});
		},
		reset: () =>
			set((state) => {
				recordClientTelemetry("client.store.reset", {
					"acp.session_id": state.session?.session_id,
					"section.current_id": state.currentSectionId,
					"section.count": state.sections.length,
					"chat.count": state.chat.length,
				});
				return {
					session: null,
					sections: [],
					currentSectionId: null,
					processingSectionIds: [],
					chat: [],
					commentDrafts: [],
					publishedComments: [],
					publishedCommentsFetchedAt: null,
					publishedCommentsError: null,
					streaming: false,
					structuredReviewBlockOpen: false,
					diffFocus: null,
					diffFocusError: null,
					pendingDiffReferences: [],
				};
			}),

		setSectionMap: (entries) =>
			set((state) => {
				recordClientTelemetry("client.store.section_map.set", {
					"acp.session_id": state.session?.session_id,
					"section.count": entries.length,
					"section.first_id": entries[0]?.section_id,
					"section.previous_current_id": state.currentSectionId,
					"section.previous_count": state.sections.length,
				});
				const prDescription = state.sections.find(
					(section): section is PrDescriptionSectionState =>
						section.kind === "pr_description",
				);
				const existingReviewSections = new Map(
					state.sections
						.filter(
							(section): section is ReviewSectionState =>
								section.kind === "review_section",
						)
						.map((section) => [section.id, section]),
				);
				return {
					sections: [
						...(prDescription ? [prDescription] : []),
						...entries.map((e): ReviewSectionState => {
							const existing = existingReviewSections.get(e.section_id);
							const section = mergeMapEntrySection(e, existing, state.session);
							return {
								id: e.section_id,
								kind: "review_section",
								title: e.title,
								intent: e.intent,
								status:
									existing?.status === "completed"
										? "completed"
										: section && hasSectionFeedback(section)
											? "in_review"
											: "pending",
								section,
							};
						}),
					],
				};
			}),

		upsertSection: (section) =>
			set((state) => {
				const sections = [...state.sections];
				const idx = sections.findIndex((s) => s.id === section.section_id);
				const existing =
					idx >= 0 && sections[idx]?.kind === "review_section"
						? sections[idx]
						: undefined;
				const previousStatus = idx >= 0 ? sections[idx].status : undefined;
				const normalizedSection = mergeSectionFeedback(
					section,
					existing,
					state.session,
				);
				const updated: ReviewSectionState = {
					id: section.section_id,
					kind: "review_section",
					title: normalizedSection.title,
					intent: normalizedSection.intent,
					status: "in_review",
					section: normalizedSection,
				};
				if (idx >= 0) sections[idx] = updated;
				else sections.push(updated);
				recordClientTelemetry("client.store.section.upserted", {
					"acp.session_id": state.session?.session_id,
					"section.id": section.section_id,
					"section.index": idx,
					"section.was_known": idx >= 0,
					"section.previous_status": previousStatus,
					"section.current_id": state.currentSectionId,
					"section.processing_ids": state.processingSectionIds.join(","),
					"section.file_count": normalizedSection.files.length,
					"section.unimportant_range_count":
						section.unimportant_ranges?.length ?? 0,
				});
				return {
					sections,
					processingSectionIds: removeProcessingSectionId(
						state.processingSectionIds,
						section.section_id,
					),
				};
			}),

		upsertSectionProgress: (update) =>
			set((state) => {
				const sections = [...state.sections];
				const idx = sections.findIndex((s) => s.id === update.section_id);
				const existing =
					idx >= 0 && sections[idx]?.kind === "review_section"
						? sections[idx]
						: undefined;
				const section = mergeSectionProgress(update, existing, state.session);
				const updated: ReviewSectionState = {
					id: update.section_id,
					kind: "review_section",
					title: section.title,
					intent: section.intent,
					status: "in_review",
					section,
				};
				if (idx >= 0) sections[idx] = updated;
				else sections.push(updated);
				recordClientTelemetry("client.store.section_progress.upserted", {
					"acp.session_id": state.session?.session_id,
					"section.id": update.section_id,
					"section.phase": update.phase,
					"section.index": idx,
					"section.was_known": idx >= 0,
					"section.current_id": state.currentSectionId,
					"section.file_count": section.files.length,
					"section.unimportant_range_count": section.unimportant_ranges.length,
					"section.concern_count": section.concerns.length,
				});
				return {
					sections,
					processingSectionIds: addProcessingSectionId(
						state.processingSectionIds,
						update.section_id,
					),
				};
			}),

		markSectionCompleted: (id) =>
			set((state) => {
				recordClientTelemetry("client.store.section.completed", {
					"acp.session_id": state.session?.session_id,
					"section.id": id,
					"section.current_id": state.currentSectionId,
				});
				return {
					sections: state.sections.map((s) =>
						s.id === id ? { ...s, status: "completed" } : s,
					),
				};
			}),

		setCurrentSection: (id, reason = "unknown") =>
			set((state) => {
				recordClientTelemetry("client.store.current_section.set", {
					"acp.session_id": state.session?.session_id,
					"section.previous_current_id": state.currentSectionId,
					"section.next_current_id": id,
					"section.set_reason": reason,
				});
				return { currentSectionId: id };
			}),

		startSectionProcessing: (id) =>
			set((state) => {
				recordClientTelemetry("client.store.section_processing.started", {
					"acp.session_id": state.session?.session_id,
					"section.previous_processing_ids": state.processingSectionIds.join(","),
					"section.next_processing_id": id,
					"section.current_id": state.currentSectionId,
				});
				return {
					processingSectionIds: addProcessingSectionId(
						state.processingSectionIds,
						id,
					),
				};
			}),

		finishSectionProcessing: (id = null) =>
			set((state) => {
				if (id && !state.processingSectionIds.includes(id)) return {};
				recordClientTelemetry("client.store.section_processing.finished", {
					"acp.session_id": state.session?.session_id,
					"section.previous_processing_ids": state.processingSectionIds.join(","),
					"section.finished_id": id,
				});
				return {
					processingSectionIds: id
						? removeProcessingSectionId(state.processingSectionIds, id)
						: [],
				};
			}),

	addUserMessage: (text) =>
		set((state) => ({
			chat: [
				...state.chat,
				{ id: crypto.randomUUID(), role: "user", text },
			],
			streaming: true,
		})),

	appendAssistantChunk: (text, meta) =>
		set((state) => {
			const chat = [...state.chat];
			const last = chat[chat.length - 1];
			const sessionId = meta?.sessionId ?? state.session?.session_id;
			const stripped = stripStructuredReviewBlocks(
				text,
				state.structuredReviewBlockOpen,
			);
			const visibleText = stripped.text;
			if (!last && !visibleText) {
				return {
					chat,
					structuredReviewBlockOpen: stripped.insideBlock,
				};
			}
			if (last && last.role === "assistant" && last.streaming) {
				const parts = partsFromMessage(last);
				const lastPart = parts[parts.length - 1];
				const merged = appendStreamingText(last.text, visibleText);
				const nextText = cleanVisibleStructuredText(merged.text);
				const nextSuffix = nextText.startsWith(last.text)
					? nextText.slice(last.text.length)
					: visibleText;
				if (lastPart?.type === "markdown" && nextSuffix) {
					parts[parts.length - 1] = {
						type: "markdown",
						text: cleanVisibleStructuredText(lastPart.text + nextSuffix),
					};
				} else if (nextSuffix) {
					parts.push({ type: "markdown", text: nextSuffix });
				}
				recordClientTelemetry("client.chat.assistant_chunk.merged", {
					"acp.session_id": sessionId,
					"acp.message_id": meta?.messageId,
					"chat.chunk.length": text.length,
					"chat.current.length": last.text.length,
					"chat.next.length": nextText.length,
					"chat.overlap.raw_length": merged.rawOverlapLength,
					"chat.overlap.applied_length": merged.appliedOverlapLength,
					"chat.overlap.replaces_current": merged.replacesCurrent,
					"chat.chunk.text": truncateTelemetryText(text),
					"chat.current.tail": truncateTelemetryText(last.text.slice(-512)),
				});
				chat[chat.length - 1] = {
					...last,
					text: nextText,
					parts,
				};
			} else {
				if (!visibleText) {
					return {
						chat,
						structuredReviewBlockOpen: stripped.insideBlock,
					};
				}
				recordClientTelemetry("client.chat.assistant_message.started", {
					"acp.session_id": sessionId,
					"acp.message_id": meta?.messageId,
					"chat.chunk.length": text.length,
					"chat.chunk.text": truncateTelemetryText(text),
				});
				chat.push({
					id: crypto.randomUUID(),
					role: "assistant",
					text: visibleText,
					parts: [{ type: "markdown", text: visibleText }],
					streaming: true,
				});
			}
			return { chat, structuredReviewBlockOpen: stripped.insideBlock };
		}),

	finishAssistantMessage: () =>
		set((state) => {
			const chat = [...state.chat];
			const last = chat[chat.length - 1];
			if (last && last.streaming) {
				recordClientTelemetry("client.chat.assistant_message.finished", {
					"acp.session_id": state.session?.session_id,
					"chat.message.length": last.text.length,
				});
				chat[chat.length - 1] = { ...last, streaming: false };
			}
			return { chat, streaming: false };
		}),

	addSectionMapItem: (entries) =>
		set((state) => ({
			chat: [
				...finishStreamingMessages(state.chat),
				readableAssistantMessage({
					type: "section_map",
					sections: entries,
				}),
			],
		})),

	addReviewSectionItem: (section) =>
		set((state) => ({
			chat: [
				...finishStreamingMessages(state.chat),
				readableAssistantMessage({
					type: "review_section",
					section,
				}),
			],
		})),

	addToolCallItem: (toolCall) =>
		set((state) => {
			const chat = [...state.chat];
			const last = chat[chat.length - 1];
			if (last?.role === "assistant" && last.streaming && !last.item) {
				const parts = partsFromMessage(last);
				parts.push({ type: "tool_call", toolCall });
				chat[chat.length - 1] = {
					...last,
					text: textFromParts(parts),
					parts,
				};
				return { chat };
			}
			return {
				chat: [
					...chat,
					{
						id: crypto.randomUUID(),
						role: "assistant",
						text: "",
						parts: [{ type: "tool_call", toolCall }],
						streaming: true,
					},
				],
			};
		}),

	updateToolCallItem: (id, status) =>
		set((state) => ({
			chat: state.chat.map((message) => {
				if (!message.parts?.some((part) => part.type === "tool_call")) {
					return message;
				}
				const parts = message.parts.map((part) =>
					updateToolCallPart(part, id, status),
				);
				return {
					...message,
					parts,
				};
			}),
		})),

	addCommentDraft: (id, draft) =>
		set((state) => ({
			commentDrafts: [
				...state.commentDrafts,
				{ id, draft, status: "pending" },
			],
		})),

	updateCommentDraft: (id, patch) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) =>
				d.id === id ? { ...d, ...patch } : d,
			),
		})),
	editCommentDraftBody: (id, body) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) =>
				d.id === id ? { ...d, draft: { ...d.draft, body } } : d,
			),
		})),
	dismissCommentDraft: (id) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.filter((d) => d.id !== id),
		})),

	applyCommentResult: (result) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.filter(
				(d) => d.id !== result.draft_id,
			),
		})),

	pushError: (e) =>
		set((state) => ({
			errors: [...state.errors.slice(-49), e],
			streaming: false,
		})),

	dismissErrors: () => set({ errors: [] }),

	pushStderr: (line) =>
		set((state) => ({ stderr: [...state.stderr.slice(-199), line] })),

	setStreaming: (s) => set({ streaming: s }),

	toggleChat: () =>
		set((state) => {
			const next = !state.chatVisible;
			try {
				localStorage.setItem(LS_KEYS.chatVisible, next ? "1" : "0");
			} catch {}
			return { chatVisible: next };
		}),

	setDiffFocus: (range) =>
		set((state) => {
			recordClientTelemetry("client.store.diff_focus.set", {
				"acp.session_id": state.session?.session_id,
				"focus.file_path": range?.file_path,
				"focus.start_line": range?.start_line,
				"focus.end_line": range?.end_line,
				"focus.side": range?.side,
				"focus.source": range?.source,
				"focus.mode": range?.mode,
			});
			return { diffFocus: range, diffFocusError: null };
		}),
	clearDiffFocus: (id) =>
		set((state) => {
			if (id && state.diffFocus?.id !== id) return {};
			return { diffFocus: null };
		}),
	setDiffFocusError: (error) => set({ diffFocusError: error }),
	addPendingDiffReference: (range) =>
		set((state) => {
			const exists = state.pendingDiffReferences.some(
				(r) =>
					r.file_path === range.file_path &&
					r.side === range.side &&
					r.start_line === range.start_line &&
					r.end_line === range.end_line,
			);
			if (exists) return {};
			return {
				pendingDiffReferences: [...state.pendingDiffReferences, range],
			};
		}),
	removePendingDiffReference: (id) =>
		set((state) => ({
			pendingDiffReferences: state.pendingDiffReferences.filter(
				(r) => r.id !== id,
			),
		})),
	clearPendingDiffReferences: () => set({ pendingDiffReferences: [] }),
}));
