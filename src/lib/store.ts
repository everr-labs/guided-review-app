import { create } from "zustand";
import type {
	ChatItem,
	ChatMessage,
	CommentDraft,
	ReviewSection,
	SectionMapEntry,
	SectionStatus,
	ToolCallItem,
} from "./types/section";
import type { ClonedRepo, SessionSource } from "./acp";
import {
	createDiffFocusRange,
	type DiffFocusRange,
	type DiffFocusSide,
} from "./diffFocus";
import { recordClientTelemetry, truncateTelemetryText } from "./telemetry";

export interface SessionInfo {
	session_id: string;
	repo: ClonedRepo;
	source: SessionSource;
}

export interface SectionState {
	id: string;
	title: string;
	intent: string;
	status: SectionStatus;
	section?: ReviewSection;
}

export interface CommentDraftState {
	id: string;
	draft: CommentDraft;
	status: "pending" | "publishing" | "published" | "rejected" | "error";
	url?: string;
	error?: string;
}

interface AssistantChunkMeta {
	sessionId?: string;
	messageId?: string;
}

interface LegacyQuotedContext {
	id: string;
	file_path?: string;
	start_line?: number;
	end_line?: number;
	side?: DiffFocusSide;
}

interface AppState {
	session: SessionInfo | null;
	sections: SectionState[];
	currentSectionId: string | null;
	processingSectionId: string | null;
	chat: ChatMessage[];
	commentDrafts: CommentDraftState[];
	streaming: boolean;
	errors: string[];
	stderr: string[];
	chatVisible: boolean;
	diffFocus: DiffFocusRange | null;
	diffFocusError: string | null;
	pendingDiffReferences: DiffFocusRange[];

	setSession: (s: SessionInfo | null) => void;
	reset: () => void;
	setSectionMap: (entries: SectionMapEntry[]) => void;
	upsertSection: (section: ReviewSection) => void;
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
	addContext: (ctx: LegacyQuotedContext) => void;
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
	/```(?:acp-section-map|acp-section|acp-comment-draft|acp-diff-focus)[^\n]*\n[\s\S]*?\n```[ \t]*(?:\r?\n)?/g;

function stripStructuredReviewBlocks(text: string): string {
	return text
		.replace(STRUCTURED_REVIEW_BLOCK_RE, "")
		.replace(/[ \t]+\r?\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n");
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

function readableAssistantMessage(item: ChatItem): ChatMessage {
	return {
		id: crypto.randomUUID(),
		role: "assistant",
		text: "",
		item,
	};
}

export const useApp = create<AppState>((set) => ({
	session: null,
	sections: [],
	currentSectionId: null,
	processingSectionId: null,
	chat: [],
	commentDrafts: [],
	streaming: false,
	errors: [],
	stderr: [],
	chatVisible: loadBool(LS_KEYS.chatVisible, true),
	diffFocus: null,
	diffFocusError: null,
	pendingDiffReferences: [],

	setSession: (s) => {
		recordClientTelemetry("client.store.session.set", {
			"acp.session_id": s?.session_id,
			"repo.display_slug": s?.repo.display_slug,
			"repo.base_ref": s?.repo.base_ref,
			"repo.head_ref": s?.repo.head_ref,
			"session.source.kind": s?.source.kind,
		});
		set({ session: s });
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
				processingSectionId: null,
				chat: [],
				commentDrafts: [],
				streaming: false,
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
			return {
				sections: entries.map((e) => ({
					id: e.section_id,
					title: e.title,
					intent: e.intent,
					status: "pending",
				})),
			};
		}),

	upsertSection: (section) =>
		set((state) => {
			const sections = [...state.sections];
			const idx = sections.findIndex((s) => s.id === section.section_id);
			const previousCurrentId = state.currentSectionId;
			const previousStatus = idx >= 0 ? sections[idx].status : undefined;
			const updated: SectionState = {
				id: section.section_id,
				title: section.title,
				intent: section.intent,
				status: "in_review",
				section,
			};
			if (idx >= 0) sections[idx] = updated;
			else sections.push(updated);
			recordClientTelemetry("client.store.section.upserted", {
				"acp.session_id": state.session?.session_id,
				"section.id": section.section_id,
				"section.index": idx,
				"section.was_known": idx >= 0,
				"section.previous_status": previousStatus,
				"section.previous_current_id": previousCurrentId,
				"section.next_current_id": section.section_id,
				"section.processing_id": state.processingSectionId,
				"section.file_count": section.files.length,
				"section.range_count": section.ranges.length,
			});
			return {
				sections,
				currentSectionId: section.section_id,
				processingSectionId:
					state.processingSectionId === section.section_id
						? null
						: state.processingSectionId,
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
				"section.previous_processing_id": state.processingSectionId,
				"section.next_processing_id": id,
			});
			return { currentSectionId: id, processingSectionId: id };
		}),

	finishSectionProcessing: (id = null) =>
		set((state) => {
			if (id && state.processingSectionId !== id) return {};
			recordClientTelemetry("client.store.section_processing.finished", {
				"acp.session_id": state.session?.session_id,
				"section.previous_processing_id": state.processingSectionId,
				"section.finished_id": id,
			});
			return { processingSectionId: null };
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
			const visibleText = stripStructuredReviewBlocks(text);
			if (!last && !visibleText) return { chat };
			if (last && last.role === "assistant" && last.streaming) {
				const merged = appendStreamingText(last.text, text);
				const nextText = stripStructuredReviewBlocks(merged.text);
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
				};
			} else {
				if (!visibleText) return { chat };
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
					streaming: true,
				});
			}
			return { chat };
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
		set((state) => ({
			chat: [
				...finishStreamingMessages(state.chat),
				readableAssistantMessage({
					type: "tool_call",
					toolCall,
				}),
			],
		})),

	updateToolCallItem: (id, status) =>
		set((state) => ({
			chat: state.chat.map((message) => {
				if (
					message.item?.type !== "tool_call" ||
					message.item.toolCall.tool_call_id !== id
				) {
					return message;
				}
				return {
					...message,
					item: {
						...message.item,
						toolCall: {
							...message.item.toolCall,
							status,
						},
					},
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
		set((state) => ({
			pendingDiffReferences: [...state.pendingDiffReferences, range],
		})),
	removePendingDiffReference: (id) =>
		set((state) => ({
			pendingDiffReferences: state.pendingDiffReferences.filter(
				(r) => r.id !== id,
			),
		})),
	clearPendingDiffReferences: () => set({ pendingDiffReferences: [] }),
	addContext: (ctx) =>
		set((state) => {
			if (!ctx.file_path || !ctx.start_line) return {};
			const range = createDiffFocusRange({
				id: ctx.id,
				file_path: ctx.file_path,
				start_line: ctx.start_line,
				end_line: ctx.end_line ?? ctx.start_line,
				side: ctx.side ?? "RIGHT",
				source: "user",
				mode: "draft-reference",
			});
			if (!range) return {};
			return {
				pendingDiffReferences: [...state.pendingDiffReferences, range],
			};
		}),
}));
