import assert from "node:assert/strict";
import test from "node:test";
import {
	sectionFeedbackToDiffAnnotations,
	sectionFeedbackTopNotes,
} from "./sectionFeedback";
import type { ReviewSection } from "./types/section";

function section(overrides: Partial<ReviewSection> = {}): ReviewSection {
	return {
		schema_version: 1,
		section_id: "diff-feedback",
		title: "Diff feedback",
		intent: "Review inline feedback.",
		files: ["src/main.ts"],
		ranges: [],
		concerns: [],
		uncovered_scenarios: [],
		test_coverage_notes: "",
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "",
		...overrides,
	};
}

test("section concerns with file and line become diff annotations", () => {
	const annotations = sectionFeedbackToDiffAnnotations(
		section({
			concerns: [
				{
					text: "This can publish an empty pending review.",
					severity: "medium",
					file_path: "src/main.ts",
					line: 12,
				},
			],
		}),
		["src/main.ts"],
	);

	assert.equal(annotations.length, 1);
	assert.equal(annotations[0]?.lineNumber, 12);
	assert.equal(annotations[0]?.side, "additions");
	assert.deepEqual(annotations[0]?.metadata.notes, [
		{
			kind: "concern",
			label: "Concern",
			text: "This can publish an empty pending review.",
			severity: "medium",
			file_path: "src/main.ts",
			line: 12,
		},
	]);
});

test("uncovered scenarios with file and line become diff annotations", () => {
	const annotations = sectionFeedbackToDiffAnnotations(
		section({
			uncovered_scenarios: [
				{
					text: "No test covers a failed review submit.",
					severity: "low",
					file_path: "src/main.ts",
					line: 20,
				},
			],
		}),
		["src/main.ts"],
	);

	assert.equal(annotations.length, 1);
	assert.deepEqual(annotations[0]?.metadata.notes, [
		{
			kind: "uncovered_test",
			label: "Uncovered test",
			text: "No test covers a failed review submit.",
			severity: "low",
			file_path: "src/main.ts",
			line: 20,
		},
	]);
});

test("feedback without a line is shown in top notes", () => {
	const notes = sectionFeedbackTopNotes(
		section({
			concerns: [
				{
					text: "This section needs a broader error path check.",
					severity: "low",
				},
			],
		}),
		["src/main.ts"],
	);

	assert.deepEqual(notes, [
		{
			kind: "concern",
			label: "Concern",
			text: "This section needs a broader error path check.",
			severity: "low",
		},
	]);
});

test("test coverage notes are shown in top notes", () => {
	const notes = sectionFeedbackTopNotes(
		section({ test_coverage_notes: "Happy path is covered." }),
		["src/main.ts"],
	);

	assert.deepEqual(notes, [
		{
			kind: "test_coverage",
			label: "Test coverage",
			text: "Happy path is covered.",
		},
	]);
});

test("multiple feedback items on the same line are grouped", () => {
	const annotations = sectionFeedbackToDiffAnnotations(
		section({
			concerns: [
				{
					text: "This can fail silently.",
					severity: "medium",
					file_path: "src/main.ts",
					line: 12,
				},
			],
			uncovered_scenarios: [
				{
					text: "No test covers this failure.",
					severity: "low",
					file_path: "src/main.ts",
					line: 12,
				},
			],
		}),
		["src/main.ts"],
	);

	assert.equal(annotations.length, 1);
	assert.deepEqual(
		annotations[0]?.metadata.notes.map((note) => note.label),
		["Concern", "Uncovered test"],
	);
});

test("feedback for files outside the visible diff is shown in top notes", () => {
	const notes = sectionFeedbackTopNotes(
		section({
			concerns: [
				{
					text: "This concern points to a hidden file.",
					severity: "medium",
					file_path: "src/hidden.ts",
					line: 8,
				},
			],
		}),
		["src/main.ts"],
	);

	assert.deepEqual(notes, [
		{
			kind: "concern",
			label: "Concern",
			text: "This concern points to a hidden file.",
			severity: "medium",
			file_path: "src/hidden.ts",
			line: 8,
		},
	]);
});
