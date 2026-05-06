# Guided Review

Guided Review is a desktop app for walking through GitHub pull requests one section at a time. It shows the diff in the app, starts an ACP-compatible review agent in your local repository, and keeps the conversation focused on the current part of the change.

The app is built with Tauri 2, React, Vite, TypeScript, and Rust.

## What It Does

- Opens a local Git repository.
- Accepts a GitHub PR number or PR URL.
- Fetches the PR into the selected local repository.
- Shows review sections, diff context, chat, and comment drafts in one place.
- Lets the agent suggest PR comments, then waits for your approval before anything is posted.

## Requirements

- macOS, Windows, or Linux for development.
- Node.js and npm.
- Rust and Cargo.
- Git.
- The system dependencies required by Tauri for your OS.
- Authentication for whichever ACP review agent you choose in the app.

For macOS releases, you also need an Apple Developer account because the release workflow signs and notarizes the app.

## Install

```sh
npm install
```

## Run The App

Start the Tauri desktop app:

```sh
npm run tauri -- dev
```

Run only the Vite frontend:

```sh
npm run dev
```

## Use The App

1. Choose a local repository folder from the project picker.
2. Enter a PR number, such as `123`, or paste a GitHub PR URL.
3. Pick the review agent if more than one is available.
4. Press Start.
5. Review each generated section in order.
6. Approve comment drafts only when you want them posted to GitHub.

The selected folder's `origin` remote is used as the repository source. If you paste a PR URL for a different repository, the app blocks the review so you do not review the wrong project by mistake.

## Development Commands

```sh
npm run check
npm test
npm run build
npm run tauri -- build
npm run bump-version -- patch
npm run release:local
```

`npm run check` runs TypeScript checks. `npm test` runs the unit tests. `npm run build` builds the frontend. `npm run tauri -- build` builds the desktop app. `npm run bump-version -- patch` bumps the app version across npm, Tauri, and Cargo metadata. You can also pass `minor`, `major`, or an exact version like `1.2.3`. `npm run release:local` loads Apple release values from `.env`, builds a signed universal macOS app, and publishes the generated assets with the GitHub CLI.

For a local release build, copy `.env.example` to `.env`, fill in the Apple values, then run:

```sh
npm run release:local
```

For local builds, prefer the Developer ID Application certificate already installed in Keychain. Find the exact signing identity with:

```sh
security find-identity -v -p codesigning
```

Then set `APPLE_SIGNING_IDENTITY` in `.env`, for example:

```sh
APPLE_SIGNING_IDENTITY=Developer ID Application: Your Name (TEAMID)
```

The local release command uses these GitHub defaults:

- tag: `guided-review-v<package.json version>`
- title: `Guided Review v<package.json version>`
- notes: `Signed and notarized macOS build. Download the app from the assets below.`

Set `GH_REPO=owner/repo` in `.env` if the local Git remote is not the release target. Set `RELEASE_DRAFT=true` or `RELEASE_PRERELEASE=true` if needed. If the release already exists, the script uploads the new assets with `--clobber`.

## Release Workflow

The release workflow is in `.github/workflows/release.yml`. It is manually triggered from GitHub Actions.

It does three main things:

1. Builds a universal macOS app for Apple Silicon and Intel Macs.
2. Signs and notarizes the app with Apple credentials stored as GitHub secrets.
3. Creates or updates a GitHub Release and uploads the downloadable app bundle.
