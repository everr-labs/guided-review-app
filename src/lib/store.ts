import { create } from "zustand";
import type {
	ChatItem,
	ChatMessage,
	CommentDraft,
	CommentResult,
	ReviewSection,
	SectionMapEntry,
	SectionStatus,
	ToolCallItem,
} from "./types/section";
import type { ClonedRepo, PullRequestMetadata, SessionSource } from "./acp";
import type { LocalProject } from "./projectSource";
import { clearLastProjectPath, saveLastProjectPath } from "./projectSource";
import { recordClientTelemetry, truncateTelemetryText } from "./telemetry";

export interface SessionInfo {
	session_id: string;
	repo: ClonedRepo;
	source: SessionSource;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
}

export const PR_DESCRIPTION_SECTION_ID = "pr-description";

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
	status: "pending" | "publishing" | "published" | "rejected" | "error";
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
	processingSectionId: string | null;
	chat: ChatMessage[];
	commentDrafts: CommentDraftState[];
	streaming: boolean;
	errors: string[];
	stderr: string[];
	chatVisible: boolean;
	structuredReviewBlockOpen: boolean;

	setProject: (p: LocalProject | null) => void;
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
	applyCommentResult: (result: CommentResult) => void;

	pushError: (e: string) => void;
	dismissErrors: () => void;
	pushStderr: (line: string) => void;
	setStreaming: (s: boolean) => void;

	toggleChat: () => void;
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
	/```(?:acp-section-map|acp-section|acp-comment-draft|acp-comment-result)[^\n]*\n[\s\S]*?\n```[ \t]*(?:\r?\n)?/g;
const STRUCTURED_REVIEW_BLOCK_START_RE =
	/```(?:acp-section-map|acp-section|acp-comment-draft|acp-comment-result)[^\n]*\r?\n/g;

function cleanVisibleStructuredText(text: string): string {
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

function readableAssistantMessage(item: ChatItem): ChatMessage {
	return {
		id: crypto.randomUUID(),
		role: "assistant",
		text: "",
		item,
	};
}

export const useApp = create<AppState>((set) => ({
	project: null,
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
	structuredReviewBlockOpen: false,

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
				processingSectionId: null,
				chat: [],
				commentDrafts: [],
				streaming: false,
				structuredReviewBlockOpen: false,
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
				processingSectionId: null,
				chat: [],
				commentDrafts: [],
				streaming: false,
				structuredReviewBlockOpen: false,
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
			return {
				sections: [
					...(prDescription ? [prDescription] : []),
					...entries.map(
						(e): ReviewSectionState => ({
							id: e.section_id,
							kind: "review_section",
							title: e.title,
							intent: e.intent,
							status: "pending",
						}),
					),
				],
			};
		}),

	upsertSection: (section) =>
		set((state) => {
			const sections = [...state.sections];
			const idx = sections.findIndex((s) => s.id === section.section_id);
			const previousCurrentId = state.currentSectionId;
			const previousStatus = idx >= 0 ? sections[idx].status : undefined;
			const updated: ReviewSectionState = {
				id: section.section_id,
				kind: "review_section",
				title: section.title,
				intent: section.intent,
				status: "in_review",
				section,
			};
			if (idx >= 0) sections[idx] = updated;
			else sections.push(updated);
			const nextCurrentId =
				state.currentSectionId === PR_DESCRIPTION_SECTION_ID
					? state.currentSectionId
					: section.section_id;
			recordClientTelemetry("client.store.section.upserted", {
				"acp.session_id": state.session?.session_id,
				"section.id": section.section_id,
				"section.index": idx,
				"section.was_known": idx >= 0,
				"section.previous_status": previousStatus,
				"section.previous_current_id": previousCurrentId,
				"section.next_current_id": nextCurrentId,
				"section.processing_id": state.processingSectionId,
				"section.file_count": section.files.length,
				"section.range_count": section.ranges.length,
			});
			return {
				sections,
				currentSectionId: nextCurrentId,
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
			return {
				currentSectionId:
					state.currentSectionId === PR_DESCRIPTION_SECTION_ID
						? state.currentSectionId
						: id,
				processingSectionId: id,
			};
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
				const merged = appendStreamingText(last.text, visibleText);
				const nextText = cleanVisibleStructuredText(merged.text);
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

	applyCommentResult: (result) =>
		set((state) => ({
			commentDrafts: state.commentDrafts.map((d) => {
				if (d.id !== result.draft_id) return d;
				if (result.status === "published") {
					const draft = {
						...d,
						status: "published" as const,
						url: result.url,
					};
					delete draft.error;
					return draft;
				}
				const draft = {
					...d,
					status: "error" as const,
					error: result.error || "The agent could not publish the comment.",
				};
				delete draft.url;
				return draft;
			}),
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

}));
