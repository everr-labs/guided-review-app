import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "./types/section";

const storage = new Map<string, string>();

globalThis.localStorage = {
	getItem: (key: string) => storage.get(key) ?? null,
	setItem: (key: string, value: string) => {
		storage.set(key, value);
	},
	removeItem: (key: string) => {
		storage.delete(key);
	},
	clear: () => {
		storage.clear();
	},
	key: (index: number) => Array.from(storage.keys())[index] ?? null,
	get length() {
		return storage.size;
	},
} as Storage;

test("appendAssistantChunk merges overlapping text chunks", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({ chat: [], streaming: false });
	useApp.getState().appendAssistantChunk("This");
	useApp
		.getState()
		.appendAssistantChunk("This function checks which agent providers");

	assert.equal(
		useApp.getState().chat[0]?.text,
		"This function checks which agent providers",
	);
});

test("appendAssistantChunk keeps normal chunks while removing shared boundaries", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({ chat: [], streaming: false });
	useApp
		.getState()
		.appendAssistantChunk("available for Codex, Claude Code");
	useApp
		.getState()
		.appendAssistantChunk("Claude Code, and Cursor on this machine.");

	assert.equal(
		useApp.getState().chat[0]?.text,
		"available for Codex, Claude Code, and Cursor on this machine.",
	);
});

test("section processing state clears when the requested section arrives", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		sections: [
			{
				id: "metadata-retention-logic",
				title: "Metadata retention decision logic",
				intent: "Review metadata behavior",
				status: "pending",
			},
		],
		currentSectionId: null,
		processingSectionId: null,
	});

	useApp.getState().startSectionProcessing("metadata-retention-logic");

	assert.equal(useApp.getState().processingSectionId, "metadata-retention-logic");

	useApp.getState().upsertSection({
		schema_version: 1,
		section_id: "metadata-retention-logic",
		title: "Metadata retention decision logic",
		intent: "Review metadata behavior",
		files: [],
		ranges: [],
		concerns: [],
		uncovered_scenarios: [],
		test_coverage_notes: "",
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "",
	});

	assert.equal(useApp.getState().processingSectionId, null);
});

test("addSectionMapItem stores readable section map details", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({ chat: [], streaming: false });

	useApp.getState().addSectionMapItem([
		{
			section_id: "overview",
			title: "Overview",
			intent: "Understand the public boundary",
		},
		{
			section_id: "tests",
			title: "Tests",
			intent: "Check test coverage",
		},
	]);

	assert.equal(useApp.getState().chat.length, 1);
	assert.equal(useApp.getState().chat[0]?.role, "assistant");
	assert.equal(useApp.getState().chat[0]?.item?.type, "section_map");
	assert.equal(useApp.getState().chat[0]?.item?.sections.length, 2);
});

test("addReviewSectionItem stores readable files and feedback", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({ chat: [], streaming: false });

	useApp.getState().addReviewSectionItem({
		schema_version: 1,
		section_id: "logic",
		title: "Core logic",
		intent: "Review behavior changes",
		files: ["src/lib.rs", "src/main.rs"],
		ranges: [],
		concerns: [
			{
				text: "Missing empty input check.",
				severity: "medium",
				file_path: "src/lib.rs",
				line: 24,
			},
		],
		uncovered_scenarios: [
			{
				text: "No test for an empty input.",
				severity: "low",
			},
		],
		test_coverage_notes: "Happy path covered.",
		base_ref: "base",
		head_ref: "head",
		pause_prompt: "Questions?",
	});

	const item = useApp.getState().chat[0]?.item;
	assert.equal(item?.type, "review_section");
	assert.deepEqual(item?.section.files, ["src/lib.rs", "src/main.rs"]);
	assert.equal(item?.section.concerns[0]?.text, "Missing empty input check.");
	assert.equal(
		item?.section.uncovered_scenarios[0]?.text,
		"No test for an empty input.",
	);
});

test("appendAssistantChunk hides structured review fences from chat text", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({ chat: [], streaming: false });

	useApp.getState().appendAssistantChunk(
		[
			"Here is the map.",
			"```acp-section-map",
			'{ "sections": [] }',
			"```",
			"Ready.",
		].join("\n"),
	);

	assert.equal(useApp.getState().chat[0]?.text, "Here is the map.\nReady.");
});

test("structured review fences split around a readable item stay hidden", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({ chat: [], streaming: false });

	useApp.getState().appendAssistantChunk(
		[
			"A focused bug-fix PR.",
			"",
			"```acp-section-map",
			"{",
			'  "sections": [',
			'    { "section_id": "query-rules", "title": "Query support rule changes", "intent": "Core logic" },',
			'    { "section_id": "changeset", "title": "Changeset", "intent": "Release metadata',
		].join("\n"),
	);
	useApp.getState().addSectionMapItem([
		{
			section_id: "query-rules",
			title: "Query support rule changes",
			intent: "Core logic",
		},
		{
			section_id: "changeset",
			title: "Changeset",
			intent: "Release metadata for this patch",
		},
	]);
	useApp.getState().appendAssistantChunk(
		[
			' for this patch" }',
			"  ]",
			"}",
			"```",
			"",
			"Ready when you are.",
		].join("\n"),
	);

	const chat = useApp.getState().chat as ChatMessage[];
	assert.equal(chat.length, 3);
	assert.equal(chat[0]?.text.trimEnd(), "A focused bug-fix PR.");
	assert.equal(chat[1]?.item?.type, "section_map");
	assert.equal(chat[2]?.text.trim(), "Ready when you are.");
	assert(!chat.some((message) => message.text.includes("```acp-section-map")));
	assert(!chat.some((message) => message.text.includes("Release metadata")));
});

test("applyCommentResult stores published URL for matching draft", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		commentDrafts: [
			{
				id: "draft-123",
				status: "publishing",
				draft: {
					kind: "top_level",
					body: "Looks good.",
				},
			},
		],
	});

	useApp.getState().applyCommentResult({
		draft_id: "draft-123",
		status: "published",
		url: "https://github.com/garden-co/jazz/pull/787#discussion_r1",
	});

	assert.deepEqual(useApp.getState().commentDrafts[0], {
		id: "draft-123",
		status: "published",
		url: "https://github.com/garden-co/jazz/pull/787#discussion_r1",
		draft: {
			kind: "top_level",
			body: "Looks good.",
		},
	});
});

test("applyCommentResult stores failure message for matching draft", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		commentDrafts: [
			{
				id: "draft-456",
				status: "publishing",
				draft: {
					kind: "inline",
					body: "Please check this.",
					file_path: "src/main.rs",
					line: 12,
					side: "RIGHT",
				},
			},
		],
	});

	useApp.getState().applyCommentResult({
		draft_id: "draft-456",
		status: "failed",
		error: "GitHub rejected the comment.",
	});

	assert.equal(useApp.getState().commentDrafts[0]?.status, "error");
	assert.equal(
		useApp.getState().commentDrafts[0]?.error,
		"GitHub rejected the comment.",
	);
});
