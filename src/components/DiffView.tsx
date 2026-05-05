import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { createPatch } from "diff";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { SeverityBadge } from "./SeverityBadge";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";
import { Button } from "@/components/ui/button";
import { LocateFixed, Plus, X } from "lucide-react";
import {
	createDiffFocusRange,
	diffLineSelectionFromCandidates,
	formatDiffFocusHeader,
	formatDiffReferenceLabel,
	normalizeLineRange,
	type DiffFocusRange,
	type DiffFocusSide,
} from "@/lib/diffFocus";

interface FileBundle {
	file_path: string;
	oldText: string;
	newText: string;
	patch: string;
}

const fileCache = new Map<string, string>();

function elementFromEventTarget(target: EventTarget | null): Element | null {
	if (target instanceof Element) return target;
	if (target instanceof Node) return target.parentElement;
	return null;
}

function lineNumberCellPreferredSide(
	cell: HTMLElement,
	clientX: number,
): DiffFocusSide {
	const rect = cell.getBoundingClientRect();
	return clientX < rect.left + rect.width / 2 ? "LEFT" : "RIGHT";
}

function findClickedLineNumber(
	target: EventTarget | null,
	clientX: number,
):
	| {
			lineNumber: number;
			side: DiffFocusSide;
	  }
	| null {
	const targetElement = elementFromEventTarget(target);
	if (!targetElement) return null;
	const lineNumberElement = targetElement.closest<HTMLElement>(
		"[data-line-old-num], [data-line-new-num]",
	);
	const lineNumberCell = targetElement.closest<HTMLElement>(".diff-line-num");
	if (!lineNumberElement && !lineNumberCell) return null;
	const rowElement = lineNumberCell?.closest<HTMLElement>("tr.diff-line");
	return diffLineSelectionFromCandidates({
		directOldLine: lineNumberElement?.getAttribute("data-line-old-num"),
		directNewLine: lineNumberElement?.getAttribute("data-line-new-num"),
		rowOldLine: rowElement
			?.querySelector<HTMLElement>("[data-line-old-num]")
			?.getAttribute("data-line-old-num"),
		rowNewLine: rowElement
			?.querySelector<HTMLElement>("[data-line-new-num]")
			?.getAttribute("data-line-new-num"),
		preferredSide: lineNumberCell
			? lineNumberCellPreferredSide(lineNumberCell, clientX)
			: null,
	});
}

function langFor(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		py: "python",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		rb: "ruby",
		md: "markdown",
		json: "json",
		yml: "yaml",
		yaml: "yaml",
		toml: "toml",
		sh: "bash",
		css: "css",
		scss: "scss",
		html: "html",
		svelte: "svelte",
		sql: "sql",
	};
	return map[ext] ?? "plaintext";
}

async function fetchFile(
	repoPath: string,
	filePath: string,
	refspec: string,
): Promise<string> {
	const key = `${repoPath}::${filePath}::${refspec}`;
	const cached = fileCache.get(key);
	if (cached !== undefined) return cached;
	const content = await acp.getFileAtRef({
		repo_path: repoPath,
		file_path: filePath,
		refspec,
	});
	const text = content ?? "";
	fileCache.set(key, text);
	return text;
}

