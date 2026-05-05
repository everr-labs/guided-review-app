export type DiffFocusSide = "LEFT" | "RIGHT";
export type DiffFocusSource = "user" | "agent";
export type DiffFocusMode = "draft-reference" | "navigation";

export interface DiffFocusRange {
	id: string;
	file_path: string;
	start_line: number;
	end_line: number;
	side: DiffFocusSide;
	source: DiffFocusSource;
	mode: DiffFocusMode;
	reason?: string;
	created_at: number;
	anchor_line?: number;
}

export interface CreateDiffFocusRangeInput {
	id?: string;
	file_path: string;
	start_line: number;
	end_line: number;
	side: DiffFocusSide;
	source: DiffFocusSource;
	mode: DiffFocusMode;
	reason?: string;
	now?: number;
	anchor_line?: number;
}

export interface DiffFocusPayload {
	file_path: string;
	start_line: number;
	end_line: number;
	side: DiffFocusSide;
	reason?: string;
}

export interface DiffLineSelectionCandidates {
	directOldLine?: string | null;
	directNewLine?: string | null;
	rowOldLine?: string | null;
	rowNewLine?: string | null;
	preferredSide?: DiffFocusSide | null;
}

export interface DiffLineSelection {
	lineNumber: number;
	side: DiffFocusSide;
}

export function normalizeLineRange(start: number, end: number): [number, number] {
	return start <= end ? [start, end] : [end, start];
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) >= 1;
}

function isDiffFocusSide(value: unknown): value is DiffFocusSide {
	return value === "LEFT" || value === "RIGHT";
}

function sideLabel(side: DiffFocusSide): string {
	return side === "LEFT" ? "old" : "new";
}

function rangeRef(
	range: Pick<
		DiffFocusRange,
		"file_path" | "start_line" | "end_line" | "side"
	>,
): string {
	const [start, end] = normalizeLineRange(range.start_line, range.end_line);
	const suffix = start === end ? `${start}` : `${start}-${end}`;
	return `${range.file_path}:${suffix} (${sideLabel(range.side)})`;
}

function parseLineNumber(value?: string | null): number | null {
	if (!value) return null;
	const lineNumber = Number(value);
	return isPositiveInteger(lineNumber) ? lineNumber : null;
}

export function createDiffFocusRange(
	input: CreateDiffFocusRangeInput,
): DiffFocusRange | null {
	const filePath = input.file_path.trim();
	if (!filePath) return null;
	if (
		!isPositiveInteger(input.start_line) ||
		!isPositiveInteger(input.end_line)
	) {
		return null;
	}
	if (!isDiffFocusSide(input.side)) return null;

	const [startLine, endLine] = normalizeLineRange(
		input.start_line,
		input.end_line,
	);
	const reason = input.reason?.trim();
	const range: DiffFocusRange = {
		id: input.id ?? crypto.randomUUID(),
		file_path: filePath,
		start_line: startLine,
		end_line: endLine,
		side: input.side,
		source: input.source,
		mode: input.mode,
		created_at: input.now ?? Date.now(),
	};
	if (reason) range.reason = reason;
	if (input.anchor_line !== undefined) range.anchor_line = input.anchor_line;
	return range;
}

export function parseDiffFocusPayload(raw: unknown): DiffFocusPayload | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const filePath =
		typeof record.file_path === "string" ? record.file_path.trim() : "";
	const startLine = record.start_line;
	const endLine = record.end_line;
	const side = record.side;
	const reason = record.reason;

	if (!filePath || !isPositiveInteger(startLine) || !isPositiveInteger(endLine)) {
		return null;
	}
	if (!isDiffFocusSide(side)) return null;

	const payload: DiffFocusPayload = {
		file_path: filePath,
		start_line: startLine,
		end_line: endLine,
		side,
	};
	if (typeof reason === "string" && reason.trim()) {
		payload.reason = reason.trim();
	}
	return payload;
}

export function formatDiffReferenceLabel(range: DiffFocusRange): string {
	return rangeRef(range);
}

export function formatDiffReferenceForMessage(range: DiffFocusRange): string {
	return `Referenced diff range: ${rangeRef(range)}`;
}

export function formatDiffFocusHeader(range: DiffFocusRange): string {
	return `Focused ${rangeRef(range)}`;
}

export function diffLineSelectionFromCandidates(
	candidates: DiffLineSelectionCandidates,
): DiffLineSelection | null {
	const directOld = parseLineNumber(candidates.directOldLine);
	if (directOld !== null) return { lineNumber: directOld, side: "LEFT" };

	const directNew = parseLineNumber(candidates.directNewLine);
	if (directNew !== null) return { lineNumber: directNew, side: "RIGHT" };

	const rowOld = parseLineNumber(candidates.rowOldLine);
	const rowNew = parseLineNumber(candidates.rowNewLine);
	if (candidates.preferredSide === "LEFT") {
		if (rowOld !== null) return { lineNumber: rowOld, side: "LEFT" };
		if (rowNew !== null) return { lineNumber: rowNew, side: "RIGHT" };
	}
	if (candidates.preferredSide === "RIGHT") {
		if (rowNew !== null) return { lineNumber: rowNew, side: "RIGHT" };
		if (rowOld !== null) return { lineNumber: rowOld, side: "LEFT" };
	}

	return null;
}
