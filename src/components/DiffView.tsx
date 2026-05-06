import { useCallback, useEffect, useMemo, useState } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";
import { LocateFixed, X } from "lucide-react";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { SeverityBadge } from "./SeverityBadge";
import { Button } from "@/components/ui/button";
import {
	createDiffFocusRange,
	focusSideToPierreSide,
	formatDiffFocusHeader,
	formatDiffReferenceLabel,
	pierreSideToFocusSide,
	type DiffFocusRange,
} from "@/lib/diffFocus";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";

interface FileBundle {
	file_path: string;
	oldText: string;
	newText: string;
}

const fileCache = new Map<string, string>();

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

function pierreRangeToFocus(
	range: SelectedLineRange,
	filePath: string,
): DiffFocusRange | null {
	const endSide = range.endSide ?? range.side;
	if (!endSide) return null;
	return createDiffFocusRange({
		file_path: filePath,
		start_line: range.start,
		end_line: range.end,
		side: pierreSideToFocusSide(endSide),
		source: "user",
		mode: "draft-reference",
	});
}

function DiffFileCard({ bundle }: { bundle: FileBundle }) {
	const focus = useApp((s) =>
		s.diffFocus?.file_path === bundle.file_path ? s.diffFocus : null,
	);

	const oldFile = useMemo(
		() => ({ name: bundle.file_path, contents: bundle.oldText }),
		[bundle.file_path, bundle.oldText],
	);
	const newFile = useMemo(
		() => ({ name: bundle.file_path, contents: bundle.newText }),
		[bundle.file_path, bundle.newText],
	);

	const selectedLines: SelectedLineRange | null = useMemo(() => {
		if (!focus) return null;
		const side = focusSideToPierreSide(focus.side);
		return {
			start: focus.start_line,
			end: focus.end_line,
			side,
			endSide: side,
		};
	}, [focus]);

	const onLineSelected = useCallback(
		(range: SelectedLineRange | null) => {
			const { diffFocus, setDiffFocus, clearDiffFocus } = useApp.getState();
			const currentFocus =
				diffFocus?.file_path === bundle.file_path ? diffFocus : null;
			if (!range) {
				if (currentFocus) {
					recordClientTelemetry("client.diff.focus.cleared", {
						"file.path": currentFocus.file_path,
						"line.start": currentFocus.start_line,
						"line.end": currentFocus.end_line,
						"line.side": currentFocus.side,
					});
				}
				clearDiffFocus(currentFocus?.id);
				return;
			}
			const next = pierreRangeToFocus(range, bundle.file_path);
			if (!next) return;
			recordClientTelemetry("client.diff.focus.selected", {
				"file.path": next.file_path,
				"line.start": next.start_line,
				"line.end": next.end_line,
				"line.side": next.side,
			});
			setDiffFocus(next);
		},
		[bundle.file_path],
	);

	const options = useMemo(
		() => ({
			theme: "pierre-dark" as const,
			diffStyle: "unified" as const,
			enableLineSelection: true,
			onLineSelected,
		}),
		[onLineSelected],
	);

	const addReference = useCallback(() => {
		const { diffFocus, addPendingDiffReference, clearDiffFocus } =
			useApp.getState();
		if (!diffFocus || diffFocus.file_path !== bundle.file_path) return;
		addPendingDiffReference(diffFocus);
		recordClientTelemetry("client.diff.focus.reference_added", {
			"file.path": diffFocus.file_path,
			"line.start": diffFocus.start_line,
			"line.end": diffFocus.end_line,
			"line.side": diffFocus.side,
		});
		clearDiffFocus(diffFocus.id);
	}, [bundle.file_path]);

	const clearSelection = useCallback(() => {
		const { diffFocus, clearDiffFocus } = useApp.getState();
		if (!diffFocus || diffFocus.file_path !== bundle.file_path) return;
		recordClientTelemetry("client.diff.focus.cleared", {
			"file.path": diffFocus.file_path,
			"line.start": diffFocus.start_line,
			"line.end": diffFocus.end_line,
			"line.side": diffFocus.side,
		});
		clearDiffFocus(diffFocus.id);
	}, [bundle.file_path]);

	const showToolbar =
		focus?.source === "user" && focus.mode === "draft-reference";

	return (
		<div
			data-file-path={bundle.file_path}
			className="relative overflow-hidden rounded-md border border-border bg-card"
		>
			<div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 font-mono text-xs">
				<span className="truncate">{bundle.file_path}</span>
				{showToolbar && focus && (
					<div className="ml-auto flex items-center gap-1.5">
						<span className="text-muted-foreground">
							{formatDiffReferenceLabel(focus)}
						</span>
						<Button size="sm" onClick={addReference}>
							@Tag
						</Button>
						<Button size="sm" variant="outline" onClick={clearSelection}>
							<X className="size-3.5" />
							Clear
						</Button>
					</div>
				)}
			</div>
			<MultiFileDiff
				oldFile={oldFile}
				newFile={newFile}
				options={options}
				selectedLines={selectedLines}
			/>
		</div>
	);
}

export function DiffPane() {
	const session = useApp((s) => s.session);
	const currentId = useApp((s) => s.currentSectionId);
	const sections = useApp((s) => s.sections);
	const diffFocus = useApp((s) => s.diffFocus);
	const diffFocusError = useApp((s) => s.diffFocusError);
	const clearDiffFocus = useApp((s) => s.clearDiffFocus);
	const setDiffFocusError = useApp((s) => s.setDiffFocusError);

	const current = useMemo(
		() => sections.find((s) => s.id === currentId) ?? null,
		[sections, currentId],
	);
	const section =
		current?.kind === "review_section" ? current.section ?? null : null;

	const [bundles, setBundles] = useState<FileBundle[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [agentFocusLabel, setAgentFocusLabel] = useState<string | null>(null);

	useEffect(() => {
		setAgentFocusLabel(null);
		setDiffFocusError(null);
		const currentFocus = useApp.getState().diffFocus;
		if (currentFocus?.source === "user") {
			clearDiffFocus(currentFocus.id);
		}
	}, [currentId, clearDiffFocus, setDiffFocusError]);

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
					out.push({ file_path: file, oldText, newText });
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

	if (current.kind === "pr_description") {
		return (
			<section className="flex min-h-0 flex-col overflow-y-auto">
				<header className="border-b border-border bg-card/40 px-6 py-4">
					<h2 className="text-base font-semibold">{current.title}</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{current.intent}
					</p>
					{current.url && (
						<a
							href={current.url}
							target="_blank"
							rel="noreferrer"
							className="mt-2 block truncate font-mono text-[11px] text-primary hover:underline"
						>
							{current.url}
						</a>
					)}
				</header>
				<div className="p-6">
					{current.error && (
						<div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
							{current.error}
						</div>
					)}
					<div className="whitespace-pre-wrap rounded-md border border-border bg-card/40 px-4 py-3 text-sm leading-relaxed">
						{current.body}
					</div>
				</div>
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
					<DiffFileCard key={b.file_path} bundle={b} />
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
