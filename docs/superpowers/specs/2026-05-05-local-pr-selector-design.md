# Local PR Selector Design

## Status

Approved for planning.

## Context

The current project selector supports several ways to start a review:

- a remote PR URL
- a remote branch
- a local folder with either a PR URL or branch

The new selector should be simpler. Reviews should always run against a local repository folder. The user can enter a PR number or paste a PR URL, but the selected local folder decides which repository is used.

## Goals

- Make the selector local-only.
- Support PR reviews only.
- Let the user fill the PR input and local repo in either order.
- Accept either a PR number, such as `123`, or a GitHub PR URL, such as `https://github.com/owner/repo/pull/123`.
- Treat a pasted PR URL as a shortcut for the PR number.
- Use the selected local repo's `origin` remote as the source of truth for the repository.
- Block the review if a pasted PR URL points at a different repository than the selected folder's `origin`.
- Store only local repo folders in recent projects.

## Non-Goals

- No remote-only review flow.
- No branch review flow.
- No automatic repo matching from the pasted PR URL.
- No checking remotes other than `origin`.
- No support for non-GitHub PR URLs in this selector.

## User Interface

The selector becomes one compact panel with two main inputs:

1. PR input
   - Accepts a plain number or a GitHub PR URL.
   - Shows a clear validation message when the input cannot be parsed.

2. Local repo input
   - Shows the selected local folder.
   - Has a folder picker button.
   - Allows choosing a repo from the recent local repos list.

The old mode tabs are removed. There is no "remote branch", "PR URL", or "local branch" mode.

The Start Review button is enabled only when:

- the PR input contains a valid PR number or PR URL
- a local repo folder is selected
- the selected folder has a usable GitHub `origin`
- a pasted PR URL, if present, matches the selected repo's `origin`

If the app is still checking the selected folder's `origin`, Start Review stays disabled until that check finishes.

## Validation

The PR input parser returns:

- the PR number
- optional `owner/repo` details when the user pasted a full URL

Examples:

- `123` becomes PR number `123`
- `https://github.com/openai/codex/pull/123` becomes PR number `123` and repo `openai/codex`
- invalid text produces a friendly error

When the selected folder changes, the app inspects its `origin` remote and normalizes it to `owner/repo`.

If the PR input includes `owner/repo`, the app compares that value with the selected folder's normalized `origin`.

If they do not match, the app blocks Start Review and shows a message like:

`This PR URL is for owner/repo, but the selected folder uses other-owner/other-repo as origin.`

If the user typed only a number, there is no repo mismatch check.

## Start Flow

When the user starts a review, the frontend sends a local PR source to the backend:

- local path: the selected folder
- PR number: the parsed number
- repo URL: derived from the selected folder's `origin`

The backend then:

1. Fetches the PR ref into the selected local repo.
2. Resolves the base ref from the local repo's default branch.
3. Starts the review agent in the selected local folder.
4. Records the local folder in recent projects.

The pasted PR URL is never used as the repository source. It is only a convenient way to copy and paste the PR number.

## Code Shape

Frontend changes:

- Replace the tabbed `ProjectPicker` UI with the two-input local PR selector.
- Replace old project source helpers with helpers for parsing PR input and building local PR sources.
- Treat recent projects as local repos in the selector.
- Hide any old PR or branch recent entries that may still exist in saved data.
- Keep the agent selector if it is still needed for starting sessions.

Backend changes:

- Add a command that inspects a local folder's `origin` remote and returns normalized GitHub repo details.
- Use the selected local repo's `origin` URL when preparing a local PR review.
- Keep remote session source variants internally only if removing them would add unrelated churn.
- Record only local repo entries for the selector.

## Error Handling

The selector should give plain messages for common problems:

- missing PR input
- invalid PR input
- missing local repo
- selected folder is not a Git repo
- selected repo has no `origin`
- selected repo's `origin` is not a GitHub repo
- pasted PR URL does not match selected repo's `origin`
- fetching the PR ref fails

## Testing

Focused tests should cover:

- PR input parsing for numbers, valid URLs, and invalid values.
- Building a local PR source from parsed input and selected repo metadata.
- Repo mismatch validation.
- Origin URL parsing for common HTTPS and SSH GitHub remote formats.
- Recent project filtering so the selector shows local repos only.

Manual verification should cover:

- entering PR number first, then choosing repo
- choosing repo first, then entering PR number
- pasting a matching PR URL
- pasting a mismatched PR URL and confirming Start Review is blocked
- choosing a recent local repo
