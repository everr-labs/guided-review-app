# Progressive Section Loading Design

## Problem

Section loading feels slow because the main review UI waits for a complete section payload before it can show useful section details. Today the agent sends one final `acp-section` block per section. That keeps parsing simple, but it means files, ranges, and feedback all appear at the same time, only after the agent has finished the full section review.

## Goal

Let the current section update in the main review UI while the agent is still working. The user should see files and ranges as soon as they are known, then see concerns and test notes appear later. The existing final `acp-section` block should still work for older agents and should still be accepted as the completed section payload.

## Recommended Approach

Add an app-owned ACP/MCP tool for progressive section updates. The agent can call this tool multiple times during one section turn. Each tool call contains a complete JSON payload for one update, and the frontend merges it into the current section.

Name the tool `guided_review_update_section`.

Example update:

```json
{
  "section_id": "validation-flow",
  "phase": "ranges",
  "title": "Validation flow",
  "intent": "Checks that happen before data is saved.",
  "files": ["src/lib/store.ts"],
  "ranges": [
    {
      "file_path": "src/lib/store.ts",
      "start_line": 120,
      "end_line": 180,
      "kind": "changed-new"
    }
  ]
}
```

Later updates can add feedback:

```json
{
  "section_id": "validation-flow",
  "phase": "feedback",
  "concerns": [
    {
      "text": "Empty input can still be submitted.",
      "severity": "medium",
      "file_path": "src/lib/store.ts",
      "line": 148
    }
  ],
  "uncovered_scenarios": [],
  "test_coverage_notes": "Happy path is covered; empty input is not."
}
```

## Data Model

Keep the current `ReviewSection` shape for completed sections. Add a partial section update shape for progressive updates.

The partial update should include:

- `section_id`, required
- `phase`, required, with values `started`, `ranges`, or `feedback`
- optional `title` and `intent`
- optional `files`
- optional `ranges`
- optional `unimportant_ranges`
- optional `concerns`
- optional `uncovered_scenarios`
- optional `test_coverage_notes`
- optional `base_ref` and `head_ref`

Ranges still exist and remain important. The change is that ranges can arrive before the whole section is complete, so the diff pane can start loading relevant files earlier.

## UI Behavior

When the first partial update for a section arrives, the store should create or update that section row and mark it as processing. The diff pane should render the best available partial section:

- If files and ranges are known, load and show the listed files.
- If feedback is not known yet, show the diff without feedback annotations.
- When concerns or test notes arrive, add them to the existing section UI.
- When the final `acp-section` block arrives, replace the partial section with the complete section and clear the processing state.

If an agent never calls the progressive tool, the app should keep today’s behavior and wait for the final `acp-section` block.

## ACP Host Changes

The ACP client currently observes tool calls from the agent and forwards them to the frontend. To make progressive updates reliable, the host should expose an app-owned MCP tool through ACP. The tool handler should validate the JSON payload and emit a new frontend event named `acp://section-progress`.

The frontend should still keep the existing tool-call parser path as a compatibility layer for agents that emit section-shaped tool inputs through another channel.

## Agent Instructions

Update `agent-skill.md` so section review turns ask the agent to:

1. Call `guided_review_update_section` when it starts a section.
2. Call it again as soon as it knows files and ranges.
3. Call it again when it has concerns, uncovered scenarios, or test notes.
4. Emit the final `acp-section` block at the end of the section turn.

The agent should not paste diffs or file contents into chat. It should continue using line ranges.

## Testing

Add tests at three levels:

- Rust validation/event tests for accepting progressive section update payloads.
- Store tests for merging partial updates without losing existing section data.
- React behavior tests around the diff pane loading when files/ranges arrive before feedback.

Keep existing `acp-section` tests passing to prove fallback behavior still works.

## Rollout

This is backward-compatible. Existing agents can keep sending only final `acp-section` blocks. Newer agents can progressively update the main UI through tool calls.
