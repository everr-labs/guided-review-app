import assert from "node:assert/strict";
import test from "node:test";
import {
	rangeFoldId,
	rangeSides,
	visibleUnimportantRangesForFile,
} from "./unimportantRanges";
import type { UnimportantRange } from "./types/section";

const range: UnimportantRange = {
	file_path: "src/App.tsx",
	start_line: 10,
	end_line: 24,
	kind: "changed-new",
	reason: "Import ordering only.",
};

test("rangeSides maps review range kinds to diff sides", () => {
	assert.deepEqual(rangeSides("changed-new"), ["additions"]);
	assert.deepEqual(rangeSides("added"), ["additions"]);
	assert.deepEqual(rangeSides("changed-old"), ["deletions"]);
	assert.deepEqual(rangeSides("removed"), ["deletions"]);
	assert.deepEqual(rangeSides("context"), ["additions", "deletions"]);
});

test("visibleUnimportantRangesForFile keeps usable ranges for the visible file", () => {
	const ranges = visibleUnimportantRangesForFile(
		[
			range,
			{ ...range, file_path: "src/Other.tsx" },
			{ ...range, start_line: 40, end_line: 39 },
			{ ...range, reason: "   " },
		],
		"src/App.tsx",
	);

	assert.deepEqual(ranges, [range]);
});

test("visibleUnimportantRangesForFile treats missing ranges as empty", () => {
	assert.deepEqual(visibleUnimportantRangesForFile(undefined, "src/App.tsx"), []);
	assert.deepEqual(visibleUnimportantRangesForFile(null, "src/App.tsx"), []);
});

test("rangeFoldId is stable for the same folded range", () => {
	assert.equal(
		rangeFoldId(range),
		"src/App.tsx:changed-new:10-24:Import ordering only.",
	);
});
