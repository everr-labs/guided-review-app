import type { DiffLineAnnotation } from "@pierre/diffs";
import type { PublishedPrComment } from "./acp";

export interface PublishedCommentAnnotationMetadata {
	comment: PublishedPrComment;
}

function locationLabel(comment: PublishedPrComment): string {
	const line = comment.line ?? comment.original_line;
	const side = comment.side ?? comment.original_side;
	if (!comment.file_path || !line || !side) return "top-level or outdated location";
	return `${comment.file_path}:${line} (${side})`;
}

export function formatPublishedCommentsForPrompt(
	comments: PublishedPrComment[],
	error?: string,
): string {
	if (error && comments.length === 0) {
		return `Existing published PR review comments could not be downloaded: ${error}`;
	}
	if (comments.length === 0) {
		return "Existing published PR review comments: none downloaded.";
	}

	const lines = [
		"Existing published PR review comments:",
		"Use these as context. Do not repeat feedback that is already covered by these comments.",
	];
	if (error) {
		lines.push(`Download warning: ${error}`);
	}
	for (const comment of comments) {
		const outdated = comment.is_outdated ? " outdated" : "";
		lines.push(
			`- ${comment.author_login} on ${locationLabel(comment)}${outdated}: ${comment.body}`,
		);
		lines.push(`  ${comment.html_url}`);
	}
	return lines.join("\n");
}

export function publishedCommentToDiffAnnotation(
	comment: PublishedPrComment,
): DiffLineAnnotation<PublishedCommentAnnotationMetadata> | null {
	if (!comment.file_path) return null;
	const lineNumber = comment.line ?? comment.original_line;
	const side = comment.side ?? comment.original_side;
	if (!lineNumber || !side) return null;
	return {
		lineNumber,
		side: side === "RIGHT" ? "additions" : "deletions",
		metadata: { comment },
	};
}
