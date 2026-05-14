import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatPanelPath = new URL("./ChatPanel.tsx", import.meta.url);

test("ChatPanel review-section empty state says 'No concerns found for this section.'", async () => {
	const src = await readFile(chatPanelPath, "utf8");
	assert.ok(
		src.includes("No concerns found for this section."),
		"expected ChatPanel.tsx to render 'No concerns found for this section.'",
	);
	assert.ok(
		!src.includes("No feedback called out for this section."),
		"old empty-state copy 'No feedback called out for this section.' should be gone",
	);
});

test("ChatPanel uses a bottom anchor instead of forcing scrollTop on every update", async () => {
	const src = await readFile(chatPanelPath, "utf8");

	assert.match(src, /bottomAnchorRef/);
	assert.match(src, /scrollIntoView/);
	assert.match(src, /onScroll=\{handleChatScroll\}/);
	assert.match(src, /chat-scroll-anchor/);
	assert.doesNotMatch(src, /scrollTop\s*=\s*[^;]*scrollHeight/);
});