function DiffFileCard({
	bundle,
	activeFocus,
	setDiffFocus,
	clearDiffFocus,
	addPendingDiffReference,
}: {
	bundle: FileBundle;
	activeFocus: DiffFocusRange | null;
	setDiffFocus: (range: DiffFocusRange | null) => void;
	clearDiffFocus: (id?: string) => void;
	addPendingDiffReference: (range: DiffFocusRange) => void;
}) {
	const cardRef = useRef<HTMLDivElement>(null);
	const [toolbarTop, setToolbarTop] = useState<number | null>(null);
	const focus =
		activeFocus?.file_path === bundle.file_path ? activeFocus : null;

	useEffect(() => {
		const root = cardRef.current;
		if (!root) return;

		const clearHighlights = () => {
			root
				.querySelectorAll<HTMLElement>(".gr-diff-focus-number")
				.forEach((el) => el.classList.remove("gr-diff-focus-number"));
			root
				.querySelectorAll<HTMLElement>(".gr-diff-focus-number-cell")
				.forEach((el) => el.classList.remove("gr-diff-focus-number-cell"));
			root
				.querySelectorAll<HTMLElement>(".gr-diff-focus-row")
				.forEach((el) => el.classList.remove("gr-diff-focus-row"));
			root
				.querySelectorAll<HTMLElement>(".gr-diff-focus-anchor")
				.forEach((el) => el.classList.remove("gr-diff-focus-anchor"));
		};

		clearHighlights();
		if (!focus) {
			setToolbarTop(null);
			return clearHighlights;
		}

		const [start, end] = normalizeLineRange(
			focus.start_line,
			focus.end_line,
		);
		const attr =
			focus.side === "LEFT" ? "data-line-old-num" : "data-line-new-num";
		const focusedRows: HTMLElement[] = [];

		root.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
			const lineNumber = Number(el.getAttribute(attr));
			if (lineNumber < start || lineNumber > end) return;
			el.classList.add("gr-diff-focus-number");
			el.closest("td")?.classList.add("gr-diff-focus-number-cell");
			if (lineNumber === (focus.anchor_line ?? focus.start_line)) {
				el.classList.add("gr-diff-focus-anchor");
			}
			const row = el.closest<HTMLElement>("tr");
			if (row) {
				row.classList.add("gr-diff-focus-row");
				focusedRows.push(row);
			}
		});

		const firstRow = focusedRows[0];
		const lastRow = focusedRows.at(-1);
		if (focus.source === "agent" && firstRow) {
			requestAnimationFrame(() => {
				firstRow?.scrollIntoView({ block: "center", behavior: "smooth" });
			});
		}

		if (lastRow) {
			const cardRect = root.getBoundingClientRect();
			const rowRect = lastRow.getBoundingClientRect();
			setToolbarTop(rowRect.bottom - cardRect.top);
		} else {
			setToolbarTop(null);
		}

		return clearHighlights;
	}, [focus]);

	function onDiffClick(e: ReactMouseEvent<HTMLDivElement>) {
		const clicked = findClickedLineNumber(e.target, e.clientX);
		if (!clicked) return;

		e.preventDefault();
		window.getSelection()?.removeAllRanges();

		const previous = activeFocus;
		const anchorLine =
			e.shiftKey &&
			previous?.source === "user" &&
			previous.file_path === bundle.file_path &&
			previous.side === clicked.side
				? previous.anchor_line ?? previous.start_line
				: clicked.lineNumber;

		const nextFocus = createDiffFocusRange({
			file_path: bundle.file_path,
			start_line: anchorLine,
			end_line: clicked.lineNumber,
			side: clicked.side,
			source: "user",
			mode: "draft-reference",
			anchor_line: anchorLine,
		});

		recordClientTelemetry("client.diff.focus.clicked", {
			"file.path": bundle.file_path,
			"line.number": clicked.lineNumber,
			"line.side": clicked.side,
			"line.shift_key": e.shiftKey,
		});

		setDiffFocus(nextFocus);
	}

	function addReference() {
		if (!focus) return;
		addPendingDiffReference(focus);
		recordClientTelemetry("client.diff.focus.reference_added", {
			"file.path": focus.file_path,
			"line.start": focus.start_line,
			"line.end": focus.end_line,
			"line.side": focus.side,
		});
		clearDiffFocus(focus.id);
	}

	function clearSelection() {
		if (focus) {
			recordClientTelemetry("client.diff.focus.cleared", {
				"file.path": focus.file_path,
				"line.start": focus.start_line,
				"line.end": focus.end_line,
				"line.side": focus.side,
			});
		}
		clearDiffFocus(focus?.id);
	}

	return (
		<div
			ref={cardRef}
			data-file-path={bundle.file_path}
			className="relative overflow-hidden rounded-md border border-border bg-card"
		>
			<div className="border-b border-border bg-muted/40 px-3 py-1.5 font-mono text-xs">
				{bundle.file_path}
			</div>
			<div onClick={onDiffClick}>
				<DiffView
					data={{
						oldFile: {
							fileName: bundle.file_path,
							fileLang: langFor(bundle.file_path),
							content: bundle.oldText,
						},
						newFile: {
							fileName: bundle.file_path,
							fileLang: langFor(bundle.file_path),
							content: bundle.newText,
						},
						hunks: [bundle.patch],
					}}
					diffViewMode={DiffModeEnum.Unified}
					diffViewWrap
					diffViewTheme="dark"
					diffViewHighlight
					diffViewFontSize={12}
				/>
			</div>
			{focus?.source === "user" &&
				focus.mode === "draft-reference" &&
				toolbarTop !== null && (
					<div
						className="pointer-events-none absolute left-0 right-0 z-10 flex justify-center px-3"
						style={{ top: toolbarTop + 4 }}
					>
						<div className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-lg">
							<span className="px-1 font-mono text-muted-foreground">
								{formatDiffReferenceLabel(focus)}
							</span>
							<Button size="sm" onClick={addReference}>
								<Plus className="size-3.5" />
								Add reference
							</Button>
							<Button size="sm" variant="outline" onClick={clearSelection}>
								<X className="size-3.5" />
								Clear
							</Button>
						</div>
					</div>
				)}
		</div>
	);
}

