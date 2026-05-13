import { parseDiffFromFile } from "@pierre/diffs";

export interface FileDiffStats {
	additions: number;
	deletions: number;
}

export function computeFileDiffStats(
	filePath: string,
	oldText: string,
	newText: string,
): FileDiffStats {
	if (oldText === newText) {
		return { additions: 0, deletions: 0 };
	}
	try {
		const metadata = parseDiffFromFile(
			{ name: filePath, contents: oldText },
			{ name: filePath, contents: newText },
		);
		let additions = 0;
		let deletions = 0;
		for (const hunk of metadata.hunks) {
			additions += hunk.additionLines;
			deletions += hunk.deletionLines;
		}
		return { additions, deletions };
	} catch {
		return fallbackLineDelta(oldText, newText);
	}
}

function fallbackLineDelta(oldText: string, newText: string): FileDiffStats {
	const oldLines = oldText ? oldText.split("\n").length : 0;
	const newLines = newText ? newText.split("\n").length : 0;
	const delta = newLines - oldLines;
	return {
		additions: Math.max(delta, 0),
		deletions: Math.max(-delta, 0),
	};
}

export function formatFileDiffStats(stats: FileDiffStats): string {
	return `+${stats.additions} −${stats.deletions}`;
}

export function isDeletionOnlyDiff(stats: FileDiffStats): boolean {
	return stats.additions === 0 && stats.deletions > 0;
}
