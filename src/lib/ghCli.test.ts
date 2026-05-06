import assert from "node:assert/strict";
import test from "node:test";
import { ghCliNeedsInstallPopup, ghCliPopupMessage } from "./ghCli";
import type { GhCliStatus } from "./acp";

test("ghCliNeedsInstallPopup opens only for missing gh", () => {
	assert.equal(
		ghCliNeedsInstallPopup({ installed: false, error: "not found" }),
		true,
	);
	assert.equal(
		ghCliNeedsInstallPopup({
			installed: true,
			version: "gh version 2.65.0",
		}),
		false,
	);
});

test("ghCliPopupMessage explains what stops working", () => {
	const status: GhCliStatus = {
		installed: false,
		error: "GitHub CLI (`gh`) is not installed.",
	};

	assert.match(ghCliPopupMessage(status), /GitHub CLI/);
	assert.match(ghCliPopupMessage(status), /PR details/);
	assert.match(ghCliPopupMessage(status), /review comments/);
});
