import assert from "node:assert/strict";
import test from "node:test";
import {
	assistantPartsToMarkdown,
	stripMarkdownForSummary,
} from "./markdownContent";
import type { ChatMessagePart } from "./types/section";

test("stripMarkdownForSummary removes markdown markers for compact section labels", () => {
	assert.equal(
		stripMarkdownForSummary(
			"**Why this matters:** checks `login` changes.\n\n- Makes sure users can still sign in.",
		),
		"Why this matters: checks login changes. Makes sure users can still sign in.",
	);
});

test("assistantPartsToMarkdown keeps inline tool calls between markdown text", () => {
	const parts: ChatMessagePart[] = [
		{ type: "markdown", text: "I will check" },
		{
			type: "tool_call",
			toolCall: {
				tool_call_id: "tool-1",
				title: "Search repo",
				kind: "search",
				status: "in_progress",
			},
		},
		{ type: "markdown", text: " and explain." },
	];

	assert.deepEqual(assistantPartsToMarkdown(parts), {
		markdown: "I will check [Search repo](#gr-tool-call-tool-1) and explain.",
		toolCalls: [
			{
				tool_call_id: "tool-1",
				title: "Search repo",
				kind: "search",
				status: "in_progress",
			},
		],
	});
});
