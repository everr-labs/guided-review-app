import assert from "node:assert/strict";
import test from "node:test";

async function loadChatScroll() {
	try {
		return await import("./chatScroll");
	} catch {
		assert.fail("expected chat scroll helpers to exist");
	}
}

test("isChatScrolledToBottom treats near-bottom positions as pinned", async () => {
	const { isChatScrolledToBottom } = await loadChatScroll();

	assert.equal(
		isChatScrolledToBottom({
			scrollTop: 296,
			scrollHeight: 400,
			clientHeight: 100,
		}),
		true,
	);
});

test("isChatScrolledToBottom detects when the user has scrolled up", async () => {
	const { isChatScrolledToBottom } = await loadChatScroll();

	assert.equal(
		isChatScrolledToBottom({
			scrollTop: 120,
			scrollHeight: 400,
			clientHeight: 100,
		}),
		false,
	);
});
