import {
	createDiffFocusRange,
	normalizeLineRange,
	type DiffFocusRange,
	type DiffFocusSide,
} from "@/lib/diffFocus";

type DiffLineType =
	| "change-deletion"
	| "change-addition"
	| "context"
	| "context-expanded";

export interface DiffLineEndpoint {
	line: number;
	type: DiffLineType;
}

export function closestDiffLineEndpoint(
	node: Node | null,
): DiffLineEndpoint | null {
	let current: Node | null = node;
	while (current) {
		if (current instanceof Element && current.hasAttribute("data-line")) {
			const line = Number.parseInt(
				current.getAttribute("data-line") ?? "",
				10,
			);
			if (!Number.isInteger(line) || line < 1) return null;
			const rawType = current.getAttribute("data-line-type") ?? "";
			if (!isDiffLineType(rawType)) return null;
			return { line, type: rawType };
		}
		current = current.parentNode;
	}
	return null;
}

function isDiffLineType(value: string): value is DiffLineType {
	return (
		value === "change-deletion" ||
		value === "change-addition" ||
		value === "context" ||
		value === "context-expanded"
	);
}

function endpointSide(endpoint: DiffLineEndpoint): DiffFocusSide | null {
	if (endpoint.type === "change-deletion") return "LEFT";
	if (endpoint.type === "change-addition") return "RIGHT";
	return null;
}

export function resolveSelectionSide(
	start: DiffLineEndpoint,
	end: DiffLineEndpoint,
): DiffFocusSide {
	return endpointSide(end) ?? endpointSide(start) ?? "RIGHT";
}

export function buildSelectionFocusRange(input: {
	file_path: string;
	start: DiffLineEndpoint;
	end: DiffLineEndpoint;
	now?: number;
	id?: string;
}): DiffFocusRange | null {
	const [start, end] = normalizeLineRange(input.start.line, input.end.line);
	const side = resolveSelectionSide(input.start, input.end);
	return createDiffFocusRange({
		id: input.id,
		file_path: input.file_path,
		start_line: start,
		end_line: end,
		side,
		source: "user",
		mode: "draft-reference",
		now: input.now,
	});
}

function shadowSelection(host: HTMLElement): Selection | null {
	const shadowRoot = host.shadowRoot;
	if (!shadowRoot) return null;
	const getter = (shadowRoot as unknown as { getSelection?: () => Selection | null })
		.getSelection;
	if (typeof getter === "function") return getter.call(shadowRoot);
	return null;
}

export function resolveDiffSelectionRange(
	host: HTMLElement,
	filePath: string,
): DiffFocusRange | null {
	const selection = shadowSelection(host) ?? window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
		return null;
	}
	const range = selection.getRangeAt(0);
	const start = closestDiffLineEndpoint(range.startContainer);
	const end = closestDiffLineEndpoint(range.endContainer);
	if (!start || !end) return null;
	return buildSelectionFocusRange({
		file_path: filePath,
		start,
		end,
	});
}
