# Diff Line Focus Design

## Summary

Add one shared "diff focus" system that can be used by both the user and the agent.

The user can click a line number, then Shift-click another line number, to select a line range and attach that range as a reference in the next chat message. The agent can emit a structured focus request to scroll the diff to a file and line range. Both paths use the same model, highlight style, and scrolling behavior.

The existing line selection UI should be removed first because it currently does not work well. The new behavior should not paste selected code into chat. It should send only a compact file and line reference.

## Goals

- Let the user select a diff line range with click, then Shift-click.
- Let the user attach the selected range to the next chat message as a reference only.
- Let the agent highlight and scroll to a line range in the diff.
- Use one shared state shape for user selection and agent focus.
- Show a strong visible selected state, similar to GitHub's yellow focused-line highlight.
- Show a small temporary label in the diff header when the agent focuses lines.
- Remove or replace the current broken line selection UI and helpers.

## Non-Goals

- Do not send selected code text to the agent.
- Do not add multi-file selection in this first version.
- Do not support selecting both old and new sides in one range.
- Do not create PR comments directly from selected ranges.
- Do not change the section-by-section review workflow.

## Current Code To Replace

The current line selection attempt is mostly in:

- `src/components/DiffView.tsx`
- `src/lib/quotedContext.ts`
- `src/lib/quotedContext.test.ts`
- reference chips in `src/components/ChatPanel.tsx`
- selection CSS in `src/index.css`

The implementation should remove the parts that extract selected source text and build code blocks for chat. Some concepts can be reused, such as file path, line number, side, and pending chat references, but the behavior should be rebuilt around the shared diff focus model.

## Shared Model

Use one model for both user selection and agent focus:

```ts
type DiffFocusSide = "LEFT" | "RIGHT";
type DiffFocusSource = "user" | "agent";
type DiffFocusMode = "draft-reference" | "navigation";

interface DiffFocusRange {
  id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  side: DiffFocusSide;
  source: DiffFocusSource;
  mode: DiffFocusMode;
  reason?: string;
  created_at: number;
}
```

`LEFT` means the old version. `RIGHT` means the new version.

The app should normalize `start_line` and `end_line` so reverse selections still work. The app should reject missing file paths, invalid line numbers, and unknown sides.

## User Selection Flow

1. The user clicks a line number in the diff.
2. The app creates a one-line `draft-reference` focus.
3. The user Shift-clicks another line number.
4. If the second line is in the same file and same side, the app expands the range.
5. If the second line is in a different file or side, the app starts a fresh one-line selection.
6. The selected range gets a strong visible highlight.
7. A compact toolbar appears near the selected range with `Add reference` and `Clear`.
8. `Add reference` adds a chat reference chip and clears the active selection.

The chat reference chip should show only a compact reference, for example:

```text
src/App.tsx:42-48 (new)
```

When the user sends the message, the text sent to the agent should include only references, for example:

```text
Referenced diff range: src/App.tsx:42-48 (new)

<user message>
```

No code text should be included.

## Agent Focus Flow

Add a new structured block to the agent protocol:

````markdown
```acp-diff-focus
{
  "file_path": "src/App.tsx",
  "start_line": 42,
  "end_line": 48,
  "side": "RIGHT",
  "reason": "This is the state update the user asked about."
}
```
````

When the app receives this block:

1. Parse and validate the payload.
2. Create a `navigation` focus with source `agent`.
3. If the matching file is visible, scroll the range into view.
4. If the file is in another loaded section, switch to that section if the app can identify it safely.
5. If the app cannot find the file in a visible or known section, show a small non-blocking error in the diff area.
6. Highlight the range.
7. Show a temporary header label such as `Focused src/App.tsx:42-48 (new)`.

The focus block should be hidden from normal chat text, like the existing section and comment draft blocks.

## Visual Behavior

Selected and focused ranges should be easy to see.

- Use a warm yellow or amber overlay across the selected rows.
- Keep added and removed line colors readable underneath the yellow overlay.
- Give the active anchor line number a stronger visible state, such as a yellow fill or outline.
- Use the same highlight style for user selection and agent focus.
- Use the temporary header label to make agent focus feel different from user selection.
- Clear the temporary agent label when the user changes section, creates a new selection, or after a short timeout.

The row highlight is the important state. The toolbar should help with actions, but the range itself must be visibly selected.

## Data Flow

Diff focus state should live in shared app state, not only inside one diff file component. That lets chat references and agent focus use the same source of truth.

Expected state actions:

- `setDiffFocus(range)`
- `clearDiffFocus(id?)`
- `addPendingDiffReference(range)`
- `removePendingDiffReference(id)`
- `clearPendingDiffReferences()`

The diff pane reads the active focus and applies highlight/scroll behavior. The chat panel reads pending references and renders chips.

## Error Handling

- Invalid focus blocks should create a readable app error and not crash.
- Unknown files should show a small diff-area message.
- Missing line numbers should be rejected.
- A range outside the currently rendered diff should still preserve the focus state, but the UI should explain that the line is not visible in the current diff.
- Shift-click across different files or sides should start a new selection, not create a confusing mixed range.

## Testing

Add focused tests for the data and parsing logic:

- Normalizes line ranges.
- Formats reference-only chat text.
- Rejects invalid agent focus payloads.
- Parses `acp-diff-focus` fences and hides them from visible chat text.
- Keeps user references code-free.

Add component or browser-level checks for the UI behavior:

- Click then Shift-click selects a range.
- Selecting a range shows the yellow selected state.
- `Add reference` creates a chip with only file and line details.
- Agent focus scrolls to and highlights the requested range.
- Agent focus shows the temporary header label.

## Acceptance Criteria

- The old broken line-selection behavior is gone.
- User range selection works with click and Shift-click.
- Selected lines have a clear yellow/amber visible state.
- Chat references include only file, side, and line range.
- No selected source code is pasted into chat.
- The agent can request focus with `acp-diff-focus`.
- Agent focus scrolls to the requested range when possible.
- Agent focus shows a temporary label in the diff header.
- Invalid focus requests fail gracefully.
