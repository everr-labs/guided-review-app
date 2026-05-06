import assert from "node:assert/strict";
import test from "node:test";
import { computeFileDiffStats, formatFileDiffStats } from "./diffStats";

test("computeFileDiffStats reports zero adds and removes for identical text", () => {
	const stats = computeFileDiffStats("a.ts", "hello\n", "hello\n");
	assert.deepEqual(stats, { additions: 0, deletions: 0 });
});

test("computeFileDiffStats counts added and removed lines from a real diff", () => {
	const oldText = "a\nb\nc\n";
	const newText = "a\nB\nc\nd\n";
	const stats = computeFileDiffStats("file.ts", oldText, newText);
	assert.equal(stats.additions, 2);
	assert.equal(stats.deletions, 1);
});

test("computeFileDiffStats treats a brand new file as pure additions", () => {
	const stats = computeFileDiffStats("new.ts", "", "line1\nline2\nline3\n");
	assert.equal(stats.deletions, 0);
	assert.ok(stats.additions >= 3);
});

test("formatFileDiffStats prints a compact summary", () => {
	assert.equal(formatFileDiffStats({ additions: 12, deletions: 4 }), "+12 −4");
});
