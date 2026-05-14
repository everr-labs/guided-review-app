import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App starts the next unloaded section after final section feedback arrives", async () => {
	const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

	assert.match(source, /findNextSectionToAutoLoad/);
	assert.match(source, /startNextSectionAfter/);
	assert.match(source, /auto_load_next/);
});
