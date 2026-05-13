import type { ChatMessagePart, ToolCallItem } from "./types/section";
import { cleanVisibleStructuredText } from "./store";

export type AssistantBlock =
	| { type: "markdown"; markdown: string }
	| { type: "tool_call"; toolCall: ToolCallItem };

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

export function assistantPartsToBlocks(
	parts: ChatMessagePart[],
): AssistantBlock[] {
	const blocks: AssistantBlock[] = [];
	let buffer = "";

	const flushMarkdown = () => {
		if (!buffer) return;
		const cleaned = cleanVisibleStructuredText(buffer).trim();
		buffer = "";
		if (!cleaned) return;
		blocks.push({ type: "markdown", markdown: cleaned });
	};

	for (const part of parts) {
		if (part.type === "markdown") {
			buffer += part.text;
			continue;
		}
		flushMarkdown();
		blocks.push({ type: "tool_call", toolCall: part.toolCall });
	}
	flushMarkdown();

	return blocks;
}
