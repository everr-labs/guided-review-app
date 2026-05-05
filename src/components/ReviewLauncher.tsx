import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import { acp, type AgentInfo, type AgentKind, type SessionSource } from "@/lib/acp";
import { localReviewSourceFromInput } from "@/lib/projectSource";
import {
	recordClientTelemetry,
	recordClientTelemetryError,
} from "@/lib/telemetry";

export function ReviewLauncher() {
	const project = useApp((s) => s.project);
	const session = useApp((s) => s.session);
	const setSession = useApp((s) => s.setSession);
	const reset = useApp((s) => s.reset);
	const addUserMessage = useApp((s) => s.addUserMessage);
	const pushError = useApp((s) => s.pushError);

	const [input, setInput] = useState("");
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [agentKind, setAgentKind] = useState<AgentKind>("claude_code");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		(async () => {
			try {
				const list = await acp.listAgents();
				setAgents(list);
			} catch (e) {
				recordClientTelemetryError("client.launcher.agents_load.failed", e);
			}
		})();
	}, []);

	const sourceResult = useMemo(
		() => localReviewSourceFromInput({ input, project }),
		[input, project],
	);

	const validationError =
		!project
			? null
			: "error" in sourceResult && input.trim()
				? sourceResult.error
				: null;
	const canStart =
		!starting && !!project && "source" in sourceResult;

	async function start(source: SessionSource) {
		setError(null);
		setStarting(true);
		recordClientTelemetry("client.launcher.start.requested", {
			"agent.kind": agentKind,
			"session.source.kind": source.kind,
		});
		try {
			const res = await acp.startSession({ source, agent_kind: agentKind });
			recordClientTelemetry("client.launcher.start.session_received", {
				"agent.kind": agentKind,
				"session.source.kind": source.kind,
				"acp.session_id": res.session_id,
				"repo.display_slug": res.repo.display_slug,
			});
			reset();
			setSession(res);
			setInput("");
			const skill = await acp.agentSkill();
			const kickoff = `${skill}\n\n---\n\nThe repository for this review is at \`${res.repo.path}\` (base \`${res.repo.base_ref}\`, head \`${res.repo.head_ref}\`). Investigate the diff with your built-in tools, then reply with one \`\`\`acp-section-map\`\`\` fenced block describing the planned sections. After that, stop and wait for me.`;
			addUserMessage("(starting guided review)");
			await acp.sendMessage(res.session_id, kickoff, {
				origin: "review_launcher_kickoff",
				reason: "request_section_map",
			});
			recordClientTelemetry("client.launcher.start.kickoff_sent", {
				"acp.session_id": res.session_id,
			});
		} catch (e) {
			recordClientTelemetryError("client.launcher.start.failed", e, {
				"agent.kind": agentKind,
				"session.source.kind": source.kind,
			});
			const message = String(e);
			setError(message);
			pushError(message);
		} finally {
			setStarting(false);
		}
	}

	async function onSubmit(e: FormEvent) {
		e.preventDefault();
		const result = localReviewSourceFromInput({ input, project });
		if ("error" in result) {
			setError(result.error);
			return;
		}
		await start(result.source);
	}

	if (!project) return null;

	return (
		<div className="flex min-w-0 flex-1 items-center gap-2">
			<form onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-2">
				<Input
					value={input}
					onChange={(e) => {
						setInput(e.target.value);
						setError(null);
					}}
					placeholder={
						session
							? "Switch to PR #, URL, branch, or SHA..."
							: "PR #, PR URL, branch, or SHA..."
					}
					disabled={starting}
					className="h-7 max-w-md flex-1 text-xs"
				/>
				{agents.length > 1 && (
					<select
						value={agentKind}
						onChange={(e) => setAgentKind(e.target.value as AgentKind)}
						className="h-7 rounded-md border border-border bg-input px-1.5 text-xs text-foreground"
						disabled={starting}
						title="Agent"
					>
						{agents.map((agent) => (
							<option key={agent.kind} value={agent.kind}>
								{agent.label}
							</option>
						))}
					</select>
				)}
				<Button
					type="submit"
					size="sm"
					disabled={!canStart}
					className="h-7"
				>
					{starting ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<Play className="size-3.5" />
					)}
					{session ? "Switch" : "Start"}
				</Button>
			</form>
			{(error || validationError) && (
				<span className="truncate text-xs text-destructive" title={error ?? validationError ?? undefined}>
					{error ?? validationError}
				</span>
			)}
		</div>
	);
}
