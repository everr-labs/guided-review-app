import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	CommentDraft,
	CommentResult,
	ReviewSection,
	SectionMap,
} from "./types/section";
import {
	recordClientTelemetry,
	recordClientTelemetryError,
} from "./telemetry";
import { sendMessageTelemetryAttrs } from "./commentPublish";

export type AgentKind = "claude_code" | "codex";

export interface AgentInfo {
	kind: AgentKind;
	label: string;
	launch_command: string;
}

export type SessionSource =
	| { kind: "pr"; repo_url: string; number: number }
	| { kind: "branch"; repo_url: string; branch: string }
	| { kind: "sha"; repo_url: string; sha: string }
	| { kind: "local"; path: string }
	| { kind: "local_pr"; path: string; repo_url: string; number: number }
	| { kind: "local_branch"; path: string; branch: string };

export interface ClonedRepo {
	path: string;
	head_ref: string;
	head_sha: string;
	base_ref: string;
	display_slug: string;
}

export interface PullRequestMetadata {
	title: string;
	body: string;
	url: string;
}

export interface StartSessionResponse {
	session_id: string;
	repo: ClonedRepo;
	source: SessionSource;
	pull_request?: PullRequestMetadata;
	pull_request_error?: string;
}

export interface DiffPatch {
	file_path: string;
	patch: string;
}

export interface PrTarget {
	owner: string;
	repo: string;
	number: number;
}

export interface LocalRepoOrigin {
	repo_url: string;
	owner: string;
	repo: string;
	slug: string;
}

export type RecentProject =
	| {
			kind: "pr";
			repo_url: string;
			owner: string;
			repo: string;
			number: number;
			last_opened: number;
	  }
	| {
			kind: "branch";
			repo_url: string;
			owner: string;
			repo: string;
			branch: string;
			last_opened: number;
	  }
	| { kind: "local"; path: string; label: string; last_opened: number };

export interface SectionMapEvent {
	session_id: string;
	map: SectionMap;
}

export interface SectionEvent {
	session_id: string;
	section: ReviewSection;
}

export interface TextChunkEvent {
	session_id: string;
	message_id: string;
	text: string;
}

export interface ToolCallEvent {
	session_id: string;
	tool_call_id: string;
	title: string;
	kind: string;
	status: string;
	raw_input: unknown;
}

export interface ToolCallUpdateEvent {
	session_id: string;
	tool_call_id: string;
	status: string;
	raw_output: unknown;
}

export interface TurnDoneEvent {
	session_id: string;
	stop_reason: string;
}

export interface ErrorEvent {
	session_id?: string;
	error: string;
}

export interface CommentDraftEvent {
	session_id: string;
	draft_id: string;
	draft: CommentDraft;
}

export interface CommentResultEvent {
	session_id: string;
	result: CommentResult;
}

export interface AgentStderrEvent {
	session_id: string;
	line: string;
}

export interface SendMessageOptions {
	origin?: string;
	sectionId?: string;
	reason?: string;
	suppressPreview?: boolean;
}

function payloadSessionId(payload: unknown): string | undefined {
	if (payload && typeof payload === "object" && "session_id" in payload) {
		const sessionId = (payload as { session_id?: unknown }).session_id;
		return typeof sessionId === "string" ? sessionId : undefined;
	}
	return undefined;
}

