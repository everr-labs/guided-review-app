import type { AgentKind } from "./acp";

export const SELECTED_AGENT_KIND_KEY = "gr.selectedAgentKind";

const VALID_AGENT_KINDS = ["claude_code", "codex"] as const satisfies readonly AgentKind[];

function isAgentKind(value: string): value is AgentKind {
	return VALID_AGENT_KINDS.includes(value as AgentKind);
}

export function loadSelectedAgentKind(
	storage: Storage = localStorage,
): AgentKind | null {
	try {
		const value = storage.getItem(SELECTED_AGENT_KIND_KEY)?.trim() ?? "";
		return isAgentKind(value) ? value : null;
	} catch {
		return null;
	}
}

export function saveSelectedAgentKind(
	kind: AgentKind,
	storage: Storage = localStorage,
): void {
	try {
		storage.setItem(SELECTED_AGENT_KIND_KEY, kind);
	} catch {}
}
