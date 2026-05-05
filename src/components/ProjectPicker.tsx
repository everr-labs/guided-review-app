import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import {
	acp,
	type AgentInfo,
	type AgentKind,
	type LocalRepoOrigin,
	type SessionSource,
} from "@/lib/acp";
import { cn } from "@/lib/utils";
import { recordClientTelemetry, recordClientTelemetryError } from "@/lib/telemetry";
import {
	localPrSourceFromSelection,
	localRecentProjects,
	type LocalRecentProject,
} from "@/lib/projectSource";

function projectLabel(project: LocalRecentProject): string {
	return project.label || project.path.split(/[\\/]/).pop() || project.path;
}

function projectSubtitle(project: LocalRecentProject): string {
	return project.path;
}

export function ProjectPicker() {
	const session = useApp((s) => s.session);
	const setSession = useApp((s) => s.setSession);
	const reset = useApp((s) => s.reset);
	const addUserMessage = useApp((s) => s.addUserMessage);

	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [prInput, setPrInput] = useState("");
	const [localPath, setLocalPath] = useState("");
	const [origin, setOrigin] = useState<LocalRepoOrigin | null>(null);
	const [originLoading, setOriginLoading] = useState(false);
	const [recents, setRecents] = useState<LocalRecentProject[]>([]);
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [agentKind, setAgentKind] = useState<AgentKind>("claude_code");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		(async () => {
			try {
				const [recentProjects, availableAgents] = await Promise.all([
					acp.listRecentProjects(),
					acp.listAgents(),
				]);
				setRecents(localRecentProjects(recentProjects));
				setAgents(availableAgents);
			} catch (e) {
				recordClientTelemetryError("client.project.metadata_load.failed", e, {
					"dropdown.open": open,
				});
			}
		})();
	}, [open]);

	useEffect(() => {
		if (!localPath) {
			setOrigin(null);
			setOriginLoading(false);
			return;
		}

		let cancelled = false;
		setOrigin(null);
		setOriginLoading(true);
		setError(null);

		(async () => {
			try {
				const info = await acp.inspectLocalRepoOrigin(localPath);
				if (!cancelled) setOrigin(info);
			} catch (e) {
				if (!cancelled) {
					setOrigin(null);
					setError(String(e));
				}
			} finally {
				if (!cancelled) setOriginLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [localPath]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return recents;
		return recents.filter((project) => {
			const label = projectLabel(project).toLowerCase();
			const sub = projectSubtitle(project).toLowerCase();
			return label.includes(q) || sub.includes(q);
		});
	}, [query, recents]);

	const sourceResult = useMemo(
		() =>
			localPrSourceFromSelection({
				input: prInput,
				localPath,
				origin,
			}),
		[prInput, localPath, origin],
	);

	const validationError =
		originLoading && localPath
			? "Checking selected repository origin..."
			: "error" in sourceResult
				? sourceResult.error
				: null;
	const canStart = !starting && !originLoading && "source" in sourceResult;

	async function start(source: SessionSource) {
		setError(null);
		setStarting(true);
		recordClientTelemetry("client.project.start.requested", {
			"agent.kind": agentKind,
			"session.source.kind": source.kind,
		});
		try {
			const res = await acp.startSession({ source, agent_kind: agentKind });
			recordClientTelemetry("client.project.start.session_received", {
				"agent.kind": agentKind,
				"session.source.kind": source.kind,
				"acp.session_id": res.session_id,
				"repo.display_slug": res.repo.display_slug,
			});
			reset();
			setSession(res);
			setOpen(false);
			setQuery("");
			setPrInput("");
			const skill = await acp.agentSkill();
			const kickoff = `${skill}\n\n---\n\nThe repository for this review is at \`${res.repo.path}\` (base \`${res.repo.base_ref}\`, head \`${res.repo.head_ref}\`). Investigate the diff with your built-in tools, then reply with one \`\`\`acp-section-map\`\`\` fenced block describing the planned sections. After that, stop and wait for me.`;
			recordClientTelemetry("client.project.start.kickoff_sending", {
				"acp.session_id": res.session_id,
				"message.length": kickoff.length,
			});
			addUserMessage("(starting guided review)");
			await acp.sendMessage(res.session_id, kickoff, {
				origin: "project_picker_kickoff",
				reason: "request_section_map",
			});
			recordClientTelemetry("client.project.start.kickoff_sent", {
				"acp.session_id": res.session_id,
			});
		} catch (e) {
			recordClientTelemetryError("client.project.start.failed", e, {
				"agent.kind": agentKind,
				"session.source.kind": source.kind,
			});
			setError(String(e));
		} finally {
			setStarting(false);
			recordClientTelemetry("client.project.start.finished", {
				"agent.kind": agentKind,
				"session.source.kind": source.kind,
			});
		}
	}

	async function startFromSelection(e?: FormEvent) {
		e?.preventDefault();
		const result = localPrSourceFromSelection({
			input: prInput,
			localPath,
			origin,
		});
		if ("error" in result) {
			setError(result.error);
			return;
		}
		await start(result.source);
	}

	async function pickLocal() {
		try {
			const selected = await openDialog({ directory: true, multiple: false });
			if (typeof selected === "string") {
				setLocalPath(selected);
				setError(null);
			}
		} catch (e) {
			setError(String(e));
		}
	}

	function chooseRecent(project: LocalRecentProject) {
		setLocalPath(project.path);
		setError(null);
		setQuery("");
	}

	const currentLabel = session ? session.repo.display_slug : "Open project...";

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
					className="z-50 w-[560px] rounded-md border border-border bg-popover shadow-2xl"
				>
					<Command shouldFilter={false}>
						<form className="border-b border-border p-3" onSubmit={startFromSelection}>
							<div className="space-y-3">
								<label className="block">
									<span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
										Pull request
									</span>
									<div className="flex gap-2">
										<Input
											value={prInput}
											onChange={(e) => {
												setPrInput(e.target.value);
												setError(null);
											}}
											placeholder="123 or https://github.com/owner/repo/pull/123"
											disabled={starting}
										/>
										<Button type="submit" disabled={!canStart}>
											Start Review
										</Button>
									</div>
								</label>

								<div className="space-y-2">
									<div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
										Local repository
									</div>
									<Button
										type="button"
										variant="outline"
										onClick={pickLocal}
										disabled={starting}
										className="w-full justify-start"
									>
										<FolderOpen className="size-4" />
										{localPath ? "Change local folder" : "Choose local folder"}
									</Button>
									{localPath && (
										<div className="truncate rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
											{localPath}
										</div>
									)}
									{origin && (
										<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
											<GitPullRequest className="size-3.5" />
											<span>{origin.slug}</span>
										</div>
									)}
								</div>
							</div>
						</form>

						{(error || validationError) && (
							<div className="mx-3 my-2 rounded-md bg-destructive/15 px-2 py-1.5 text-xs text-destructive">
								{error ?? validationError}
							</div>
						)}
						{starting && (
							<div className="px-4 py-2 text-xs text-muted-foreground">
								Starting...
							</div>
						)}

						<CommandInput
							placeholder="Search recent local repos..."
							value={query}
							onValueChange={setQuery}
							disabled={starting}
						/>
						<CommandList>
							<CommandEmpty>No matches</CommandEmpty>
							{session && (
								<CommandGroup heading="This Window">
									<CommandItem
										value={`__session::${session.session_id}`}
										onSelect={() => setOpen(false)}
									>
										<div className="min-w-0 flex-1">
											<div>{session.repo.display_slug}</div>
											<div className="truncate font-mono text-[11px] text-muted-foreground">
												{session.repo.head_ref} ← {session.repo.base_ref}
											</div>
										</div>
									</CommandItem>
								</CommandGroup>
							)}
							{filtered.length > 0 && (
								<CommandGroup heading="Recent Local Repos">
									{filtered.map((project) => (
										<CommandItem
											key={`local:${project.path}`}
											value={`${projectLabel(project)} ${projectSubtitle(project)}`}
											onSelect={() => chooseRecent(project)}
											disabled={starting}
										>
											<FolderOpen className="mr-2 size-3.5 text-muted-foreground" />
											<div className="min-w-0 flex-1">
												<div>{projectLabel(project)}</div>
												<div className="truncate font-mono text-[11px] text-muted-foreground">
													{projectSubtitle(project)}
												</div>
											</div>
										</CommandItem>
									))}
								</CommandGroup>
							)}
						</CommandList>
						<div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
							<label className="flex items-center gap-2">
								<span>Agent</span>
								<select
									value={agentKind}
									onChange={(e) => setAgentKind(e.target.value as AgentKind)}
									className="rounded-md border border-border bg-input px-1.5 py-0.5 text-foreground"
									disabled={starting}
								>
									{agents.map((agent) => (
										<option key={agent.kind} value={agent.kind}>
											{agent.label}
										</option>
									))}
								</select>
							</label>
						</div>
					</Command>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
