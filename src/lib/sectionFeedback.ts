import type { DiffLineAnnotation } from "@pierre/diffs";
import type { Concern, ReviewSection, Severity } from "./types/section";

export type SectionFeedbackKind =
	| "concern"
	| "uncovered_test"
	| "test_coverage";

export interface SectionFeedbackNote {
	kind: SectionFeedbackKind;
	label: "Concern" | "Uncovered test" | "Test coverage";
	text: string;
	severity?: Severity;
	file_path?: string;
	line?: number;
}

export interface SectionFeedbackAnnotationMetadata {
	kind: "section_feedback";
	file_path: string;
	line: number;
	notes: SectionFeedbackNote[];
}

function visibleFileSet(visibleFiles: Iterable<string>): Set<string> {
	return visibleFiles instanceof Set ? visibleFiles : new Set(visibleFiles);
}

function concernNote(
	kind: "concern" | "uncovered_test",
	label: "Concern" | "Uncovered test",
	concern: Concern,
): SectionFeedbackNote | null {
	const text = concern.text.trim();
	if (!text) return null;
	const note: SectionFeedbackNote = {
		kind,
		label,
		text,
		severity: concern.severity,
	};
	if (concern.file_path) note.file_path = concern.file_path;
	if (typeof concern.line === "number") note.line = concern.line;
	return note;
}

function lineFeedbackNotes(section: ReviewSection): SectionFeedbackNote[] {
	return [
		...section.concerns.map((concern) =>
			concernNote("concern", "Concern", concern),
		),
		...section.uncovered_scenarios.map((scenario) =>
			concernNote("uncovered_test", "Uncovered test", scenario),
		),
	].filter((note): note is SectionFeedbackNote => note !== null);
}

function testCoverageNote(section: ReviewSection): SectionFeedbackNote | null {
	const text = section.test_coverage_notes.trim();
	if (!text) return null;
	return {
		kind: "test_coverage",
		label: "Test coverage",
		text,
	};
}

function hasVisibleLine(
	note: SectionFeedbackNote,
	visibleFiles: Set<string>,
): note is SectionFeedbackNote & { file_path: string; line: number } {
	return (
		!!note.file_path &&
		typeof note.line === "number" &&
		note.line > 0 &&
		visibleFiles.has(note.file_path)
	);
}

export function sectionFeedbackToDiffAnnotations(
	section: ReviewSection,
	visibleFiles: Iterable<string>,
): DiffLineAnnotation<SectionFeedbackAnnotationMetadata>[] {
	const visible = visibleFileSet(visibleFiles);
	const groups = new Map<
		string,
		{ file_path: string; line: number; notes: SectionFeedbackNote[] }
	>();

	for (const note of lineFeedbackNotes(section)) {
		if (!hasVisibleLine(note, visible)) continue;
		const key = `${note.file_path}\0${note.line}`;
		const group =
			groups.get(key) ??
			{ file_path: note.file_path, line: note.line, notes: [] };
		group.notes.push(note);
		groups.set(key, group);
	}

	return Array.from(groups.values()).map((group) => ({
		lineNumber: group.line,
		side: "additions",
		metadata: {
			kind: "section_feedback",
			file_path: group.file_path,
			line: group.line,
			notes: group.notes,
		},
	}));
}

export function sectionFeedbackTopNotes(
	section: ReviewSection,
	visibleFiles: Iterable<string>,
): SectionFeedbackNote[] {
	const visible = visibleFileSet(visibleFiles);
	const notes: SectionFeedbackNote[] = [];
	const coverage = testCoverageNote(section);
	if (coverage) notes.push(coverage);

	for (const note of lineFeedbackNotes(section)) {
		if (hasVisibleLine(note, visible)) continue;
		notes.push(note);
	}

	return notes;
}
