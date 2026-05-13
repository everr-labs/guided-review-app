import assert from "node:assert/strict";
import test from "node:test";
import {
	assistantPartsToBlocks,
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

test("assistantPartsToBlocks splits markdown and tool calls into separate blocks", () => {
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

	assert.deepEqual(assistantPartsToBlocks(parts), [
		{ type: "markdown", markdown: "I will check" },
		{
			type: "tool_call",
			toolCall: {
				tool_call_id: "tool-1",
				title: "Search repo",
				kind: "search",
				status: "in_progress",
			},
		},
		{ type: "markdown", markdown: "and explain." },
	]);
});

test("assistantPartsToBlocks drops whitespace-only markdown segments", () => {
	const parts: ChatMessagePart[] = [
		{ type: "markdown", text: "   \n\n" },
		{
			type: "tool_call",
			toolCall: {
				tool_call_id: "tool-1",
				title: "Read file",
				kind: "read",
				status: "completed",
			},
		},
	];

	assert.deepEqual(assistantPartsToBlocks(parts), [
		{
			type: "tool_call",
			toolCall: {
				tool_call_id: "tool-1",
				title: "Read file",
				kind: "read",
				status: "completed",
			},
		},
	]);
});

test("assistantPartsToBlocks scrubs leftover acp-section-map fences", () => {
	const parts: ChatMessagePart[] = [
		{
			type: "markdown",
			text: "Here is the map:\n\n```acp-section-map\n{\"sections\": []}\n```\n\nDone.",
		},
	];

	assert.deepEqual(assistantPartsToBlocks(parts), [
		{ type: "markdown", markdown: "Here is the map:\n\nDone." },
	]);
});
