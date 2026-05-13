import assert from "node:assert/strict";
import test from "node:test";
import {
	parseReviewSectionPayload,
	parseSectionMapPayload,
	parseSectionProgressPayload,
} from "./reviewSectionPayload";

test("parseSectionMapPayload accepts section files and ignores agent ranges", () => {
	const map = parseSectionMapPayload({
		sections: [
			{
				section_id: "validation-flow",
				title: "Validation flow",
				intent: "Checks before saving.",
				files: ["src/lib/store.ts"],
				ranges: [
					{
						file_path: "src/lib/store.ts",
						start_line: 10,
						end_line: 20,
						kind: "changed-new",
					},
				],
			},
		],
	});

	assert.deepEqual(map, {
		schema_version: 1,
		sections: [
			{
				section_id: "validation-flow",
				title: "Validation flow",
				intent: "Checks before saving.",
				files: ["src/lib/store.ts"],
			},
		],
	});
});

test("parseReviewSectionPayload accepts feedback-only sections", () => {
	const section = parseReviewSectionPayload({
		section_id: "validation-flow",
		concerns: [
			{
				text: "Empty input can still be submitted.",
				severity: "medium",
				file_path: "src/lib/store.ts",
				line: 148,
			},
		],
		pause_prompt: "Want to leave a comment?",
	});

	assert.equal(section?.section_id, "validation-flow");
	assert.equal(section?.title, "");
	assert.deepEqual(section?.files, []);
	assert.deepEqual(section?.ranges, []);
	assert.deepEqual(section?.concerns, [
		{
			text: "Empty input can still be submitted.",
			severity: "medium",
			file_path: "src/lib/store.ts",
			line: 148,
		},
	]);
	assert.equal(section?.pause_prompt, "Want to leave a comment?");
});

test("parseReviewSectionPayload accepts unimportant ranges with reasons", () => {
	const section = parseReviewSectionPayload({
		section_id: "ui-noise",
		title: "UI noise",
		intent: "Small visual-only changes.",
		files: ["src/App.tsx"],
		unimportant_ranges: [
			{
				file_path: "src/App.tsx",
				start_line: 10,
				end_line: 24,
				kind: "changed-new",
				reason: "Import ordering only.",
			},
		],
		concerns: [],
		base_ref: "base",
		head_ref: "head",
	});

	assert.deepEqual(section?.ranges, []);
	assert.deepEqual(section?.unimportant_ranges, [
		{
			file_path: "src/App.tsx",
			start_line: 10,
			end_line: 24,
			kind: "changed-new",
			reason: "Import ordering only.",
		},
	]);
});

test("parseSectionProgressPayload accepts progressive range updates", () => {
	const update = parseSectionProgressPayload({
		section_id: "validation-flow",
		phase: "ranges",
		title: "Validation flow",
		intent: "Checks that happen before saving.",
		files: ["src/lib/store.ts"],
		ranges: [
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	});

	assert.deepEqual(update, {
		section_id: "validation-flow",
		phase: "ranges",
		title: "Validation flow",
		intent: "Checks that happen before saving.",
		files: ["src/lib/store.ts"],
		ranges: [
			{
				file_path: "src/lib/store.ts",
				start_line: 120,
				end_line: 180,
				kind: "changed-new",
			},
		],
	});
});

test("parseReviewSectionPayload keeps malformed unimportant ranges out", () => {
	const section = parseReviewSectionPayload({
		section_id: "ui-noise",
		title: "UI noise",
		intent: "Small visual-only changes.",
		files: ["src/App.tsx"],
		unimportant_ranges: [
			{
				file_path: "src/App.tsx",
				start_line: 10,
				end_line: 24,
				kind: "changed-new",
			},
			{
				file_path: "src/App.tsx",
				start_line: 30,
				end_line: 31,
				kind: "changed-new",
				reason: "Whitespace only.",
			},
		],
		concerns: [],
		base_ref: "base",
		head_ref: "head",
	});

	assert.deepEqual(section?.unimportant_ranges, [
		{
			file_path: "src/App.tsx",
			start_line: 30,
			end_line: 31,
			kind: "changed-new",
			reason: "Whitespace only.",
		},
	]);
});
