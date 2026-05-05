import assert from "node:assert/strict";
import test from "node:test";

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

test("diff focus state stores active focus and pending references", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({
		diffFocus: null,
		pendingDiffReferences: [],
		diffFocusError: null,
	});

	const focus = {
		id: "focus-1",
		file_path: "src/App.tsx",
		start_line: 4,
		end_line: 9,
		side: "RIGHT" as const,
		source: "user" as const,
		mode: "draft-reference" as const,
		created_at: 123,
	};

	useApp.getState().setDiffFocus(focus);
	assert.deepEqual(useApp.getState().diffFocus, focus);

	useApp.getState().addPendingDiffReference(focus);
	assert.deepEqual(useApp.getState().pendingDiffReferences, [focus]);

	useApp.getState().clearDiffFocus("focus-1");
	assert.equal(useApp.getState().diffFocus, null);

	useApp.getState().removePendingDiffReference("focus-1");
	assert.deepEqual(useApp.getState().pendingDiffReferences, []);
});

test("appendAssistantChunk hides diff focus fences from chat text", async () => {
	const { useApp } = await import(new URL("./store.ts", import.meta.url).href);

	useApp.setState({ chat: [], streaming: false });

	useApp.getState().appendAssistantChunk(
		[
			"Look here.",
			"```acp-diff-focus",
			'{ "file_path": "src/App.tsx", "start_line": 4, "end_line": 9, "side": "RIGHT" }',
			"```",
			"Then continue.",
		].join("\n"),
	);

	assert.equal(useApp.getState().chat[0]?.text, "Look here.\nThen continue.");
});
