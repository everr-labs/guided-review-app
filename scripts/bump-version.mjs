import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const versionPattern = /^\d+\.\d+\.\d+$/;
const bumpKinds = new Set(["patch", "minor", "major"]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const files = {
	packageJson: path.join(repoRoot, "package.json"),
	packageLockJson: path.join(repoRoot, "package-lock.json"),
	tauriConfigJson: path.join(repoRoot, "src-tauri", "tauri.conf.json"),
	cargoToml: path.join(repoRoot, "src-tauri", "Cargo.toml"),
	cargoLock: path.join(repoRoot, "src-tauri", "Cargo.lock"),
};

function parseVersion(version) {
	if (!versionPattern.test(version)) {
		throw new Error(`Invalid version: ${version}`);
	}
	return version.split(".").map(Number);
}

export function nextVersion(currentVersion, bump) {
	const [major, minor, patch] = parseVersion(currentVersion);

	if (versionPattern.test(bump)) {
		return bump;
	}

	if (!bumpKinds.has(bump)) {
		throw new Error(
			`Invalid version bump: ${bump}. Use patch, minor, major, or an exact version like 1.2.3.`,
		);
	}

	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function readJson(content, fileLabel) {
	try {
		return JSON.parse(content);
	} catch (error) {
		throw new Error(`Could not parse ${fileLabel}: ${error.message}`);
	}
}

function stringifyJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function updatePackageLock(content, version) {
	const parsed = readJson(content, "package-lock.json");
	parsed.version = version;
	if (parsed.packages?.[""]) {
		parsed.packages[""].version = version;
	}
	return stringifyJson(parsed);
}

function updateCargoPackageVersion(content, version, fileLabel) {
	const lines = content.split("\n");
	let inTargetPackage = false;
	let updated = false;

	const nextLines = lines.map((line) => {
		if (line === "[[package]]" || line === "[package]") {
			inTargetPackage = false;
			return line;
		}
		if (line === 'name = "guided-review-app"') {
			inTargetPackage = true;
			return line;
		}
		if (inTargetPackage && line.startsWith("version = ")) {
			updated = true;
			inTargetPackage = false;
			return `version = "${version}"`;
		}
		return line;
	});

	if (!updated) {
		throw new Error(`Could not find guided-review-app version in ${fileLabel}`);
	}

	return nextLines.join("\n");
}

export function updateVersionContents(contents, version) {
	const packageJson = readJson(contents.packageJson, "package.json");
	packageJson.version = version;

	const tauriConfigJson = readJson(
		contents.tauriConfigJson,
		"src-tauri/tauri.conf.json",
	);
	tauriConfigJson.version = version;

	return {
		packageJson: stringifyJson(packageJson),
		packageLockJson: updatePackageLock(contents.packageLockJson, version),
		tauriConfigJson: stringifyJson(tauriConfigJson),
		cargoToml: updateCargoPackageVersion(
			contents.cargoToml,
			version,
			"src-tauri/Cargo.toml",
		),
		cargoLock: updateCargoPackageVersion(
			contents.cargoLock,
			version,
			"src-tauri/Cargo.lock",
		),
	};
}

async function main() {
	const bump = process.argv[2];
	if (!bump) {
		throw new Error("Usage: npm run bump-version -- patch|minor|major|1.2.3");
	}

	const contents = Object.fromEntries(
		await Promise.all(
			Object.entries(files).map(async ([key, filePath]) => [
				key,
				await fs.readFile(filePath, "utf8"),
			]),
		),
	);
	const currentVersion = readJson(contents.packageJson, "package.json").version;
	const version = nextVersion(currentVersion, bump);
	const updated = updateVersionContents(contents, version);

	await Promise.all(
		Object.entries(files).map(([key, filePath]) =>
			fs.writeFile(filePath, updated[key], "utf8"),
		),
	);

	console.log(`Version bumped from ${currentVersion} to ${version}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
