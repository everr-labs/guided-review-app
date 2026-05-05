export type Severity = "high" | "medium" | "low";

export type RangeKind =
	| "context"
	| "changed-old"
	| "changed-new"
	| "added"
	| "removed";

export interface LineRange {
	file_path: string;
	start_line: number;
	end_line: number;
	kind: RangeKind;
}

export interface Concern {
	text: string;
	severity: Severity;
	file_path?: string;
	line?: number;
}

export interface ReviewSection {
	schema_version: 1;
	section_id: string;
	title: string;
	intent: string;
	files: string[];
	ranges: LineRange[];
	concerns: Concern[];
	uncovered_scenarios: Concern[];
	test_coverage_notes: string;
	base_ref: string;
	head_ref: string;
	pause_prompt: string;
}

export interface SectionMapEntry {
	section_id: string;
	title: string;
	intent: string;
}

export interface SectionMap {
	schema_version: 1;
	sections: SectionMapEntry[];
}

export type CommentKind = "inline" | "top_level";
export type CommentSide = "LEFT" | "RIGHT";

export interface CommentDraft {
	kind: CommentKind;
	body: string;
	file_path?: string;
	line?: number;
	side?: CommentSide;
}

export type CommentResultStatus = "published" | "failed";

export interface CommentResult {
	draft_id: string;
	status: CommentResultStatus;
	url?: string;
	error?: string;
}

export type SectionStatus = "pending" | "in_review" | "completed";

export interface ToolCallItem {
	tool_call_id: string;
	title: string;
	kind: string;
	status: string;
}

export type ChatItem =
	| { type: "section_map"; sections: SectionMapEntry[] }
	| { type: "review_section"; section: ReviewSection }
	| { type: "tool_call"; toolCall: ToolCallItem };

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	streaming?: boolean;
	item?: ChatItem;
}
