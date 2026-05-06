import assert from "node:assert/strict";
import test from "node:test";
import {
	SELECTED_AGENT_KIND_KEY,
	loadSelectedAgentKind,
	saveSelectedAgentKind,
} from "./agentPreference";

function createMemoryStorage(seed: Record<string, string> = {}): Storage {
	const values = new Map(Object.entries(seed));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
		clear: () => {
			values.clear();
		},
		key: (index: number) => Array.from(values.keys())[index] ?? null,
		get length() {
			return values.size;
		},
	} as Storage;
}

function createFailingStorage(): Storage {
	return {
		getItem: () => {
			throw new Error("storage unavailable");
		},
		setItem: () => {
			throw new Error("storage unavailable");
		},
		removeItem: () => {
			throw new Error("storage unavailable");
		},
		clear: () => {
			throw new Error("storage unavailable");
		},
		key: () => {
			throw new Error("storage unavailable");
		},
		get length() {
			return 0;
		},
	} as Storage;
}

test("agent preference helpers save and load a valid agent kind", () => {
	const storage = createMemoryStorage();

	saveSelectedAgentKind("codex", storage);

	assert.equal(storage.getItem(SELECTED_AGENT_KIND_KEY), "codex");
	assert.equal(loadSelectedAgentKind(storage), "codex");
});

test("agent preference helpers ignore missing, blank, and unknown values", () => {
	assert.equal(loadSelectedAgentKind(createMemoryStorage()), null);
	assert.equal(
		loadSelectedAgentKind(
			createMemoryStorage({ [SELECTED_AGENT_KIND_KEY]: "   " }),
		),
		null,
	);
	assert.equal(
		loadSelectedAgentKind(
			createMemoryStorage({ [SELECTED_AGENT_KIND_KEY]: "unknown_agent" }),
		),
		null,
	);
});

test("agent preference helpers do not throw when storage fails", () => {
	const storage = createFailingStorage();

	assert.doesNotThrow(() => saveSelectedAgentKind("claude_code", storage));
	assert.equal(loadSelectedAgentKind(storage), null);
});
