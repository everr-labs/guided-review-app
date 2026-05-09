import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("section telemetry records unimportant range counts", async () => {
	const appSource = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
	const storeSource = await readFile(new URL("./store.ts", import.meta.url), "utf8");

	assert.match(
		appSource,
		/"section\.unimportant_range_count":\s*p\.section\.unimportant_ranges\?\.length \?\? 0/,
	);
	assert.match(
		storeSource,
		/"section\.unimportant_range_count":\s*section\.unimportant_ranges\?\.length \?\? 0/,
	);
	assert.equal(appSource.includes("section.range_count"), false);
	assert.equal(storeSource.includes("section.range_count"), false);
});
