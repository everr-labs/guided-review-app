import assert from "node:assert/strict";
import test from "node:test";
import {
	nextVersion,
	updateVersionContents,
} from "./bump-version.mjs";

test("nextVersion bumps semver levels and accepts an exact version", () => {
	assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
	assert.equal(nextVersion("0.1.0", "minor"), "0.2.0");
	assert.equal(nextVersion("0.1.0", "major"), "1.0.0");
	assert.equal(nextVersion("0.1.0", "1.2.3"), "1.2.3");
});

test("nextVersion rejects invalid current versions and bump arguments", () => {
	assert.throws(() => nextVersion("1.2", "patch"), /Invalid version/);
	assert.throws(() => nextVersion("1.2.3", "banana"), /Invalid version bump/);
	assert.throws(() => nextVersion("1.2.3", "1.2"), /Invalid version bump/);
});

test("updateVersionContents updates npm, Tauri, and Cargo version files", () => {
	const contents = updateVersionContents(
		{
			packageJson: JSON.stringify(
				{ name: "guided-review-app", version: "0.1.0" },
				null,
				2,
			) + "\n",
			packageLockJson: JSON.stringify(
				{
					name: "guided-review-app",
					version: "0.1.0",
					packages: {
						"": {
							name: "guided-review-app",
							version: "0.1.0",
						},
					},
				},
				null,
				2,
			) + "\n",
			tauriConfigJson: JSON.stringify(
				{ productName: "guided-review-app", version: "0.1.0" },
				null,
				2,
			) + "\n",
			cargoToml: [
				"[package]",
				'name = "guided-review-app"',
				'version = "0.1.0"',
				"",
				"[dependencies]",
				'serde = "1"',
				"",
			].join("\n"),
			cargoLock: [
				"version = 4",
				"",
				"[[package]]",
				'name = "guided-review-app"',
				'version = "0.1.0"',
				"",
				"[[package]]",
				'name = "serde"',
				'version = "1.0.0"',
				"",
			].join("\n"),
		},
		"0.2.0",
	);

	assert.match(contents.packageJson, /"version": "0.2.0"/);
	assert.match(contents.packageLockJson, /"version": "0.2.0"/);
	assert.match(contents.tauriConfigJson, /"version": "0.2.0"/);
	assert.match(contents.cargoToml, /version = "0.2.0"/);
	assert.match(contents.cargoLock, /name = "guided-review-app"\nversion = "0.2.0"/);
	assert.match(contents.cargoLock, /name = "serde"\nversion = "1.0.0"/);
});
