import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	buildGhAuthStatusArgs,
	buildGhReleaseCreateArgs,
	buildGhReleaseViewArgs,
	buildReleaseCommandArgs,
	findReleaseAssets,
	mergeReleaseEnv,
	missingReleaseEnv,
	parseCliArgs,
	parseDotEnv,
	releaseMetadata,
	releaseBuildEnv,
} from "./local-release.mjs";

test("parseDotEnv reads comments, quoted values, and inline comments", () => {
	assert.deepEqual(
		parseDotEnv([
			"# release credentials",
			"APPLE_ID=dev@example.com",
			'APPLE_PASSWORD="app-specific password"',
			"APPLE_TEAM_ID='ABCDE12345'",
			"APPLE_CERTIFICATE=abc#not-a-comment",
			"APPLE_CERTIFICATE_PASSWORD=secret # local note",
			"",
		].join("\n")),
		{
			APPLE_ID: "dev@example.com",
			APPLE_PASSWORD: "app-specific password",
			APPLE_TEAM_ID: "ABCDE12345",
			APPLE_CERTIFICATE: "abc#not-a-comment",
			APPLE_CERTIFICATE_PASSWORD: "secret",
		},
	);
});

test("mergeReleaseEnv lets .env values fill missing process env values", () => {
	assert.equal(
		mergeReleaseEnv(
			{ APPLE_ID: "from-process", OTHER: "kept" },
			{ APPLE_ID: "from-file", APPLE_TEAM_ID: "from-file" },
		).APPLE_ID,
		"from-process",
	);
	assert.equal(
		mergeReleaseEnv(
			{ APPLE_ID: "from-process", OTHER: "kept" },
			{ APPLE_ID: "from-file", APPLE_TEAM_ID: "from-file" },
		).APPLE_TEAM_ID,
		"from-file",
	);
});

test("missingReleaseEnv reports required signing and notarization values", () => {
	assert.deepEqual(
		missingReleaseEnv({
			APPLE_CERTIFICATE: "cert",
			APPLE_CERTIFICATE_PASSWORD: "cert-password",
			APPLE_ID: "dev@example.com",
		}),
		["APPLE_PASSWORD", "APPLE_TEAM_ID"],
	);
});

test("missingReleaseEnv accepts a local keychain signing identity instead of a certificate", () => {
	assert.deepEqual(
		missingReleaseEnv({
			APPLE_SIGNING_IDENTITY: "Developer ID Application: Guido D'Orsi (6R3U885H6A)",
			APPLE_ID: "dev@example.com",
			APPLE_PASSWORD: "app-password",
			APPLE_TEAM_ID: "6R3U885H6A",
		}),
		[],
	);
});

test("releaseBuildEnv ignores certificate vars when using local keychain identity", () => {
	assert.deepEqual(
		releaseBuildEnv({
			APPLE_SIGNING_IDENTITY: "Developer ID Application: Guido D'Orsi (6R3U885H6A)",
			APPLE_CERTIFICATE: "stale-development-cert",
			APPLE_CERTIFICATE_PASSWORD: "stale-password",
			APPLE_ID: "dev@example.com",
		}),
		{
			APPLE_SIGNING_IDENTITY: "Developer ID Application: Guido D'Orsi (6R3U885H6A)",
			APPLE_ID: "dev@example.com",
		},
	);
});

test("parseCliArgs defaults to .env and accepts a custom env file", () => {
	assert.deepEqual(parseCliArgs([]), { envPath: ".env", extraArgs: [] });
	assert.deepEqual(parseCliArgs([".env.release"]), {
		envPath: ".env.release",
		extraArgs: [],
	});
	assert.deepEqual(parseCliArgs(["--bundles", "dmg"]), {
		envPath: ".env",
		extraArgs: ["--bundles", "dmg"],
	});
	assert.deepEqual(parseCliArgs([".env.release", "--bundles", "app"]), {
		envPath: ".env.release",
		extraArgs: ["--bundles", "app"],
	});
});

test("buildReleaseCommandArgs targets a universal macOS app", () => {
	assert.deepEqual(buildReleaseCommandArgs(["--bundles", "dmg"]), [
		"run",
		"tauri",
		"--",
		"build",
		"--target",
		"universal-apple-darwin",
		"--bundles",
		"dmg",
	]);
});

test("releaseMetadata derives the default tag from the Tauri version with optional .env overrides", () => {
	assert.deepEqual(releaseMetadata({}, "0.5.0"), {
		tag: "guided-review-v0.5.0",
		title: "Guided Review v0.5.0",
		notes:
			"Signed and notarized macOS build. Download the app from the assets below.",
		draft: false,
		prerelease: false,
		repo: undefined,
	});

	assert.deepEqual(
		releaseMetadata(
			{
				RELEASE_TAG: "custom-v0.5.0",
				RELEASE_NAME: "Custom 0.5.0",
				RELEASE_NOTES: "Custom notes",
				RELEASE_DRAFT: "true",
				RELEASE_PRERELEASE: "1",
				GH_REPO: "everr-labs/guided-review-app",
			},
			"0.5.0",
		),
		{
			tag: "custom-v0.5.0",
			title: "Custom 0.5.0",
			notes: "Custom notes",
			draft: true,
			prerelease: true,
			repo: "everr-labs/guided-review-app",
		},
	);
});

test("findReleaseAssets discovers downloadable macOS bundle files", async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "guided-release-"));
	try {
		await fs.mkdir(path.join(temp, "dmg"), { recursive: true });
		await fs.mkdir(path.join(temp, "macos"), { recursive: true });
		await fs.writeFile(path.join(temp, "dmg", "app_0.1.0_universal.dmg"), "");
		await fs.writeFile(path.join(temp, "dmg", "bundle_dmg.sh"), "");
		await fs.writeFile(path.join(temp, "macos", "app.app.tar.gz"), "");
		await fs.writeFile(path.join(temp, "macos", "app.app.tar.gz.sig"), "");

		assert.deepEqual(await findReleaseAssets(temp), [
			path.join(temp, "dmg", "app_0.1.0_universal.dmg"),
			path.join(temp, "macos", "app.app.tar.gz"),
			path.join(temp, "macos", "app.app.tar.gz.sig"),
		]);
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

test("gh release create publishes a new release entry with assets", () => {
	const metadata = {
		tag: "guided-review-v0.1.0",
		title: "Guided Review v0.1.0",
		notes: "Download below.",
		draft: true,
		prerelease: false,
		repo: "everr-labs/guided-review-app",
	};
	const assets = ["app.dmg", "app.app.tar.gz"];

	assert.deepEqual(buildGhReleaseCreateArgs(metadata, assets), [
		"release",
		"create",
		"guided-review-v0.1.0",
		"app.dmg",
		"app.app.tar.gz",
		"--title",
		"Guided Review v0.1.0",
		"--notes",
		"Download below.",
		"--draft",
		"--repo",
		"everr-labs/guided-review-app",
	]);
});

test("gh release view args probe whether a tag already exists", () => {
	assert.deepEqual(
		buildGhReleaseViewArgs({ tag: "guided-review-20260514-143055" }),
		["release", "view", "guided-review-20260514-143055"],
	);
	assert.deepEqual(
		buildGhReleaseViewArgs({
			tag: "guided-review-20260514-143055",
			repo: "everr-labs/guided-review-app",
		}),
		[
			"release",
			"view",
			"guided-review-20260514-143055",
			"--repo",
			"everr-labs/guided-review-app",
		],
	);
});

test("gh auth command checks local GitHub CLI setup before building", () => {
	assert.deepEqual(buildGhAuthStatusArgs(), ["auth", "status"]);
});
