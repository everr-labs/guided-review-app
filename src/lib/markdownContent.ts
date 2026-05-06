import type { ChatMessagePart, ToolCallItem } from "./types/section";

const TOOL_CALL_LINK_PREFIX = "#gr-tool-call-";

function escapeMarkdownLinkText(text: string): string {
	return text.replace(/([\\[\]])/g, "\\$1");
}

export function toolCallHref(id: string): string {
	return `${TOOL_CALL_LINK_PREFIX}${encodeURIComponent(id)}`;
}

export function toolCallIdFromHref(href: string | undefined): string | null {
	if (!href?.startsWith(TOOL_CALL_LINK_PREFIX)) return null;
	return decodeURIComponent(href.slice(TOOL_CALL_LINK_PREFIX.length));
}

export function stripMarkdownForSummary(markdown: string): string {
	return markdown
		.replace(/```[a-zA-Z0-9_-]*\r?\n?/g, " ")
		.replace(/```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "")
		.replace(/<[^>]*>/g, "")
		.replace(/[*_~]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function assistantPartsToMarkdown(parts: ChatMessagePart[]): {
	markdown: string;
	toolCalls: ToolCallItem[];
} {
	let markdown = "";
	const toolCalls: ToolCallItem[] = [];

	for (const part of parts) {
		if (part.type === "markdown") {
			markdown += part.text;
			continue;
		}

		toolCalls.push(part.toolCall);
		const leadingSpace = markdown && !/\s$/.test(markdown) ? " " : "";
		markdown += `${leadingSpace}[${escapeMarkdownLinkText(
			part.toolCall.title,
		)}](${toolCallHref(part.toolCall.tool_call_id)})`;
	}

	return { markdown, toolCalls };
}
