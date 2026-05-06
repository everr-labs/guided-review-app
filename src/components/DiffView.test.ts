import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("DiffView does not render pending diff reference labels inline", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.equal(source.includes("Tagged "), false);
});

test("DiffView does not render section pause prompts", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.equal(source.includes("pause_prompt"), false);
	assert.equal(
		source.includes("Questions on this section, or should I move to the next one?"),
		false,
	);
});

test("DiffView does not render section feedback in a bottom panel", async () => {
	const source = await readFile(
		new URL("./DiffView.tsx", import.meta.url),
		"utf8",
	);

	assert.equal(source.includes("section!.concerns.map"), false);
	assert.equal(source.includes("section!.uncovered_scenarios.map"), false);
	assert.equal(source.includes("border-t border-border px-6 py-4"), false);
	assert.equal(source.includes("sectionFeedbackToDiffAnnotations"), true);
});