export const acp = {
	listAgents: async () => {
		recordClientTelemetry("client.acp.invoke.started", {
			"tauri.command": "list_agents_cmd",
		});
		try {
			const agents = await invoke<AgentInfo[]>("list_agents_cmd");
			recordClientTelemetry("client.acp.invoke.succeeded", {
				"tauri.command": "list_agents_cmd",
				"agent.count": agents.length,
			});
			return agents;
		} catch (e) {
			recordClientTelemetryError("client.acp.invoke.failed", e, {
				"tauri.command": "list_agents_cmd",
			});
			throw e;
		}
	},
	agentSkill: async () => {
		recordClientTelemetry("client.acp.invoke.started", {
			"tauri.command": "agent_skill_cmd",
		});
		try {
			const skill = await invoke<string>("agent_skill_cmd");
			recordClientTelemetry("client.acp.invoke.succeeded", {
				"tauri.command": "agent_skill_cmd",
				"agent_skill.length": skill.length,
			});
			return skill;
		} catch (e) {
			recordClientTelemetryError("client.acp.invoke.failed", e, {
				"tauri.command": "agent_skill_cmd",
			});
			throw e;
		}
	},
	startSession: async (req: { source: SessionSource; agent_kind: AgentKind }) => {
		recordClientTelemetry("client.acp.start_session.requested", {
			"agent.kind": req.agent_kind,
			"session.source.kind": req.source.kind,
		});
		try {
			const response = await invoke<StartSessionResponse>("start_session_cmd", {
				req,
			});
			recordClientTelemetry("client.acp.start_session.succeeded", {
				"agent.kind": req.agent_kind,
				"session.source.kind": req.source.kind,
				"acp.session_id": response.session_id,
				"repo.display_slug": response.repo.display_slug,
				"repo.base_ref": response.repo.base_ref,
				"repo.head_ref": response.repo.head_ref,
				"pull_request.has_metadata": !!response.pull_request,
				"pull_request.has_error": !!response.pull_request_error,
			});
			return response;
		} catch (e) {
			recordClientTelemetryError("client.acp.start_session.failed", e, {
				"agent.kind": req.agent_kind,
				"session.source.kind": req.source.kind,
			});
			throw e;
		}
	},
	parsePrUrl: (url: string) =>
		invoke<[string, string, number] | null>("parse_pr_url_cmd", { url }),
	listRecentProjects: () =>
		invoke<RecentProject[]>("list_recent_projects_cmd"),
	inspectLocalRepoOrigin: (path: string) =>
		invoke<LocalRepoOrigin>("inspect_local_repo_origin_cmd", { path }),
	sendMessage: async (
		session_id: string,
		text: string,
		options: SendMessageOptions = {},
	) => {
		recordClientTelemetry(
			"client.acp.send_message.requested",
			sendMessageTelemetryAttrs({ session_id, text, options }),
		);
		try {
			await invoke<void>("send_message_cmd", {
				sessionId: session_id,
				text,
				origin: options.origin,
				reason: options.reason,
				sectionId: options.sectionId,
				suppressPreview: options.suppressPreview,
			});
			recordClientTelemetry("client.acp.send_message.succeeded", {
				"acp.session_id": session_id,
				"message.origin": options.origin,
				"message.reason": options.reason,
				"section.id": options.sectionId,
				"message.length": text.length,
			});
		} catch (e) {
			recordClientTelemetryError("client.acp.send_message.failed", e, {
				"acp.session_id": session_id,
				"message.origin": options.origin,
				"message.reason": options.reason,
				"section.id": options.sectionId,
				"message.length": text.length,
			});
			throw e;
		}
	},
	endSession: (session_id: string) =>
		invoke<void>("end_session_cmd", { sessionId: session_id }),
	getFileAtRef: (args: {
		repo_path: string;
		file_path: string;
		refspec: string;
	}) => invoke<string | null>("get_file_at_ref_cmd", { args }),
	getDiff: (args: {
		repo_path: string;
		base_ref: string;
		head_ref: string;
		file_path?: string | null;
	}) => invoke<DiffPatch[]>("get_diff_cmd", { args }),
};

export type EventName =
	| "acp://section-map"
	| "acp://section"
	| "acp://text-chunk"
	| "acp://tool-call"
	| "acp://tool-call-update"
	| "acp://turn-done"
	| "acp://error"
	| "acp://comment-draft"
	| "acp://comment-result"
	| "acp://agent-stderr";

export function on<T>(name: EventName, handler: (payload: T) => void) {
	recordClientTelemetry("client.acp.listener.registering", {
		"acp.event_name": name,
	});
	return listen<T>(name, (e) => {
		recordClientTelemetry("client.acp.event.dispatched", {
			"acp.event_name": name,
			"acp.session_id": payloadSessionId(e.payload),
		});
		handler(e.payload);
	});
}

export type Unlisten = UnlistenFn;
