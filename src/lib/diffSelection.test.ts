import assert from "node:assert/strict";
import test from "node:test";

import {
	buildSelectionFocusRange,
	resolveSelectionSide,
} from "./diffSelection";

test("resolveSelectionSide picks the endpoint that is a change line", () => {
	assert.equal(
		resolveSelectionSide(
			{ line: 10, type: "context" },
			{ line: 12, type: "change-addition" },
		),
		"RIGHT",
	);
	assert.equal(
		resolveSelectionSide(
			{ line: 4, type: "change-deletion" },
			{ line: 6, type: "context" },
		),
		"LEFT",
	);
});

test("resolveSelectionSide defaults to RIGHT for context-only selections", () => {
	assert.equal(
		resolveSelectionSide(
			{ line: 10, type: "context" },
			{ line: 12, type: "context-expanded" },
		),
		"RIGHT",
	);
});

test("buildSelectionFocusRange normalizes reversed selections", () => {
	const range = buildSelectionFocusRange({
		file_path: "src/foo.ts",
		start: { line: 25, type: "change-addition" },
		end: { line: 18, type: "change-addition" },
		now: 1700000000000,
		id: "fixed-id",
	});

	assert.ok(range, "expected a range");
	assert.equal(range?.start_line, 18);
	assert.equal(range?.end_line, 25);
	assert.equal(range?.side, "RIGHT");
	assert.equal(range?.file_path, "src/foo.ts");
	assert.equal(range?.source, "user");
	assert.equal(range?.mode, "draft-reference");
});

test("buildSelectionFocusRange uses the end side when start is context", () => {
	const range = buildSelectionFocusRange({
		file_path: "src/foo.ts",
		start: { line: 4, type: "context" },
		end: { line: 9, type: "change-deletion" },
		id: "fixed-id",
	});

	assert.equal(range?.side, "LEFT");
	assert.equal(range?.start_line, 4);
	assert.equal(range?.end_line, 9);
});
