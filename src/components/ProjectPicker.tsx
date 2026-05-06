import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, FolderOpen, GitPullRequest } from "lucide-react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
import { acp } from "@/lib/acp";
import { cn } from "@/lib/utils";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";
import {
	clearLastProjectPath,
	loadLastProjectPath,
	localRecentProjects,
	type LocalProject,
	type LocalRecentProject,
} from "@/lib/projectSource";

function projectLabel(project: LocalRecentProject): string {
	return project.label || project.path.split(/[\\/]/).pop() || project.path;
}

function projectSubtitle(project: LocalRecentProject): string {
	return project.path;
}

export function ProjectPicker() {
	const project = useApp((s) => s.project);
	const setProject = useApp((s) => s.setProject);

	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [recents, setRecents] = useState<LocalRecentProject[]>([]);
	const [loadingPath, setLoadingPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const attemptedRestoreRef = useRef(false);

	useEffect(() => {
		(async () => {
			try {
				const recentProjects = await acp.listRecentProjects();
				setRecents(localRecentProjects(recentProjects));
			} catch (e) {
				recordClientTelemetryError("client.project.metadata_load.failed", e, {
					"dropdown.open": open,
				});
			}
		})();
	}, [open]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return recents;
		return recents.filter((rp) => {
			const label = projectLabel(rp).toLowerCase();
			const sub = projectSubtitle(rp).toLowerCase();
			return label.includes(q) || sub.includes(q);
		});
	}, [query, recents]);

	const selectProjectPath = useCallback(
		async (path: string, source: "user" | "restore" = "user") => {
			setError(null);
			setLoadingPath(path);
			recordClientTelemetry("client.project.select.requested", {
				"project.path": path,
				"project.selection_source": source,
			});
			try {
				const origin = await acp.inspectLocalRepoOrigin(path);
				const next: LocalProject = { path, origin };
				setProject(next);
				recordClientTelemetry("client.project.select.succeeded", {
					"project.path": path,
					"project.slug": origin.slug,
					"project.selection_source": source,
				});
				setOpen(false);
				setQuery("");
			} catch (e) {
				recordClientTelemetryError("client.project.select.failed", e, {
					"project.path": path,
					"project.selection_source": source,
				});
				if (source === "restore") clearLastProjectPath();
				else setError(String(e));
			} finally {
				setLoadingPath(null);
			}
		},
		[setProject],
	);

	useEffect(() => {
		if (attemptedRestoreRef.current || project) return;
		attemptedRestoreRef.current = true;
		const savedPath = loadLastProjectPath();
		if (!savedPath) return;
		void selectProjectPath(savedPath, "restore");
	}, [project, selectProjectPath]);

	async function pickLocal() {
		try {
			const selected = await openDialog({ directory: true, multiple: false });
			if (typeof selected === "string") {
				await selectProjectPath(selected);
			}
		} catch (e) {
			setError(String(e));
		}
	}

	const currentLabel = project
		? project.path.split(/[\\/]/).pop() || project.path
		: "Open project...";

	return (
		<DropdownMenu.Root open={open} onOpenChange={setOpen}>
			<DropdownMenu.Trigger asChild>
				<button
					className={cn(
						"inline-flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium transition-colors",
						"hover:bg-accent",
						open && "bg-accent",
					)}
				>
					<span className="text-primary">guided-review</span>
					<span className="text-muted-foreground">›</span>
					<span>{currentLabel}</span>
					<ChevronDown className="size-3.5 text-muted-foreground" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={6}
					className="z-50 w-[480px] rounded-md border border-border bg-popover shadow-2xl"
				>
					<Command shouldFilter={false}>
						<div className="border-b border-border p-3">
							<Button
								type="button"
								variant="outline"
								onClick={pickLocal}
								disabled={loadingPath !== null}
								className="w-full justify-start"
							>
								<FolderOpen className="size-4" />
								{project ? "Change local folder..." : "Choose local folder..."}
							</Button>
							{project && (
								<div className="mt-2 truncate rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
									{project.path}
								</div>
							)}
							{project && (
								<div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
									<GitPullRequest className="size-3.5" />
									<span>{project.origin.slug}</span>
								</div>
							)}
						</div>

						{error && (
							<div className="mx-3 my-2 rounded-md bg-destructive/15 px-2 py-1.5 text-xs text-destructive">
								{error}
							</div>
						)}
						{loadingPath && (
							<div className="px-4 py-2 text-xs text-muted-foreground">
								Inspecting {loadingPath}...
							</div>
						)}

						<CommandInput
							placeholder="Search recent local repos..."
							value={query}
							onValueChange={setQuery}
							disabled={loadingPath !== null}
						/>
						<CommandList>
							<CommandEmpty>No matches</CommandEmpty>
							{filtered.length > 0 && (
								<CommandGroup heading="Recent Local Repos">
									{filtered.map((rp) => (
										<CommandItem
											key={`local:${rp.path}`}
											value={`${projectLabel(rp)} ${projectSubtitle(rp)}`}
											onSelect={() => selectProjectPath(rp.path)}
											disabled={loadingPath !== null}
										>
											<FolderOpen className="mr-2 size-3.5 text-muted-foreground" />
											<div className="min-w-0 flex-1">
												<div>{projectLabel(rp)}</div>
												<div className="truncate font-mono text-[11px] text-muted-foreground">
													{projectSubtitle(rp)}
												</div>
											</div>
										</CommandItem>
									))}
								</CommandGroup>
							)}
						</CommandList>
					</Command>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
