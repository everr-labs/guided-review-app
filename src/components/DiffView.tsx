import { useEffect, useMemo, useState } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { createPatch } from "diff";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { SeverityBadge } from "./SeverityBadge";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";

interface FileBundle {
	file_path: string;
	oldText: string;
	newText: string;
	patch: string;
}

const fileCache = new Map<string, string>();

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

function DiffFileCard({ bundle }: { bundle: FileBundle }) {
	return (
		<div
			data-file-path={bundle.file_path}
			className="relative overflow-hidden rounded-md border border-border bg-card"
		>
			<div className="border-b border-border bg-muted/40 px-3 py-1.5 font-mono text-xs">
				{bundle.file_path}
			</div>
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
	);
}

export function DiffPane() {
	const session = useApp((s) => s.session);
	const currentId = useApp((s) => s.currentSectionId);
	const sections = useApp((s) => s.sections);

	const current = useMemo(
		() => sections.find((s) => s.id === currentId) ?? null,
		[sections, currentId],
	);
	const section =
		current?.kind === "review_section" ? current.section ?? null : null;

	const [bundles, setBundles] = useState<FileBundle[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);

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