export function DiffPane() {
	const session = useApp((s) => s.session);
	const currentId = useApp((s) => s.currentSectionId);
	const sections = useApp((s) => s.sections);
	const diffFocus = useApp((s) => s.diffFocus);
	const diffFocusError = useApp((s) => s.diffFocusError);
	const setDiffFocus = useApp((s) => s.setDiffFocus);
	const clearDiffFocus = useApp((s) => s.clearDiffFocus);
	const setDiffFocusError = useApp((s) => s.setDiffFocusError);
	const addPendingDiffReference = useApp((s) => s.addPendingDiffReference);

	const current = useMemo(
		() => sections.find((s) => s.id === currentId) ?? null,
		[sections, currentId],
	);
	const section = current?.section ?? null;

	const [bundles, setBundles] = useState<FileBundle[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [agentFocusLabel, setAgentFocusLabel] = useState<string | null>(null);

	useEffect(() => {
		setAgentFocusLabel(null);
		const currentFocus = useApp.getState().diffFocus;
		if (currentFocus?.source === "user") {
			clearDiffFocus(currentFocus.id);
		}
	}, [currentId, clearDiffFocus]);

	useEffect(() => {
		setDiffFocusError(null);
	}, [currentId, setDiffFocusError]);

	useEffect(() => {
		if (diffFocus?.source !== "agent") return;
		const label = formatDiffFocusHeader(diffFocus);
		setAgentFocusLabel(label);
		const timeout = window.setTimeout(() => setAgentFocusLabel(null), 4500);
		return () => window.clearTimeout(timeout);
	}, [diffFocus]);

	useEffect(() => {
		if (!diffFocus || loading || loadError) return;
		const visible = bundles.some((b) => b.file_path === diffFocus.file_path);
		if (!visible) {
			setDiffFocusError(
				`${diffFocus.file_path} is not visible in the current diff section.`,
			);
		}
	}, [bundles, diffFocus, loading, loadError, setDiffFocusError]);

	useEffect(() => {
		recordClientTelemetry("client.diff.current_section.evaluated", {
			"acp.session_id": session?.session_id,
			"section.current_id": currentId,
			"section.has_entry": !!current,
			"section.has_payload": !!section,
			"section.file_count": section?.files.length,
		});
		if (!session || !section) {
			setBundles([]);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setLoadError(null);
		(async () => {
			try {
				recordClientTelemetry("client.diff.section_load.started", {
					"acp.session_id": session.session_id,
					"section.id": section.section_id,
					"section.file_count": section.files.length,
				});
				const out: FileBundle[] = [];
				for (const file of section.files) {
					recordClientTelemetry("client.diff.file_load.started", {
						"acp.session_id": session.session_id,
						"section.id": section.section_id,
						"file.path": file,
						"repo.base_ref": section.base_ref,
						"repo.head_ref": section.head_ref,
					});
					const [oldText, newText] = await Promise.all([
						fetchFile(session.repo.path, file, section.base_ref),
						fetchFile(session.repo.path, file, section.head_ref),
					]);
					recordClientTelemetry("client.diff.file_load.finished", {
						"acp.session_id": session.session_id,
						"section.id": section.section_id,
						"file.path": file,
						"file.old_length": oldText.length,
						"file.new_length": newText.length,
						"file.changed": oldText !== newText,
					});
					if (oldText === newText) continue;
					const patch = createPatch(
						file,
						oldText,
						newText,
						section.base_ref,
						section.head_ref,
					);
					out.push({ file_path: file, oldText, newText, patch });
				}
				if (!cancelled) {
					recordClientTelemetry("client.diff.section_load.succeeded", {
						"acp.session_id": session.session_id,
						"section.id": section.section_id,
						"diff.bundle_count": out.length,
					});
					setBundles(out);
				}
			} catch (e) {
				if (!cancelled) {
					recordClientTelemetryError("client.diff.section_load.failed", e, {
						"acp.session_id": session.session_id,
						"section.id": section.section_id,
					});
					setLoadError(String(e));
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [session, section, current, currentId]);

	if (!session || !current) {
		return (
			<section className="flex min-h-0 flex-col items-center justify-center text-sm text-muted-foreground">
				<p>Start a session to see the guided review.</p>
			</section>
		);
	}

	if (current && !section) {
		return (
			<section className="flex min-h-0 flex-col items-center justify-center px-8 text-sm text-muted-foreground">
				<p className="font-medium text-foreground">{current.title}</p>
				<p className="mt-1">{current.intent}</p>
				<p className="mt-3 text-xs">
					Ask the agent to walk you through this section.
				</p>
			</section>
		);
	}

	return (
		<section className="flex min-h-0 flex-col overflow-y-auto">
			<header className="border-b border-border bg-card/40 px-6 py-4">
				<h2 className="text-base font-semibold">{section!.title}</h2>
				<p className="mt-1 text-sm text-muted-foreground">{section!.intent}</p>
				<div className="mt-2 flex gap-3 font-mono text-[11px] text-muted-foreground">
					<span>
						<strong className="text-foreground/80">base:</strong>{" "}
						{section!.base_ref}
					</span>
					<span>
						<strong className="text-foreground/80">head:</strong>{" "}
						{section!.head_ref}
					</span>
				</div>
				{agentFocusLabel && (
					<div className="mt-2 inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[11px] text-primary">
						<LocateFixed className="size-3" />
						{agentFocusLabel}
					</div>
				)}
			</header>

			<div className="flex flex-col gap-4 p-4">
				{loading && (
					<div className="text-sm text-muted-foreground">Loading diff…</div>
				)}
				{loadError && (
					<div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
						{loadError}
					</div>
				)}
				{diffFocusError && (
					<div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary">
						{diffFocusError}
					</div>
				)}
				{!loading && !loadError && bundles.length === 0 && (
					<div className="rounded-md border border-border bg-card/40 px-4 py-3 text-sm text-muted-foreground">
						No textual changes in the listed files.
					</div>
				)}
				{bundles.map((b) => (
					<DiffFileCard
						key={b.file_path}
						bundle={b}
						activeFocus={diffFocus}
						setDiffFocus={setDiffFocus}
						clearDiffFocus={clearDiffFocus}
						addPendingDiffReference={addPendingDiffReference}
					/>
				))}
			</div>

			{(section!.concerns.length > 0 ||
				section!.uncovered_scenarios.length > 0 ||
				section!.test_coverage_notes) && (
				<div className="border-t border-border px-6 py-4">
					{section!.test_coverage_notes && (
						<div className="mb-4">
							<h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
								Test coverage
							</h3>
							<p className="text-sm">{section!.test_coverage_notes}</p>
						</div>
					)}
					{section!.concerns.length > 0 && (
						<div className="mb-4">
							<h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
								Concerns
							</h3>
							<ul className="space-y-1.5">
								{section!.concerns.map((c, i) => (
									<li key={i} className="flex items-baseline gap-2 text-sm">
										<SeverityBadge severity={c.severity} />
										<span className="flex-1">{c.text}</span>
										{c.file_path && (
											<span className="font-mono text-[11px] text-muted-foreground">
												{c.file_path}
												{c.line ? `:${c.line}` : ""}
											</span>
										)}
									</li>
								))}
							</ul>
						</div>
					)}
					{section!.uncovered_scenarios.length > 0 && (
						<div>
							<h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
								Uncovered scenarios
							</h3>
							<ul className="space-y-1.5">
								{section!.uncovered_scenarios.map((c, i) => (
									<li key={i} className="flex items-baseline gap-2 text-sm">
										<SeverityBadge severity={c.severity} />
										<span className="flex-1">{c.text}</span>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}

			{section!.pause_prompt && (
				<div className="m-4 rounded-md border-l-2 border-primary bg-primary/10 px-4 py-2.5 text-sm text-primary">
					{section!.pause_prompt}
				</div>
			)}
		</section>
	);
}
