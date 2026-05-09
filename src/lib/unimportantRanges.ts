import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { RangeKind, UnimportantRange } from "./types/section";

type DiffSide = "additions" | "deletions";

export interface ProtectedDiffLines {
	additions: Set<number>;
	deletions: Set<number>;
}

interface RowPair {
	gutter: HTMLElement;
	content: HTMLElement;
}

export function rangeSides(kind: RangeKind): DiffSide[] {
	switch (kind) {
		case "changed-old":
		case "removed":
			return ["deletions"];
		case "changed-new":
		case "added":
			return ["additions"];
		case "context":
			return ["additions", "deletions"];
	}
}

export function rangeFoldId(range: UnimportantRange): string {
	return `${range.file_path}:${range.kind}:${range.start_line}-${range.end_line}:${range.reason}`;
}

export function visibleUnimportantRangesForFile(
	ranges: UnimportantRange[] | null | undefined,
	filePath: string,
): UnimportantRange[] {
	if (!Array.isArray(ranges)) return [];
	return ranges.filter(
		(range) =>
			range.file_path === filePath &&
			range.start_line > 0 &&
			range.end_line >= range.start_line &&
			range.reason.trim().length > 0,
	);
}

export function protectedLinesFromAnnotations(
	annotations: DiffLineAnnotation<unknown>[],
	selectedLines: SelectedLineRange | null,
): ProtectedDiffLines {
	const protectedLines: ProtectedDiffLines = {
		additions: new Set(),
		deletions: new Set(),
	};
	for (const annotation of annotations) {
		protectedLines[annotation.side].add(annotation.lineNumber);
	}
	if (selectedLines?.side) {
		const end = selectedLines.end ?? selectedLines.start;
		for (let line = selectedLines.start; line <= end; line++) {
			protectedLines[selectedLines.side].add(line);
		}
	}
	return protectedLines;
}

export function applyUnimportantRangeFolds(
	node: HTMLElement,
	ranges: UnimportantRange[],
	protectedLines: ProtectedDiffLines,
	revealRange: (id: string) => void,
): void {
	const root = node.shadowRoot;
	if (!root) return;
	resetUnimportantFolds(root);
	if (ranges.length === 0) return;

	const code = root.querySelector("[data-code][data-unified]");
	const gutter = code?.querySelector("[data-gutter]");
	const content = code?.querySelector("[data-content]");
	if (!(gutter instanceof HTMLElement) || !(content instanceof HTMLElement)) {
		return;
	}

	const pairs = pairedRows(gutter, content);
	for (const range of ranges) {
		const foldId = rangeFoldId(range);
		const hiddenRows = pairs.filter(
			(pair) =>
				!pair.content.hidden &&
				rowMatchesRange(pair.content, range) &&
				!rowTouchesProtectedLine(pair.content, range, protectedLines),
		);
		if (hiddenRows.length === 0) continue;
		for (const pair of hiddenRows) {
			hideRow(pair, foldId);
		}
		insertFoldRow({
			gutter,
			content,
			before: hiddenRows[0],
			range,
			foldId,
			hiddenLineCount: hiddenRows.length,
			revealRange,
		});
	}
}

function resetUnimportantFolds(root: ShadowRoot): void {
	for (const element of root.querySelectorAll("[data-unimportant-hidden]")) {
		if (element instanceof HTMLElement) {
			element.hidden = false;
			delete element.dataset.unimportantHidden;
		}
	}
	for (const element of root.querySelectorAll("[data-unimportant-fold]")) {
		element.remove();
	}
}

function pairedRows(gutter: HTMLElement, content: HTMLElement): RowPair[] {
	const gutterRows = Array.from(gutter.children);
	const contentRows = Array.from(content.children);
	const pairs: RowPair[] = [];
	for (let i = 0; i < Math.min(gutterRows.length, contentRows.length); i++) {
		const gutterRow = gutterRows[i];
		const contentRow = contentRows[i];
		if (gutterRow instanceof HTMLElement && contentRow instanceof HTMLElement) {
			pairs.push({ gutter: gutterRow, content: contentRow });
		}
	}
	return pairs;
}

function hideRow(pair: RowPair, foldId: string): void {
	pair.gutter.hidden = true;
	pair.content.hidden = true;
	pair.gutter.dataset.unimportantHidden = foldId;
	pair.content.dataset.unimportantHidden = foldId;
}

function insertFoldRow({
	gutter,
	content,
	before,
	range,
	foldId,
	hiddenLineCount,
	revealRange,
}: {
	gutter: HTMLElement;
	content: HTMLElement;
	before: RowPair;
	range: UnimportantRange;
	foldId: string;
	hiddenLineCount: number;
	revealRange: (id: string) => void;
}): void {
	const gutterFold = createFoldRow(range, foldId, hiddenLineCount, revealRange);
	const contentFold = document.createElement("div");
	contentFold.dataset.separator = "line-info-basic";
	contentFold.dataset.unimportantFold = foldId;
	gutter.insertBefore(gutterFold, before.gutter);
	content.insertBefore(contentFold, before.content);
}

function createFoldRow(
	range: UnimportantRange,
	foldId: string,
	hiddenLineCount: number,
	revealRange: (id: string) => void,
): HTMLElement {
	const row = document.createElement("div");
	row.dataset.separator = "line-info-basic";
	row.dataset.unimportantFold = foldId;

	const wrapper = document.createElement("div");
	wrapper.dataset.separatorWrapper = "";

	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "Show";
	button.title = "Show hidden lines";
	button.style.cssText =
		"appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:0 1ch;text-decoration:underline;";
	button.addEventListener("click", () => revealRange(foldId));

	const reason = document.createElement("span");
	reason.dataset.separatorContent = "";
	reason.textContent = `${hiddenLineCount} less important line${
		hiddenLineCount === 1 ? "" : "s"
	} hidden: ${range.reason}`;

	wrapper.append(button, reason);
	row.appendChild(wrapper);
	return row;
}

function rowMatchesRange(row: HTMLElement, range: UnimportantRange): boolean {
	return rangeSides(range.kind).some((side) => {
		const line = lineNumberForSide(row, side);
		return (
			typeof line === "number" &&
			line >= range.start_line &&
			line <= range.end_line
		);
	});
}

function rowTouchesProtectedLine(
	row: HTMLElement,
	range: UnimportantRange,
	protectedLines: ProtectedDiffLines,
): boolean {
	return rangeSides(range.kind).some((side) => {
		const line = lineNumberForSide(row, side);
		return typeof line === "number" && protectedLines[side].has(line);
	});
}

function lineNumberForSide(row: HTMLElement, side: DiffSide): number | null {
	const lineType = row.dataset.lineType;
	const primary = numberFromDataset(row.dataset.line);
	const alt = numberFromDataset(row.dataset.altLine);
	if (side === "additions") {
		if (lineType === "change-deletion") return null;
		return primary;
	}
	if (lineType === "change-addition") return null;
	return alt ?? primary;
}

function numberFromDataset(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
