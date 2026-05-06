# Contributing to Guided Review

Thanks for taking the time to help. Guided Review is a Tauri 2 desktop app that
walks through a GitHub pull request one section at a time, driven by an
ACP-compatible review agent. This guide explains how to set up the project, the
conventions we follow, and how to send a change.

## Prerequisites

- Node.js and npm
- Rust and Cargo (stable toolchain)
- Git, plus `gh` for PR metadata
- macOS, Windows, or Linux with the system dependencies Tauri requires for your
  platform — see <https://tauri.app/start/prerequisites/>
- An account for whichever ACP review agent you intend to test against (Claude
  Code or Codex)

## Setup

```sh
git clone https://github.com/<your-fork>/guided-review-app.git
cd guided-review-app
npm install
```

The first `npm run tauri -- dev` will also compile the Rust crate, which can
take a few minutes.

## Running the app

```sh
npm run tauri -- dev     # full desktop app — preferred for UI work
npm run dev              # Vite frontend only (Tauri APIs are unavailable)
```

## Project layout

A short tour. `AGENTS.md` and `CLAUDE.md` go deeper.

```
src/                React UI (App.tsx wires acp://* events into the Zustand store)
src-tauri/src/      Rust host (Tauri commands, ACP client, fenced-block parser, repo)
agent-skill.md      Injected into the agent's first prompt
scripts/            bump-version.mjs, local-release.mjs (+ tests)
docs/               Additional design notes
```

Path alias: `@/` resolves to `src/`.

## Coding conventions

- **TypeScript**: tab indentation (existing files enforce it), strict mode on,
  no default exports for components, use the `@/` import alias.
- **Rust**: `anyhow::Result` at boundaries, `tracing::instrument` on async
  commands, surface errors to the UI as `String` via
  `.map_err(|e| e.to_string())`.
- **Wire types**: snake_case on the wire (Rust serde + TS interfaces). Use
  `tag = "kind"` for enums (see `SessionSource`, `RecentProject`).
- Don't paste diff or file contents into agent replies — the host renders them.
  Reference files via `LineRange { file_path, start_line, end_line, kind }`.
- Default to writing no comments. Add one only when the *why* would surprise a
  reader.

## Things to read before changing

The agent contract and the streaming pipeline have a few non-obvious rules.
Skim the "Non-obvious behavior" section of `AGENTS.md` before touching:

- `fenced.rs` (lenient `serde_json` → `json5` parsing)
- `acp_client.rs::shared_boundary_len` and `store.ts::appendStreamingText`
  (paired in two languages on purpose — keep them in sync)
- `store.ts::stripStructuredReviewBlocks`
- `App.tsx::handleToolCall` (alternative section channel via tool calls)
- `acp_client.rs::scrub_nested_agent_env` (env hygiene for nested agents)

## Tests and checks

Run these before opening a PR:

```sh
npm run check            # tsc --noEmit
npm test                 # tsx + node --test (frontend + script unit tests)
cd src-tauri && cargo test
```

For UI work, exercise the change in `npm run tauri -- dev` against a real PR.
Type checking and tests catch a lot, but they don't verify the agent loop
end-to-end.

## Commits and pull requests

- One logical change per PR. If two changes are unrelated, send two PRs.
- Keep the title under ~70 characters. Use the body for the *why*.
- Reference issues with `#123` when relevant.
- If you change wire types, structured-block tags, or the agent prompt
  contract, call it out in the PR description — those touch both sides of the
  ACP boundary.
- Don't bump the app version in feature PRs. Version bumps are handled
  separately via `npm run bump-version`.

## Releases

Releases are cut by maintainers. The flow lives in
`scripts/local-release.mjs` and `.github/workflows/release.yml`. Contributors
generally don't need to run either.

## Reporting bugs

Open an issue with:

- What you did
- What you expected
- What happened instead
- The agent you were using (Claude Code, Codex, …) and its version
- Any relevant log output (set `GUIDED_REVIEW_CAPTURE_ASSISTANT_TEXT=1` to
  capture agent chunk text in release builds)

## Questions

If something in this document is unclear, open an issue — the gap in the docs
is the bug.
