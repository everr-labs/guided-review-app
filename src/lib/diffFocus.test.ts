import assert from "node:assert/strict";
import test from "node:test";
import {
	createDiffFocusRange,
	diffLineSelectionFromCandidates,
	formatDiffFocusHeader,
	formatDiffReferenceForMessage,
	formatDiffReferenceLabel,
	normalizeLineRange,
	parseDiffFocusPayload,
} from "./diffFocus";

test("normalizeLineRange keeps ascending ranges and fixes reversed ranges", () => {
	assert.deepEqual(normalizeLineRange(4, 9), [4, 9]);
	assert.deepEqual(normalizeLineRange(9, 4), [4, 9]);
});

test("createDiffFocusRange rejects invalid lines", () => {
	assert.equal(
		createDiffFocusRange({
			file_path: "src/App.tsx",
			start_line: 0,
			end_line: 4,
			side: "RIGHT",
			source: "user",
			mode: "draft-reference",
		}),
		null,
	);
});

test("createDiffFocusRange normalizes and fills metadata", () => {
	const focus = createDiffFocusRange({
		file_path: "src/App.tsx",
		start_line: 12,
		end_line: 8,
		side: "RIGHT",
		source: "agent",
		mode: "navigation",
		reason: "Look here",
		now: 123,
		id: "focus-1",
	});

	assert.deepEqual(focus, {
		id: "focus-1",
		file_path: "src/App.tsx",
		start_line: 8,
		end_line: 12,
		side: "RIGHT",
		source: "agent",
		mode: "navigation",
		reason: "Look here",
		created_at: 123,
	});
});

test("formatters produce reference-only text", () => {
	const focus = createDiffFocusRange({
		id: "focus-1",
		file_path: "src/App.tsx",
		start_line: 42,
		end_line: 48,
		side: "RIGHT",
		source: "user",
		mode: "draft-reference",
		now: 123,
	});

	assert.ok(focus);
	assert.equal(formatDiffReferenceLabel(focus), "src/App.tsx:42-48 (new)");
	assert.equal(
		formatDiffReferenceForMessage(focus),
		"Referenced diff range: src/App.tsx:42-48 (new)",
	);
	assert.equal(
		formatDiffFocusHeader(focus),
		"Focused src/App.tsx:42-48 (new)",
	);
});

test("parseDiffFocusPayload accepts valid agent payloads", () => {
	assert.deepEqual(
		parseDiffFocusPayload({
			file_path: "src/App.tsx",
			start_line: 5,
			end_line: 5,
			side: "LEFT",
			reason: "Old behavior",
		}),
		{
			file_path: "src/App.tsx",
			start_line: 5,
			end_line: 5,
			side: "LEFT",
			reason: "Old behavior",
		},
	);
});

test("parseDiffFocusPayload rejects invalid agent payloads", () => {
	assert.equal(
		parseDiffFocusPayload({
			file_path: "src/App.tsx",
			start_line: 5,
			end_line: 6,
			side: "CENTER",
		}),
		null,
	);
});

test("diffLineSelectionFromCandidates uses direct and preferred gutter sides", () => {
	assert.deepEqual(
		diffLineSelectionFromCandidates({
			directOldLine: "12",
			rowOldLine: "12",
			rowNewLine: "13",
		}),
		{ lineNumber: 12, side: "LEFT" },
	);
	assert.deepEqual(
		diffLineSelectionFromCandidates({
			rowOldLine: "41",
			rowNewLine: "42",
			preferredSide: "RIGHT",
		}),
		{ lineNumber: 42, side: "RIGHT" },
	);
	assert.equal(
		diffLineSelectionFromCandidates({
			rowOldLine: "41",
			rowNewLine: "42",
		}),
		null,
	);
});
